'use strict';

// ════════════════════════════════════════════════ Gestione PC
//
// I PC delle commesse da far preparare internamente: per ognuno le commesse (anche
// più di una, «26xxx + 26yyy»: un PC per due commesse), il cliente, il software da
// installare, lo stato della preparazione, l'hardware, le note e il mese di consegna.
//
// Il codice è pubblico: qui non c'è nessun dato. L'elenco sta solo nel file
// «App gestione R&D/pc_commesse.json» sul OneDrive di chi si collega, e i PC che
// c'erano nel foglio Excel si portano dentro con «Importa da Excel» (copia e incolla
// delle righe). Si sincronizza come i laser: si unisce PC per PC, vince il
// «modificato» più recente, e un'eliminazione vince sulle versioni più vecchie.
//
// { versione: 1,
//   pc: [ { id, commesse, cliente, software: [..], stato, hardware, note,
//           consegna: "AAAA-MM", stornata, creato, modificato } ],
//   eliminati: [ { id, quando } ] }

const PC_CONFIG = {
  percorso: 'App gestione R&D/pc_commesse.json'
};

const pcCommesse = (() => {
  const CHIAVE = 'rd.pc.v1';
  const CHIAVE_FILTRO = 'rd.pc.nascondiFatti';
  const TIENI_ELIMINATI_GIORNI = 180;

  // Gli stati della preparazione, nell'ordine in cui di solito si passa. Il file ne
  // può avere altri: si mostrano e si possono scegliere lo stesso.
  const STATI = ['Da ordinare', 'Attesa materiale', 'Pronto Tiesse', 'Pronto OS', 'Installato'];
  const SOFTWARE = ['TS-Vision', 'Supervisore', 'SW 4.0', 'Laser', 'TS-Simulator'];
  const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
    'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

  const $ = id => document.getElementById(id);
  const el = (tag, classe, testo) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (testo != null) e.textContent = testo;
    return e;
  };
  const testo = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
  const chiaro = t => testo(t).toLocaleLowerCase('it');
  const nuovoId = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  // ─────────────── i dati

  function normalizza(r) {
    if (!r || typeof r !== 'object') return null;
    const adesso = new Date().toISOString();
    const software = (Array.isArray(r.software) ? r.software : testo(r.software).split(/[,;\n]/))
      .map(testo).filter(Boolean);
    return {
      ...r,
      id: testo(r.id) || nuovoId(),
      commesse: testo(r.commesse),
      cliente: testo(r.cliente),
      software: [...new Set(software)],
      stato: testo(r.stato),
      hardware: testo(r.hardware),
      note: testo(r.note),
      consegna: /^\d{4}-\d{2}$/.test(testo(r.consegna)) ? testo(r.consegna) : '',
      stornata: r.stornata === true,
      creato: testo(r.creato) || adesso,
      modificato: testo(r.modificato) || adesso
    };
  }

  function leggiContenuto(d) {
    if (!d || !Array.isArray(d.pc)) throw new Error('non è un file dei PC');
    return {
      versione: 1,
      pc: d.pc.map(normalizza).filter(Boolean),
      eliminati: (Array.isArray(d.eliminati) ? d.eliminati : [])
        .filter(t => t && typeof t.id === 'string' && typeof t.quando === 'string')
        .map(t => ({ id: t.id, quando: t.quando }))
    };
  }

  const vuoti = () => ({ versione: 1, pc: [], eliminati: [] });

  function carica() {
    let t = null;
    try {
      t = localStorage.getItem(CHIAVE);
      return t ? leggiContenuto(JSON.parse(t)) : vuoti();
    } catch (e) {
      if (t) { try { localStorage.setItem(CHIAVE + '.illeggibile', t); } catch (_) {} }
      return vuoti();
    }
  }

  let dati = carica();

  function salvaLocale() {
    try { localStorage.setItem(CHIAVE, JSON.stringify(dati)); return true; } catch (e) {
      mostraMessaggio('Salvataggio non riuscito: ' + e.message);
      return false;
    }
  }

  function salva() {
    if (salvaLocale()) onedrive.modificato();
  }

  function unisci(a, b) {
    const pc = new Map();
    for (const p of [...a.pc, ...b.pc]) {
      const c = pc.get(p.id);
      if (!c || p.modificato > c.modificato) pc.set(p.id, p);
    }
    const eliminati = new Map();
    for (const t of [...a.eliminati, ...b.eliminati]) {
      const c = eliminati.get(t.id);
      if (!c || t.quando > c.quando) eliminati.set(t.id, t);
    }
    const limite = new Date(Date.now() - TIENI_ELIMINATI_GIORNI * 864e5).toISOString();
    for (const [id, t] of eliminati) {
      const p = pc.get(id);
      if (p && p.modificato > t.quando) eliminati.delete(id);
      else { pc.delete(id); if (t.quando < limite) eliminati.delete(id); }
    }
    const perId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    return { versione: 1, pc: [...pc.values()].sort(perId), eliminati: [...eliminati.values()].sort(perId) };
  }

  const uguali = (x, y) => JSON.stringify(unisci(x, vuoti())) === JSON.stringify(unisci(y, vuoti()));

  async function sincronizza({ leggiFile, scriviFile }) {
    for (let tentativo = 0; tentativo < 4; tentativo++) {
      const f = await leggiFile(PC_CONFIG.percorso);
      let remoto = null;
      if (f) {
        try { remoto = leggiContenuto(JSON.parse(f.testo)); } catch (e) {
          throw new Error(`pc_commesse.json non leggibile: ${e.message}`);
        }
      }
      const unito = unisci(dati, remoto || vuoti());
      if (!uguali(unito, dati)) { dati = unito; salvaLocale(); disegna(); }
      if (!remoto || !uguali(unito, remoto)) {
        // Un file nuovo si crea solo se c'è qualcosa da metterci.
        if (!remoto && unito.pc.length === 0 && unito.eliminati.length === 0) return;
        if (!await scriviFile(PC_CONFIG.percorso, JSON.stringify(unito, null, 2), f && f.eTag)) continue;
      }
      return;
    }
    throw new Error('il file dei PC su OneDrive continua a cambiare, riprova tra poco');
  }

  // ─────────────── mesi e stati

  function nomeMese(m) {
    if (!m) return 'Senza data di consegna';
    const [y, mm] = m.split('-').map(Number);
    const n = MESI[mm - 1] || '?';
    return `${n.charAt(0).toUpperCase() + n.slice(1)} ${y}`;
  }

  /** «luglio 2026», «07/2026», «2026-07», «lug 26»… → «2026-07», o '' se non si capisce. */
  function leggiMese(t) {
    const s = chiaro(t);
    if (!s) return '';
    let m = /^(\d{4})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
    m = /^(?:\d{1,2}[/.-])?(\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (m) return `${m[2].length === 2 ? '20' + m[2] : m[2]}-${m[1].padStart(2, '0')}`;
    m = /([a-zà]+)\.?\s*'?(\d{2,4})/.exec(s);
    if (m) {
      const i = MESI.findIndex(x => x.startsWith(m[1].slice(0, 3)));
      if (i >= 0) return `${m[2].length === 2 ? '20' + m[2] : m[2]}-${String(i + 1).padStart(2, '0')}`;
    }
    return '';
  }

  function classeStato(stato) {
    const s = chiaro(stato);
    if (s.startsWith('installat')) return 'fatto';
    if (s.startsWith('pronto')) return 'pronto';
    if (s.startsWith('da ordinare') || s.startsWith('attesa')) return 'aperto';
    return '';
  }
  const fatto = p => p.stornata || classeStato(p.stato) === 'fatto';

  const usati = campo => [...new Set(dati.pc.map(p => p[campo]).flat().map(testo).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'it'));

  // ─────────────── la lista

  const confronto = new Intl.Collator('it', { numeric: true, sensitivity: 'base' });
  let nascondiFatti = (() => { try { return localStorage.getItem(CHIAVE_FILTRO) === '1'; } catch (_) { return false; } })();

  function corrisponde(p, q) {
    if (!q) return true;
    return [p.commesse, p.cliente, p.stato, p.hardware, p.note, ...p.software]
      .some(v => chiaro(v).includes(q));
  }

  function disegna() {
    if (!$('vista-pc')) return;
    const q = chiaro($('pc-cerca').value);
    const tutti = dati.pc;
    const visibili = tutti.filter(p => corrisponde(p, q) && !(nascondiFatti && fatto(p)))
      .sort((a, b) => (a.consegna || '9999') .localeCompare(b.consegna || '9999') ||
        confronto.compare(a.commesse, b.commesse));

    // I conti in alto: quanti, e quanti ancora da fare per stato.
    const conti = $('pc-conti');
    conti.replaceChildren();
    const b = t => el('b', null, String(t));
    const aperti = tutti.filter(p => !fatto(p));
    conti.append(b(tutti.length), tutti.length === 1 ? ' PC' : ' PC');
    const perStato = new Map();
    for (const p of aperti) perStato.set(p.stato || 'senza stato', (perStato.get(p.stato || 'senza stato') || 0) + 1);
    for (const [s, n] of [...perStato.entries()].sort((x, y) => STATI.indexOf(x[0]) - STATI.indexOf(y[0]))) {
      conti.append(' · ', b(n), ' ' + chiaro(s));
    }

    $('pc-nascondi').checked = nascondiFatti;
    const lista = $('pc-lista');
    lista.replaceChildren();
    const vuoto = $('pc-vuoto');
    vuoto.hidden = visibili.length > 0;
    vuoto.replaceChildren();
    if (!visibili.length) {
      vuoto.append(el('b', null, tutti.length ? 'Nessun risultato' : 'Nessun PC registrato'),
        tutti.length ? 'Niente corrisponde alla ricerca o al filtro.'
          : 'Aggiungi il primo con il pulsante +, oppure importa le righe dal foglio Excel.');
    }

    let mese = null, gruppo = null;
    for (const p of visibili) {
      if (p.consegna !== mese || !gruppo) {
        mese = p.consegna;
        const sezione = el('section', 'pc-mese');
        const quanti = visibili.filter(x => x.consegna === mese).length;
        const h = el('h2');
        h.append(nomeMese(mese), el('span', null, ` · ${quanti} PC`));
        sezione.append(h);
        gruppo = el('div', 'pc-gruppo');
        sezione.append(gruppo);
        lista.append(sezione);
      }
      gruppo.append(riga(p));
    }
  }

  function riga(p) {
    const r = el('div', 'pc-riga' + (p.stornata ? ' stornata' : ''));
    r.tabIndex = 0;
    r.setAttribute('role', 'button');

    const commesse = el('div', 'pc-commesse mono', p.commesse || 'senza numero');
    const cliente = el('div', 'pc-cliente', p.cliente || '—');
    const software = el('div', 'pc-software');
    for (const s of p.software) software.append(el('span', 'chip', s));

    // Lo stato si cambia direttamente dalla lista: è la cosa che si cambia più spesso.
    const stato = el('select', 'pc-stato ' + classeStato(p.stato));
    stato.setAttribute('aria-label', `Stato del PC ${p.commesse}`);
    for (const s of [...new Set([...STATI, ...usati('stato'), p.stato].filter(Boolean))]) {
      const o = el('option', null, s);
      o.value = s;
      if (s === p.stato) o.selected = true;
      stato.append(o);
    }
    if (!p.stato) { const o = el('option', null, '—'); o.value = ''; o.selected = true; stato.prepend(o); }
    stato.addEventListener('click', e => e.stopPropagation());
    stato.addEventListener('change', () => {
      p.stato = stato.value;
      p.modificato = new Date().toISOString();
      salva();
      disegna();
    });

    const hardware = el('div', 'pc-hardware', p.hardware);
    const note = el('div', 'pc-note', p.stornata && !/stornat/i.test(p.note) ? ['stornata', p.note].filter(Boolean).join(' · ') : p.note);
    r.append(commesse, cliente, software, stato, hardware, note);
    r.addEventListener('click', () => apri(p.id));
    r.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === r) apri(p.id); });
    return r;
  }

  // ─────────────── la scheda di un PC

  let aperto = null;
  let softwareScelto = [];

  function disegnaSoftware() {
    const box = $('pcf-software');
    box.replaceChildren();
    for (const s of [...new Set([...SOFTWARE, ...usati('software'), ...softwareScelto])]) {
      const b = el('button', 'chip' + (softwareScelto.includes(s) ? ' acceso' : ''), s);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(softwareScelto.includes(s)));
      b.addEventListener('click', () => {
        softwareScelto = softwareScelto.includes(s) ? softwareScelto.filter(x => x !== s) : [...softwareScelto, s];
        disegnaSoftware();
      });
      box.append(b);
    }
  }

  function apri(id) {
    const p = id ? dati.pc.find(x => x.id === id) : null;
    aperto = p ? p.id : null;
    $('pcf-titolo').textContent = p ? 'Modifica PC' : 'Nuovo PC';
    $('pcf-commesse').value = p ? p.commesse : '';
    $('pcf-cliente').value = p ? p.cliente : '';
    $('pcf-hardware').value = p ? p.hardware : '';
    $('pcf-consegna').value = p ? p.consegna : '';
    $('pcf-note').value = p ? p.note : '';
    $('pcf-stornata').checked = p ? p.stornata : false;
    softwareScelto = p ? [...p.software] : [];
    disegnaSoftware();
    $('pcf-altro').value = '';

    const stato = $('pcf-stato');
    stato.replaceChildren();
    for (const s of [...new Set([...STATI, ...usati('stato'), p && p.stato].filter(Boolean))]) {
      const o = el('option', null, s);
      o.value = s;
      stato.append(o);
    }
    stato.value = p && p.stato ? p.stato : STATI[0];

    const dl = $('pcf-hardware-usati');
    dl.replaceChildren(...usati('hardware').map(h => { const o = el('option'); o.value = h; return o; }));
    const dc = $('pcf-clienti-usati');
    dc.replaceChildren(...usati('cliente').map(h => { const o = el('option'); o.value = h; return o; }));

    $('pcf-elimina').hidden = !p;
    $('pcf-errore').textContent = '';
    $('scheda-pc').showModal();
    if (!p) $('pcf-commesse').focus();
  }

  function chiudi() { $('scheda-pc').close(); aperto = null; }

  function aggiungiAltro() {
    const t = testo($('pcf-altro').value);
    if (t && !softwareScelto.includes(t)) softwareScelto.push(t);
    $('pcf-altro').value = '';
    disegnaSoftware();
  }

  function salvaScheda(e) {
    e.preventDefault();
    if (testo($('pcf-altro').value)) aggiungiAltro();
    const valori = {
      commesse: testo($('pcf-commesse').value).replace(/\s*\+\s*/g, ' + '),
      cliente: testo($('pcf-cliente').value),
      software: [...softwareScelto],
      stato: $('pcf-stato').value,
      hardware: testo($('pcf-hardware').value),
      consegna: $('pcf-consegna').value,
      note: testo($('pcf-note').value),
      stornata: $('pcf-stornata').checked
    };
    if (!valori.commesse && !valori.cliente) {
      $('pcf-errore').textContent = 'Serve almeno il numero di commessa o il cliente.';
      $('pcf-commesse').focus();
      return;
    }
    const adesso = new Date().toISOString();
    const esistente = aperto && dati.pc.find(p => p.id === aperto);
    if (esistente) Object.assign(esistente, valori, { modificato: adesso });
    else dati.pc.push(normalizza({ id: nuovoId(), ...valori, creato: adesso, modificato: adesso }));
    salva();
    chiudi();
    disegna();
    mostraMessaggio(esistente ? 'Modifiche salvate.' : 'PC aggiunto.');
  }

  function elimina() {
    const i = dati.pc.findIndex(p => p.id === aperto);
    if (i < 0) return;
    const [tolto] = dati.pc.splice(i, 1);
    dati.eliminati.push({ id: tolto.id, quando: new Date().toISOString() });
    salva();
    chiudi();
    disegna();
    mostraMessaggio(`Eliminato il PC ${tolto.commesse || tolto.cliente}.`, 'Annulla', () => {
      dati.eliminati = dati.eliminati.filter(t => t.id !== tolto.id);
      dati.pc.push({ ...tolto, modificato: new Date().toISOString() });
      salva();
      disegna();
    });
  }

  // ─────────────── importa da Excel
  //
  // Si copiano le righe dal foglio e si incollano: Excel le mette negli appunti
  // separate da tabulazioni, con le celle su più righe fra virgolette. Le colonne sono
  // quelle del foglio: commessa, cliente, software, stato, due colonne che qui non
  // servono, note, hardware, consegna. Una riga con solo il software continua il PC
  // di sopra (un PC con più software); le righe vuote separano i mesi e si saltano.

  function righeTsv(t) {
    const righe = [];
    let riga = [], cella = '', virgolette = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (virgolette) {
        if (c === '"' && t[i + 1] === '"') { cella += '"'; i++; }
        else if (c === '"') virgolette = false;
        else cella += c;
      } else if (c === '"' && cella === '') virgolette = true;
      else if (c === '\t') { riga.push(cella); cella = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && t[i + 1] === '\n') i++;
        riga.push(cella); righe.push(riga); riga = []; cella = '';
      } else cella += c;
    }
    if (cella || riga.length) { riga.push(cella); righe.push(riga); }
    return righe;
  }

  function leggiIncollato(t) {
    const pc = [];
    for (const r of righeTsv(t)) {
      const c = i => testo(r[i]).replace(/\s+/g, ' ');
      if (r.every(x => !testo(x))) continue;
      if (/^commess/i.test(c(0))) continue;   // la riga dei titoli
      if (!c(0) && !c(1) && pc.length) {
        // Continua il PC di sopra: altro software, o altre parti del testo.
        const p = pc[pc.length - 1];
        if (c(2)) p.software.push(c(2));
        if (c(6)) p.note = [p.note, c(6)].filter(Boolean).join(' ');
        if (c(7)) p.hardware = [p.hardware, c(7)].filter(Boolean).join(' ');
        continue;
      }
      const note = c(6);
      const consegna = leggiMese(c(8));
      pc.push({
        commesse: c(0).replace(/\s*\+\s*/g, ' + '),
        cliente: c(1),
        software: c(2) ? c(2).split(/\s*[,;/]\s*|\n/).filter(Boolean) : [],
        stato: c(3),
        note: [note, !consegna && c(8) ? `consegna: ${c(8)}` : ''].filter(Boolean).join(' · '),
        hardware: c(7),
        consegna,
        // Nel foglio la commessa stornata era solo grigia: qui lo dice la nota.
        stornata: /stornat/i.test(note)
      });
    }
    return pc;
  }

  const chiaveCommesse = t => chiaro(t).replace(/\s+/g, '');

  function anteprimaImporta() {
    const letti = leggiIncollato($('pci-testo').value);
    const nuovi = letti.filter(p => !dati.pc.some(x => chiaveCommesse(x.commesse) === chiaveCommesse(p.commesse) && p.commesse));
    $('pci-esito').textContent = letti.length
      ? `${letti.length} PC letti: ${nuovi.length} nuovi, ${letti.length - nuovi.length} già presenti (verranno aggiornati).`
      : 'Incolla qui le righe copiate dal foglio Excel.';
    $('pci-importa').disabled = !letti.length;
    return letti;
  }

  function importa() {
    const letti = anteprimaImporta();
    if (!letti.length) return;
    const prima = JSON.parse(JSON.stringify(dati));
    const adesso = new Date().toISOString();
    let nuovi = 0, aggiornati = 0;
    for (const l of letti) {
      const c = l.commesse && dati.pc.find(x => chiaveCommesse(x.commesse) === chiaveCommesse(l.commesse));
      if (c) { Object.assign(c, normalizza({ ...c, ...l, id: c.id, creato: c.creato, modificato: adesso })); aggiornati++; }
      else { dati.pc.push(normalizza({ ...l, id: nuovoId(), creato: adesso, modificato: adesso })); nuovi++; }
    }
    salva();
    $('importa-pc').close();
    $('pci-testo').value = '';
    disegna();
    mostraMessaggio(`Importati ${nuovi} PC nuovi, ${aggiornati} aggiornati.`, 'Annulla', () => {
      // Si torna a prima, ma più recenti dell'importazione, così vale anche su OneDrive.
      const ora = new Date().toISOString();
      const tenuti = new Set(prima.pc.map(p => p.id));
      dati = {
        versione: 1,
        pc: prima.pc.map(p => ({ ...p, modificato: ora })),
        eliminati: [...prima.eliminati, ...dati.pc.filter(p => !tenuti.has(p.id)).map(p => ({ id: p.id, quando: ora }))]
      };
      salva();
      disegna();
    });
  }

  // ─────────────── avvio

  function avvia() {
    $('pc-aggiungi').addEventListener('click', () => apri(null));
    $('pc-cerca').addEventListener('input', disegna);
    $('pc-nascondi').addEventListener('change', e => {
      nascondiFatti = e.target.checked;
      try { localStorage.setItem(CHIAVE_FILTRO, nascondiFatti ? '1' : '0'); } catch (_) {}
      disegna();
    });
    $('modulo-pc').addEventListener('submit', salvaScheda);
    $('pcf-annulla').addEventListener('click', chiudi);
    $('pcf-elimina').addEventListener('click', elimina);
    $('pcf-aggiungi-sw').addEventListener('click', aggiungiAltro);
    $('pcf-altro').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aggiungiAltro(); } });
    $('scheda-pc').addEventListener('click', e => { if (e.target === $('scheda-pc')) chiudi(); });

    $('pc-importa-apri').addEventListener('click', () => { anteprimaImporta(); $('importa-pc').showModal(); $('pci-testo').focus(); });
    $('pci-testo').addEventListener('input', anteprimaImporta);
    $('pci-importa').addEventListener('click', importa);
    $('pci-annulla').addEventListener('click', () => $('importa-pc').close());

    window.addEventListener('storage', e => { if (e.key === CHIAVE) { dati = carica(); disegna(); } });
    onedrive.registra(sincronizza);
    disegna();
  }

  return { avvia, disegna, leggiIncollato, leggiMese };
})();

pcCommesse.avvia();
