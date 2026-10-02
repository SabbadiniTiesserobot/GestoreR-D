'use strict';

// ════════════════════════════════════════════════ Ore
//
// Il modulo Ore di App gestione R&D, versione per il telefono. Legge e scrive lo
// stesso file dell'app desktop, «Ore/ore_<anno>.json» su OneDrive
// (…\OneDrive - Tiesserobot\Ore\ sul PC), così le due versioni lavorano sugli stessi
// dati. Il comportamento viene da HANDOFF-ORE.md; dove il telefono chiede altro (una
// giornata per schermata invece della griglia del mese) lo dice il commento sul posto.
//
// Il file non si riscrive mai da capo: si rilegge da OneDrive, si sostituiscono le
// voci delle sole giornate cambiate qui, si aggiungono le commesse nuove, e tutto il
// resto (campi che questa versione non conosce compresi) resta com'era. Due modifiche
// alla stessa giornata, una qui e una sul PC, si risolvono a favore dell'ultima
// arrivata; giornate diverse non si toccano mai a vicenda.

const ORE_CONFIG = {
  cartella: 'Ore'
};

const ore = (() => {
  // La mattina 08:00–12:00, il pomeriggio 13:30–17:30: l'inizio di ogni ora, in minuti.
  const SESSIONI = [[480, 540, 600, 660], [810, 870, 930, 990]];
  const INIZI = SESSIONI.flat();
  const GIORNATA = 480;
  const PASSI_STORIA = 50;
  const TINTE = 10;

  const CHIAVE = anno => `rd.ore.v1.${anno}`;
  const CHIAVE_GIORNO = 'rd.ore.giorno';
  const CHIAVE_SCHEDA = 'rd.scheda';

  // ─────────────── piccoli attrezzi

  const due = n => String(n).padStart(2, '0');
  const testoOra = m => `${due(Math.floor(m / 60))}:${due(m % 60)}`;
  const minuti = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const fmt = min => (min / 60).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const aData = d => `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}`;
  const daData = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const oggi = () => aData(new Date());
  const annoDi = s => Number(s.slice(0, 4));
  const festivo = d => d.getDay() === 0 || d.getDay() === 6;

  function spostaLavorativo(s, passo) {
    const d = daData(s);
    do d.setDate(d.getDate() + passo); while (festivo(d));
    return aData(d);
  }
  // Sabato e domenica si apre il venerdì: è la settimana che si sta chiudendo.
  function feriale(s) {
    const d = daData(s);
    while (festivo(d)) d.setDate(d.getDate() - 1);
    return aData(d);
  }
  function lunedi(s) {
    const d = daData(s);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return aData(d);
  }
  const leggi = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const scriviLocale = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return e; } };
  const el = (tag, classe, testo) => {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (testo != null) e.textContent = testo;
    return e;
  };
  const chiaro = t => t.toLocaleLowerCase('it');

  // ─────────────── i file per anno
  //
  // Per ogni anno si tiene qui: l'ultimo testo letto da OneDrive con il suo eTag, le
  // giornate cambiate e non ancora inviate (data → voci), le commesse nuove.

  const anni = new Map();
  const percorso = anno => `${ORE_CONFIG.cartella}/ore_${anno}.json`;

  function statoAnno(anno) {
    if (!anni.has(anno)) {
      let salvato = null;
      try { salvato = JSON.parse(leggi(CHIAVE(anno))); } catch (_) {}
      anni.set(anno, {
        testo: null, eTag: null, modifiche: {}, nuove: [], manca: false, creare: false,
        ...(salvato || {}),
        errore: '', versione: 0, doc: null
      });
    }
    return anni.get(anno);
  }

  function salvaAnno(anno) {
    const s = statoAnno(anno);
    const esito = scriviLocale(CHIAVE(anno), JSON.stringify({
      testo: s.testo, eTag: s.eTag, modifiche: s.modifiche, nuove: s.nuove, manca: s.manca, creare: s.creare
    }));
    if (esito !== true) mostraMessaggio('Salvataggio non riuscito: ' + esito.message);
  }

  const inAttesa = s => Object.keys(s.modifiche).length > 0 || s.nuove.length > 0;

  function leggiDoc(testo) {
    const d = JSON.parse(testo);
    if (!d || typeof d !== 'object' || !Array.isArray(d.giorni) || !Array.isArray(d.commesse)) {
      throw new Error('non è un file delle ore');
    }
    return d;
  }

  const nuovoDoc = anno => ({ version: 1, year: anno, commesse: [], giorni: [] });

  /** Il documento di OneDrive con sopra le modifiche fatte qui. */
  function applica(doc, modifiche, nuove) {
    for (const c of nuove) {
      if (!doc.commesse.some(x => x.id === c.id)) doc.commesse.push(c);
    }
    for (const [data, voci] of Object.entries(modifiche)) {
      const i = doc.giorni.findIndex(g => g.data === data);
      if (i >= 0) {
        const g = doc.giorni[i];
        // Una giornata rimasta senza voci e senza altro si toglie: nel file non serve.
        const soloVoci = Object.keys(g).every(k => k === 'data' || k === 'voci' || (k === 'nota' && !g.nota));
        if (voci.length === 0 && soloVoci) doc.giorni.splice(i, 1);
        else g.voci = voci;
      } else if (voci.length) {
        doc.giorni.push({ data, nota: null, voci });
      }
    }
    doc.giorni.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    return doc;
  }

  /** Il documento su cui si lavora, con gli indici; null finché non è mai arrivato. */
  function documento(anno) {
    const s = statoAnno(anno);
    if (!s.doc) {
      let base = null;
      if (s.testo) {
        try { base = leggiDoc(s.testo); } catch (e) { s.errore = `ore_${anno}.json non leggibile: ${e.message}`; }
      }
      if (!base) return null;
      const doc = applica(base, s.modifiche, s.nuove);
      s.doc = {
        doc,
        // Una versione del formato più nuova si guarda soltanto: scriverla vorrebbe dire
        // perdere quello che questa versione non conosce.
        solaLettura: Number(doc.version) > 1,
        commesse: new Map(doc.commesse.filter(c => c && c.id).map(c => [c.id, c])),
        giorni: new Map(doc.giorni.filter(g => g && g.data).map(g => [g.data, g]))
      };
    }
    return s.doc;
  }

  function cambiato(anno) {
    const s = statoAnno(anno);
    s.versione++;
    s.doc = null;
    salvaAnno(anno);
    onedrive.modificato();
  }

  // ─────────────── la sincronizzazione (chiamata da onedrive a ogni giro)

  const anniAperti = new Set();

  async function sincronizza({ leggiFile, scriviFile }) {
    for (const anno of anniAperti) await sincronizzaAnno(anno, leggiFile, scriviFile);
  }

  async function sincronizzaAnno(anno, leggiFile, scriviFile) {
    const s = statoAnno(anno);
    for (let tentativo = 0; tentativo < 4; tentativo++) {
      const versione = s.versione;
      const remoto = await leggiFile(percorso(anno));

      if (!remoto && !s.creare) {
        s.manca = true;
        s.doc = null;
        salvaAnno(anno);
        disegna();
        return;
      }
      s.manca = false;

      let base;
      try {
        base = remoto ? leggiDoc(remoto.testo) : nuovoDoc(anno);
      } catch (e) {
        // Un file che non si capisce non si sovrascrive: lo si segnala e basta.
        s.errore = `ore_${anno}.json non leggibile: ${e.message}`;
        disegna();
        throw new Error(s.errore);
      }
      s.errore = '';

      if (!inAttesa(s) && remoto) {
        if (remoto.eTag !== s.eTag || remoto.testo !== s.testo) {
          s.testo = remoto.testo;
          s.eTag = remoto.eTag;
          s.doc = null;
          salvaAnno(anno);
          disegna();
        }
        return;
      }

      if (Number(base.version) > 1) {
        s.testo = remoto.testo;
        s.eTag = remoto.eTag;
        s.doc = null;
        salvaAnno(anno);
        disegna();
        throw new Error(`ore_${anno}.json ha un formato più nuovo: qui si può solo guardare`);
      }

      const testo = JSON.stringify(applica(base, s.modifiche, s.nuove), null, 2);
      const eTag = await scriviFile(percorso(anno), testo, remoto ? remoto.eTag : null);
      if (!eTag) continue;   // cambiato nel frattempo, dal PC o da un altro telefono: rileggi

      s.testo = testo;
      s.eTag = typeof eTag === 'string' ? eTag : null;
      s.creare = false;
      // Se mentre si inviava è cambiato altro, le modifiche restano: rimetterle sopra
      // al giro dopo dà lo stesso risultato, e intanto ci sono anche le nuove.
      if (s.versione === versione) { s.modifiche = {}; s.nuove = []; }
      s.doc = null;
      salvaAnno(anno);
      disegna();
      return;
    }
    throw new Error(`ore_${anno}.json continua a cambiare, riprova tra poco`);
  }

  function apriAnno(anno) {
    if (anniAperti.has(anno)) return;
    anniAperti.add(anno);
    statoAnno(anno);
    if (onedrive.collegato()) onedrive.sincronizza();
  }

  // ─────────────── la giornata come otto ore, ognuna intera o in due mezz'ore

  /**
   * Le voci di una giornata viste come ore: { inizio, diviso, meta: [id, id], orig },
   * più «modificabile», falso se il file ha voci che questa vista non sa rappresentare
   * (un quarto d'ora, un orario fuori dagli slot, due voci sovrapposte).
   */
  function griglia(giorno) {
    const ore = INIZI.map(m => ({ inizio: m, diviso: false, meta: [null, null], orig: [null, null] }));
    let modificabile = true;

    for (const v of (giorno && Array.isArray(giorno.voci)) ? giorno.voci : []) {
      const m = minuti(v.inizio);
      const i = INIZI.findIndex(x => m >= x && m < x + 60);
      const h = ore[i];
      const k = h ? (m - h.inizio) / 30 : -1;

      if (!h || (k !== 0 && k !== 1) || !(v.durata === 30 || (v.durata === 60 && k === 0))) {
        modificabile = false;
        continue;
      }
      if (v.durata === 60) {
        if (h.meta[0] || h.meta[1]) modificabile = false;
        h.meta = [v.commessaId, v.commessaId];
        h.orig = [v, v];
      } else {
        if (h.meta[k]) modificabile = false;
        h.meta[k] = v.commessaId;
        h.orig[k] = v;
        h.diviso = true;
      }
    }
    return { ore, modificabile };
  }

  /** Di nuovo voci, riusando gli oggetti che non sono cambiati (e i loro campi in più). */
  function vociDa(ore) {
    const voci = [];
    for (const h of ore) {
      if (!h.diviso) {
        if (!h.meta[0]) continue;
        const o = h.orig[0];
        voci.push(o && o === h.orig[1] && o.durata === 60 && o.commessaId === h.meta[0]
          ? o : { inizio: testoOra(h.inizio), durata: 60, commessaId: h.meta[0] });
      } else {
        h.meta.forEach((c, k) => {
          if (!c) return;
          const o = h.orig[k];
          voci.push(o && o.durata === 30 && o.commessaId === c
            ? o : { inizio: testoOra(h.inizio + 30 * k), durata: 30, commessaId: c });
        });
      }
    }
    return voci;
  }

  // Un'ora vuota divisa in due non ha niente da scrivere nel file: resta divisa solo
  // sullo schermo, finché non ci si mette una voce.
  const divise = new Set();
  function grigliaDi(data, g) {
    const r = griglia(g);
    r.ore.forEach((h, i) => {
      const k = `${data}|${i}`;
      if (h.diviso) divise.delete(k);
      else if (!h.meta[0] && divise.has(k)) h.diviso = true;
    });
    return r;
  }

  function minutiGiorno(giorno) {
    return (giorno && Array.isArray(giorno.voci) ? giorno.voci : [])
      .reduce((t, v) => t + (Number(v.durata) || 0), 0);
  }

  // ─────────────── colori
  //
  // Il colore viene dall'etichetta (impronta FNV-1a sui byte UTF-8) su dieci tinte a
  // tonalità equidistanti e luminosità alternata. Dentro una giornata due voci non
  // hanno mai la stessa tinta: chi la trova occupata prende la più lontana da quelle
  // già usate.

  function impronta(testo) {
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(testo)) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }
  const distanza = (a, b) => {
    const passi = Math.abs(a - b) % TINTE;
    return Math.min(passi, TINTE - passi) + ((a % 2) !== (b % 2) ? 0.5 : 0);
  };

  function tinte(ids, etichetta) {
    const usate = [];
    const out = new Map();
    for (const id of ids) {
      if (!id || out.has(id)) continue;
      let t = impronta(etichetta(id)) % TINTE;
      if (usate.includes(t) && usate.length < TINTE) {
        let meglio = t, lontana = -1;
        for (let c = 0; c < TINTE; c++) {
          if (usate.includes(c)) continue;
          const d = Math.min(...usate.map(u => distanza(c, u)));
          if (d > lontana) { lontana = d; meglio = c; }
        }
        t = meglio;
      }
      usate.push(t);
      out.set(id, t);
    }
    return out;
  }

  function coloraVoce(elemento, tinta, voce = true) {
    elemento.classList.add('tinta');
    if (voce) elemento.classList.add('voce');
    elemento.classList.toggle('alt', tinta % 2 === 1);
    elemento.style.setProperty('--h', String(tinta * (360 / TINTE) + 12));
  }

  // «ferie» e «permesso» sono una categoria, per parola intera e senza maiuscole.
  function assenza(etichetta) {
    const t = ` ${chiaro(etichetta).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    if (t.includes(' ferie ')) return 'ferie';
    if (t.includes(' permesso ')) return 'permesso';
    return null;
  }

  // ─────────────── stato della vista

  let giorno = feriale(leggi(CHIAVE_GIORNO) || oggi());
  let scelta = null;     // { ora: indice 0–7, meta: 0 | 1 | null }
  const storia = [];     // { anno, data, prima, dopo }
  let futuro = [];

  const etichettaDi = (info, id) => {
    const c = info && info.commesse.get(id);
    return c ? String(c.label || c.codice || id) : String(id);
  };

  function infoGiorno(data) {
    const info = documento(annoDi(data));
    const g = info ? info.giorni.get(data) || null : null;
    return { info, g };
  }

  // ─────────────── modificare

  function cambiaGiornata(data, voci, { registra = true } = {}) {
    const anno = annoDi(data);
    const { info, g } = infoGiorno(data);
    if (!info || info.solaLettura) return;
    const prima = g && Array.isArray(g.voci) ? g.voci : [];
    if (JSON.stringify(prima) === JSON.stringify(voci)) return;

    if (registra) {
      storia.push({ anno, data, prima, dopo: voci });
      if (storia.length > PASSI_STORIA) storia.shift();
      futuro = [];
    }
    statoAnno(anno).modifiche[data] = voci;
    cambiato(anno);
  }

  function modificaScelta(fn) {
    if (!scelta) return;
    const { g } = infoGiorno(giorno);
    const { ore: righe, modificabile } = grigliaDi(giorno, g);
    if (!modificabile) return;
    const h = righe[scelta.ora];
    fn(h);
    if (h.diviso) divise.add(`${giorno}|${scelta.ora}`);
    else divise.delete(`${giorno}|${scelta.ora}`);
    cambiaGiornata(giorno, vociDa(righe));
  }

  function imposta(id) {
    modificaScelta(h => {
      if (h.diviso) h.meta[scelta.meta || 0] = id;
      else h.meta = [id, id];
    });
  }

  function dividiORiunisci() {
    modificaScelta(h => {
      if (h.diviso) {
        const c = h.meta[0] || h.meta[1];
        h.diviso = false;
        h.meta = [c, c];
      } else {
        h.diviso = true;
      }
    });
    const { g } = infoGiorno(giorno);
    const h = grigliaDi(giorno, g).ore[scelta.ora];
    scelta.meta = h.diviso ? 0 : null;
  }

  /** Dopo aver scelto una voce si passa allo slot dopo; in fondo alla giornata ci si ferma. */
  function avanza() {
    const { g } = infoGiorno(giorno);
    const righe = grigliaDi(giorno, g).ore;
    if (righe[scelta.ora].diviso && scelta.meta === 0) { scelta.meta = 1; return true; }
    if (scelta.ora >= INIZI.length - 1) return false;
    scelta.ora++;
    scelta.meta = righe[scelta.ora].diviso ? 0 : null;
    return true;
  }

  function annulla() {
    const passo = storia.pop();
    if (!passo) return;
    futuro.push(passo);
    statoAnno(passo.anno).modifiche[passo.data] = passo.prima;
    cambiato(passo.anno);
    vaiA(passo.data);
    mostraMessaggio('Annullato.');
  }

  function rifai() {
    const passo = futuro.pop();
    if (!passo) return;
    storia.push(passo);
    statoAnno(passo.anno).modifiche[passo.data] = passo.dopo;
    cambiato(passo.anno);
    vaiA(passo.data);
    mostraMessaggio('Rifatto.');
  }

  // ─────────────── nuove commesse

  // Un numero di commessa ha la forma 26045G04: anno, progressivo, lettera, due cifre.
  const NUMERO = /\b(\d{5}[A-Za-z]\d{2})\b/;

  function nuovaCommessa(info, testo) {
    const label = testo.trim().replace(/\s+/g, ' ');
    const numero = (label.match(NUMERO) || [])[1];
    const base = 'c-' + (chiaro(numero || label).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'voce');
    let id = base;
    for (let n = 2; info.commesse.has(id) || statoAnno(annoDi(giorno)).nuove.some(c => c.id === id); n++) {
      id = `${base}-${n}`;
    }
    const c = {
      id, label, codice: numero ? numero.toUpperCase() : null, cliente: null,
      colore: null, alias: [], attiva: true
    };
    statoAnno(annoDi(giorno)).nuove.push(c);
    return c;
  }

  // ─────────────── l'autocomplete
  //
  // Cerca su label, alias e codice, anche a metà parola. Prima chi combacia meglio
  // (esatto, poi dall'inizio, poi dentro), a pari merito chi ha più ore nel mese.

  function oreNelMese(info, mese) {
    const tot = new Map();
    if (!info) return tot;
    for (const [data, g] of info.giorni) {
      if (!data.startsWith(mese)) continue;
      for (const v of g.voci || []) tot.set(v.commessaId, (tot.get(v.commessaId) || 0) + (Number(v.durata) || 0));
    }
    return tot;
  }

  function proposte(info, query, idsGiorno) {
    const q = chiaro(query.trim());
    const mese = oreNelMese(info, giorno.slice(0, 7));
    const tutte = [...info.commesse.values()].filter(c => c.attiva !== false);
    const out = [];

    if (!q) {
      // Senza testo: le voci già della giornata, poi le più usate del mese.
      const viste = new Set();
      for (const id of idsGiorno) {
        const c = info.commesse.get(id);
        if (c && !viste.has(id)) { viste.add(id); out.push({ c }); }
      }
      tutte.filter(c => !viste.has(c.id) && mese.get(c.id))
        .sort((a, b) => mese.get(b.id) - mese.get(a.id))
        .slice(0, 8).forEach(c => out.push({ c }));
      return { righe: out, mese };
    }

    for (const c of tutte) {
      let punti = 9, perAlias = null;
      const prova = (valore, alias) => {
        const v = chiaro(String(valore || ''));
        if (!v) return;
        const p = v === q ? 0 : v.startsWith(q) ? 1 : v.includes(q) ? 2 : 9;
        if (p < punti) { punti = p; perAlias = alias ? valore : null; }
      };
      prova(c.label);
      prova(c.codice);
      for (const a of Array.isArray(c.alias) ? c.alias : []) prova(a, true);
      if (punti < 9) out.push({ c, punti, perAlias });
    }
    out.sort((a, b) => a.punti - b.punti || (mese.get(b.c.id) || 0) - (mese.get(a.c.id) || 0) ||
      String(a.c.label).localeCompare(String(b.c.label), 'it'));
    return { righe: out.slice(0, 30), mese };
  }

  // ─────────────── disegnare

  function vaiA(data) {
    giorno = feriale(data);
    scriviLocale(CHIAVE_GIORNO, giorno);
    if (scelta && $('scheda-ore').open === false) scelta = null;
    apriAnno(annoDi(giorno));
    // La settimana può attraversare il capodanno.
    apriAnno(annoDi(spostaLavorativo(lunedi(giorno), 4)));
    disegna();
  }

  function disegna() {
    disegnaTarga();
    disegnaGiorno();
    disegnaSettimana();
    disegnaSlot();
    if ($('scheda-ore').open) disegnaProposte();
    if ($('riepilogo-ore').open) disegnaRiepilogo();
    $('ore-annulla').disabled = storia.length === 0;
    $('ore-rifai').disabled = futuro.length === 0;
    $('ore-oggi').hidden = giorno === feriale(oggi());
  }

  function disegnaTarga() {
    const targa = $('targa-ore');
    targa.replaceChildren();
    const info = documento(annoDi(giorno));
    const d = daData(giorno);
    const nomeMese = d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    if (!info) { targa.textContent = nomeMese; return; }

    // Il mese: i giorni lavorativi del mese di calendario, otto ore ciascuno.
    const mese = giorno.slice(0, 7);
    let fatte = 0;
    for (const [data, g] of info.giorni) if (data.startsWith(mese)) fatte += minutiGiorno(g);
    let lavorativi = 0;
    for (const x = new Date(d.getFullYear(), d.getMonth(), 1); x.getMonth() === d.getMonth(); x.setDate(x.getDate() + 1)) {
      if (!festivo(x)) lavorativi++;
    }
    const obiettivo = lavorativi * GIORNATA;
    const b = el('b', null, fmt(fatte));
    targa.append(nomeMese.charAt(0).toUpperCase() + nomeMese.slice(1) + ' · ', b, ` / ${fmt(obiettivo)} h`);
    if (obiettivo > fatte) targa.append(' · ', el('span', 'da-fare', `${fmt(obiettivo - fatte)} da fare`));
    else targa.append(' · ', el('span', 'fatto', 'completo'));
  }

  function disegnaGiorno() {
    const d = daData(giorno);
    const testo = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    $('ore-data-testo').textContent = testo.charAt(0).toUpperCase() + testo.slice(1);
    const { info, g } = infoGiorno(giorno);
    const tot = $('ore-totale');
    if (!info) { tot.textContent = ''; return; }
    const m = minutiGiorno(g);
    tot.textContent = `${fmt(m)} / ${fmt(GIORNATA)} h`;
    tot.className = m === GIORNATA ? 'pieno' : 'meno';

    const nota = $('ore-nota');
    nota.hidden = !(g && g.nota);
    nota.textContent = g && g.nota ? g.nota : '';
  }

  function disegnaSettimana() {
    const box = $('ore-settimana');
    box.replaceChildren();
    let data = lunedi(giorno);
    for (let i = 0; i < 5; i++, data = spostaLavorativo(data, 1)) {
      const d = daData(data);
      const { info, g } = infoGiorno(data);
      const b = el('button');
      b.type = 'button';
      if (data === giorno) b.setAttribute('aria-current', 'date');
      if (data === oggi()) b.classList.add('oggi');
      b.append(el('span', null, d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '')));
      b.append(el('span', 'num', String(d.getDate())));
      const m = info ? minutiGiorno(g) : null;
      const t = el('span', 'tot ' + (m === GIORNATA ? 'pieno' : m ? 'meno' : ''), m == null ? '' : m ? fmt(m) : '—');
      b.append(t);
      const quale = data;
      b.addEventListener('click', () => vaiA(quale));
      box.append(b);
    }
  }

  function disegnaAvviso(testo, classe, pulsante) {
    const a = $('ore-avviso');
    a.hidden = !testo;
    a.className = 'ore-avviso' + (classe ? ' ' + classe : '');
    a.replaceChildren();
    if (!testo) return;
    a.append(testo);
    if (pulsante) {
      const b = el('button', 'primario', pulsante.testo);
      b.type = 'button';
      b.addEventListener('click', pulsante.azione);
      a.append(b);
    }
  }

  function disegnaSlot() {
    const box = $('ore-slot');
    box.replaceChildren();
    const anno = annoDi(giorno);
    const s = statoAnno(anno);
    const { info, g } = infoGiorno(giorno);

    if (!info) {
      if (s.manca) {
        disegnaAvviso(`Non trovo il file ${percorso(anno)} sul tuo OneDrive. Se l'app sul PC salva altrove, ` +
          `la cartella va cambiata in ORE_CONFIG; altrimenti si può crearlo adesso.`, '', {
          testo: `Crea ore_${anno}.json`,
          azione: () => { s.creare = true; salvaAnno(anno); onedrive.sincronizza(); }
        });
      } else if (s.errore) {
        disegnaAvviso(s.errore, 'errore-ore');
      } else {
        disegnaAvviso('Carico le ore da OneDrive…');
      }
      return;
    }

    const { ore: righe, modificabile } = grigliaDi(giorno, g);
    if (info.solaLettura) disegnaAvviso('Il file è in un formato più nuovo di questa app: le ore si possono solo guardare.', 'errore-ore');
    else if (!modificabile) disegnaAvviso('Questa giornata ha voci che qui non si possono rappresentare (orari fuori dagli slot o più fini della mezz\'ora): modificala dal PC.');
    else disegnaAvviso('');
    const sola = info.solaLettura || !modificabile;
    box.classList.toggle('sola-lettura', sola);

    const ids = righe.flatMap(h => h.meta);
    const colori = tinte(ids, id => etichettaDi(info, id));
    const totali = new Map();
    for (const h of righe) {
      h.meta.forEach((c, k) => { if (c) totali.set(c, (totali.get(c) || 0) + (h.diviso ? 30 : (k === 0 ? 60 : 0))); });
    }

    let indice = 0;
    SESSIONI.forEach((sessione, n) => {
      if (n > 0) {
        const p = el('div', 'pausa');
        p.append(el('span', null, 'pausa'));
        box.append(p);
      }
      const blocco = el('div', 'sessione');
      const primo = indice;
      const ultimo = indice + sessione.length - 1;
      for (; indice <= ultimo; indice++) {
        const h = righe[indice];
        const prec = indice > primo ? righe[indice - 1] : null;
        // Le ore di fila con la stessa voce sono un blocco: la riga dentro il blocco non
        // ripete il nome, e il blocco dice il suo intervallo.
        const unita = c => c && !h.diviso;
        const continua = prec && unita(h.meta[0]) && !prec.diviso && prec.meta[0] === h.meta[0];
        let fine = indice;
        while (unita(h.meta[0]) && fine < ultimo && !righe[fine + 1].diviso && righe[fine + 1].meta[0] === h.meta[0]) fine++;

        const riga = el('div', 'ora' + (continua ? ' dentro' : ''));
        riga.append(el('div', 'quando', testoOra(h.inizio)));
        const meta = el('div', 'metà');
        const parti = h.diviso ? [0, 1] : [null];
        for (const k of parti) {
          const c = h.meta[k || 0];
          const cella = el('button', 'cella' + (c ? '' : ' vuota'));
          cella.type = 'button';
          cella.disabled = false;
          if (c) {
            coloraVoce(cella, colori.get(c));
            const tipo = assenza(etichettaDi(info, c));
            if (tipo) cella.classList.add('assenza', tipo);
          }
          const scelto = scelta && scelta.ora === indice && (scelta.meta === k || (k === null && scelta.meta === null));
          if (scelto) cella.classList.add('scelta');

          if (c && !continua) {
            cella.append(el('span', 'nome', etichettaDi(info, c)));
            if (h.diviso) cella.append(el('span', 'intervallo', `${testoOra(h.inizio + 30 * k)}–${testoOra(h.inizio + 30 * k + 30)}`));
            else if (fine > indice) cella.append(el('span', 'intervallo', `${testoOra(h.inizio)}–${testoOra(righe[fine].inizio + 60)}`));
            const t = el('span', 'tot', fmt(totali.get(c)));
            t.title = `${etichettaDi(info, c)}: ${fmt(totali.get(c))} h in tutta la giornata`;
            cella.append(t);
          } else if (!c) {
            cella.append(el('span', 'nome', h.diviso ? `${testoOra(h.inizio + 30 * k)} vuota` : 'vuota'));
          } else {
            cella.append(el('span', 'nome'));
          }
          cella.setAttribute('aria-label', `${testoOra(h.inizio + 30 * (k || 0))}: ${c ? etichettaDi(info, c) : 'vuota'}`);

          const quale = { ora: indice, meta: k };
          cella.addEventListener('click', () => { if (!sola) apriScelta(quale); });
          meta.append(cella);
        }
        riga.append(meta);
        blocco.append(riga);
      }
      box.append(blocco);
    });
  }

  // ─────────────── il pannello per scegliere la voce

  let evidenziata = 0;
  let righeProposte = [];

  function apriScelta(quale) {
    scelta = { ...quale };
    $('ore-cerca').value = '';
    evidenziata = 0;
    disegnaProposte();
    disegnaSlot();
    if (!$('scheda-ore').open) $('scheda-ore').showModal();
    // Sul PC si scrive subito; sul telefono la tastiera si apre solo toccando il campo,
    // perché spesso basta toccare una delle voci proposte.
    if (window.matchMedia('(pointer: fine)').matches) $('ore-cerca').focus();
  }

  function chiudiScelta() {
    $('scheda-ore').close();
  }

  function disegnaProposte() {
    const lista = $('ore-proposte');
    lista.replaceChildren();
    const { info, g } = infoGiorno(giorno);
    if (!info || !scelta) return;
    const { ore: righe } = grigliaDi(giorno, g);
    const h = righe[scelta.ora];
    const inizio = h.inizio + (h.diviso ? 30 * (scelta.meta || 0) : 0);
    const durata = h.diviso ? 30 : 60;
    $('ore-sel').textContent = `${daData(giorno).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })} · ${testoOra(inizio)}–${testoOra(inizio + durata)}`;
    $('ore-dividi').textContent = h.diviso ? 'Ora intera' : '½ ora';
    $('ore-svuota').disabled = !(h.diviso ? h.meta[scelta.meta || 0] : h.meta[0]);

    const query = $('ore-cerca').value;
    const idsGiorno = righe.flatMap(x => x.meta).filter(Boolean);
    const { righe: trovate, mese } = proposte(info, query, idsGiorno);
    const colori = tinte([...idsGiorno, ...trovate.map(t => t.c.id)], id => etichettaDi(info, id));
    const attuale = h.diviso ? h.meta[scelta.meta || 0] : h.meta[0];

    righeProposte = trovate.map(t => () => imposta(t.c.id));
    const testo = query.trim();
    const esatta = trovate.some(t => t.punti === 0);
    if (testo && !esatta) {
      righeProposte.push(() => imposta(nuovaCommessa(info, testo).id));
    }
    if (evidenziata >= righeProposte.length) evidenziata = 0;

    trovate.forEach((t, i) => {
      const li = el('li');
      const b = el('button', i === evidenziata && testo ? 'attiva' : '');
      b.type = 'button';
      const pallino = el('span', 'pallino');
      coloraVoce(pallino, colori.get(t.c.id), false);
      const testi = el('span', 'testi', String(t.c.label || t.c.codice || t.c.id));
      const dettagli = [];
      if (t.perAlias) dettagli.push(`trovata per «${t.perAlias}»`);
      if (t.c.cliente) dettagli.push(t.c.cliente);
      if (t.c.id === attuale) dettagli.push('quella di adesso');
      if (dettagli.length) testi.append(el('small', null, dettagli.join(' · ')));
      b.append(pallino, testi);
      const m = mese.get(t.c.id);
      if (m) b.append(el('span', 'h', `${fmt(m)} h nel mese`));
      b.addEventListener('click', () => scegli(i));
      li.append(b);
      lista.append(li);
    });

    if (testo && !esatta) {
      const li = el('li');
      const b = el('button', 'nuova' + (evidenziata === trovate.length ? ' attiva' : ''), `Nuova voce «${testo}»`);
      b.type = 'button';
      b.addEventListener('click', () => scegli(trovate.length));
      li.append(b);
      lista.append(li);
    }
    if (!testo && trovate.length === 0) {
      lista.append(el('li', 'riep-piede', 'Scrivi per cercare una commessa o crearne una nuova.'));
    }
  }

  function scegli(i) {
    const f = righeProposte[i];
    if (!f) return;
    f();
    $('ore-cerca').value = '';
    evidenziata = 0;
    if (!avanza()) { chiudiScelta(); return; }
    disegna();
  }

  // ─────────────── il riepilogo

  let perimetro = 'mese', vista = 'commessa';

  function disegnaRiepilogo() {
    const info = documento(annoDi(giorno));
    const righe = $('riep-righe');
    righe.replaceChildren();
    $('riep-perimetro').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === perimetro)));
    $('riep-vista').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === vista)));
    if (!info) { $('riep-sotto').textContent = 'Le ore non sono ancora arrivate da OneDrive.'; return; }

    const d = daData(giorno);
    const prefisso = perimetro === 'mese' ? giorno.slice(0, 7) : giorno.slice(0, 4);
    const nome = perimetro === 'mese'
      ? d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })
      : String(d.getFullYear());
    const soloNumerate = $('riep-numerate').checked;

    const tot = new Map();
    let totale = 0, senzaNumero = 0;
    for (const [data, g] of info.giorni) {
      if (!data.startsWith(prefisso)) continue;
      for (const v of g.voci || []) {
        const c = info.commesse.get(v.commessaId);
        const m = Number(v.durata) || 0;
        if (!c || !c.codice) senzaNumero += m;
        if (soloNumerate && !(c && c.codice)) continue;
        const chiave = vista === 'commessa' ? v.commessaId : (c && c.cliente) || '';
        tot.set(chiave, (tot.get(chiave) || 0) + m);
        totale += m;
      }
    }

    $('riep-sotto').textContent = `${nome.charAt(0).toUpperCase() + nome.slice(1)} · ${fmt(totale)} h`;
    const ordinate = [...tot.entries()].sort((a, b) => b[1] - a[1] ||
      String(a[0]).localeCompare(String(b[0]), 'it'));
    const colori = tinte(ordinate.map(([k]) => k), k => vista === 'commessa' ? etichettaDi(info, k) : String(k || 'senza cliente'));
    for (const [k, m] of ordinate) {
      const r = el('div', 'riep-riga');
      const etichetta = vista === 'commessa' ? etichettaDi(info, k) : (k || 'senza cliente');
      r.append(el('span', null, etichetta), el('span', 'n', `${fmt(m)} h`),
        el('span', 'p', `${Math.round((m / totale) * 100)}%`));
      const barra = el('span', 'barra');
      const i = el('i');
      coloraVoce(i, colori.get(k), false);
      i.style.width = `${(m / ordinate[0][1]) * 100}%`;
      barra.append(i);
      r.append(barra);
      righe.append(r);
    }
    if (!ordinate.length) righe.append(el('p', 'riep-piede', 'Nessuna ora in questo periodo.'));

    // In fondo: le ore lavorative ancora vuote fino a oggi e le voci senza numero.
    let vuote = 0;
    const fino = oggi();
    const x = perimetro === 'mese' ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(d.getFullYear(), 0, 1);
    for (; aData(x).startsWith(prefisso) && aData(x) <= fino; x.setDate(x.getDate() + 1)) {
      if (festivo(x)) continue;
      vuote += Math.max(0, GIORNATA - minutiGiorno(info.giorni.get(aData(x))));
    }
    $('riep-piede').textContent = `Ore vuote nei giorni lavorativi fino a oggi: ${fmt(vuote)} h · ` +
      `voci senza numero di commessa: ${fmt(senzaNumero)} h`;
  }

  // ─────────────── le schede Ore e Laser

  function mostraScheda(nome) {
    document.body.classList.toggle('vista-ore', nome === 'ore');
    document.body.classList.toggle('vista-laser', nome === 'laser');
    $('titolo').textContent = nome === 'ore' ? 'Ore' : 'Laser Servo-Robot';
    document.querySelectorAll('.schede button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.scheda === nome)));
    scriviLocale(CHIAVE_SCHEDA, nome);
  }

  // ─────────────── avvio

  function avvia() {
    document.querySelectorAll('.schede button').forEach(b =>
      b.addEventListener('click', () => mostraScheda(b.dataset.scheda)));
    mostraScheda(leggi(CHIAVE_SCHEDA) === 'laser' ? 'laser' : 'ore');

    $('ore-prima').addEventListener('click', () => vaiA(spostaLavorativo(giorno, -1)));
    $('ore-dopo').addEventListener('click', () => vaiA(spostaLavorativo(giorno, 1)));
    $('ore-oggi').addEventListener('click', () => vaiA(oggi()));
    $('ore-annulla').addEventListener('click', annulla);
    $('ore-rifai').addEventListener('click', rifai);

    // Scorrere col dito di lato cambia giorno.
    let tocco = null;
    $('ore-slot').addEventListener('touchstart', e => {
      const t = e.touches[0];
      tocco = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    $('ore-slot').addEventListener('touchend', e => {
      if (!tocco) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tocco.x, dy = t.clientY - tocco.y;
      tocco = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) vaiA(spostaLavorativo(giorno, dx < 0 ? 1 : -1));
    });

    $('ore-cerca').addEventListener('input', () => { evidenziata = 0; disegnaProposte(); });
    $('ore-cerca').addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = righeProposte.length;
        if (n) evidenziata = (evidenziata + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        disegnaProposte();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if ($('ore-cerca').value.trim()) scegli(evidenziata);
      }
    });
    $('ore-svuota').addEventListener('click', () => { imposta(null); disegna(); });
    $('ore-dividi').addEventListener('click', () => { dividiORiunisci(); disegna(); });
    $('ore-fine').addEventListener('click', chiudiScelta);
    $('scheda-ore').addEventListener('click', e => { if (e.target === $('scheda-ore')) chiudiScelta(); });
    $('scheda-ore').addEventListener('close', () => { scelta = null; disegnaSlot(); });

    $('ore-riepilogo').addEventListener('click', () => { disegnaRiepilogo(); $('riepilogo-ore').showModal(); });
    $('riepilogo-ore').addEventListener('click', e => { if (e.target === $('riepilogo-ore')) $('riepilogo-ore').close(); });
    $('riep-perimetro').addEventListener('click', e => {
      const b = e.target.closest('button'); if (b) { perimetro = b.dataset.v; disegnaRiepilogo(); }
    });
    $('riep-vista').addEventListener('click', e => {
      const b = e.target.closest('button'); if (b) { vista = b.dataset.v; disegnaRiepilogo(); }
    });
    $('riep-numerate').addEventListener('change', disegnaRiepilogo);

    // Sul PC, Ctrl+Z e Ctrl+Y fuori dai campi di testo; le frecce cambiano giorno.
    document.addEventListener('keydown', e => {
      if (!document.body.classList.contains('vista-ore') || document.querySelector('dialog[open]')) return;
      if (e.target.closest('input, textarea')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); annulla(); }
      else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); rifai(); }
      else if (!ctrl && e.key === 'ArrowLeft') vaiA(spostaLavorativo(giorno, -1));
      else if (!ctrl && e.key === 'ArrowRight') vaiA(spostaLavorativo(giorno, 1));
    });

    // A mezzanotte «oggi» cambia: la targhetta va spostata da sé.
    let ieri = oggi();
    setInterval(() => { if (oggi() !== ieri) { ieri = oggi(); disegna(); } }, 60 * 1000);

    // Gli anni con modifiche non ancora inviate si sincronizzano anche se non si guardano.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const m = /^rd\.ore\.v1\.(\d{4})$/.exec(k || '');
        if (m && inAttesa(statoAnno(Number(m[1])))) anniAperti.add(Number(m[1]));
      }
    } catch (_) {}

    onedrive.registra(sincronizza);
    vaiA(giorno);
  }

  return { avvia, disegna };
})();

ore.avvia();
