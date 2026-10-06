'use strict';

// ════════════════════════════════════════════════ Ore
//
// Il modulo Ore di App gestione R&D, versione web. Legge e scrive lo
// stesso file dell'app desktop, «Ore/ore_<anno>.json» su OneDrive
// (…\OneDrive - Tiesserobot\Ore\ sul PC), così le due versioni lavorano sugli stessi
// dati. Il comportamento viene da HANDOFF-ORE.md. Sul PC c'è la griglia del mese
// (5 settimane × 5 giorni) con tastiera, trascinamento e copia/incolla; sul telefono,
// che a 400 px non ha posto per cinque colonne, una giornata per schermata.
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

  const coloreCss = tinta => `hsl(${tinta * (360 / TINTE) + 12} 60% 58%)`;

  // ─────────────── le mezz'ore
  //
  // Per spostare, allungare e incollare la giornata si guarda come sedici mezz'ore
  // (H[0] = 08:00–08:30 … H[15] = 17:00–17:30): un blocco è una corsa di mezz'ore di
  // fila con la stessa voce, dentro la stessa sessione. La pausa non si attraversa.

  const metàDi = righe => righe.flatMap(h => h.meta);
  const sessioneDi = m => (m < 8 ? 0 : 1);
  const limiti = m => [sessioneDi(m) * 8, sessioneDi(m) * 8 + 7];
  const metàDiCella = (h, i, k) => (h.diviso ? [2 * i + (k || 0)] : [2 * i, 2 * i + 1]);
  const inizioMetà = m => INIZI[m >> 1] + (m & 1) * 30;

  /** Le righe con sopra le mezz'ore nuove; un'ora divisa resta divisa. */
  function daMetà(righe, H) {
    return righe.map((h, i) => {
      const a = H[2 * i], b = H[2 * i + 1];
      if (a === h.meta[0] && b === h.meta[1]) return h;
      return { inizio: h.inizio, diviso: h.diviso || a !== b, meta: [a, b], orig: h.orig };
    });
  }

  function corsa(H, m) {
    const id = H[m];
    if (!id) return null;
    const [s, e] = limiti(m);
    let a = m, b = m;
    while (a > s && H[a - 1] === id) a--;
    while (b < e && H[b + 1] === id) b++;
    return { id, a, b };
  }

  // Allungare dalla presa: a scatti di mezz'ora, mai oltre la fine della sessione, e un
  // blocco pieno cede solo se lo si copre tutto; altrimenti ci si ferma prima.
  function allunga(H, corsaDa, fine) {
    const N = [...H];
    const { id, a, b } = corsaDa;
    const [, e] = limiti(a);
    fine = Math.max(a, Math.min(fine, e));
    for (let m = fine + 1; m <= b; m++) N[m] = null;
    for (let m = b + 1; m <= fine;) {
      if (!N[m]) { N[m] = id; m++; continue; }
      const altra = corsa(N, m);
      if (altra.b > fine) break;
      for (let x = altra.a; x <= altra.b; x++) N[x] = id;
      m = altra.b + 1;
    }
    return N;
  }

  // L'orario lo decide il cursore, con lo scatto alla mezz'ora; la pausa non si
  // attraversa: un blocco da due ore lasciato sulle 11:30 comincia alle 10:00.
  function dove(metàCursore, presa, lunghezza) {
    const [s, e] = limiti(metàCursore);
    return Math.max(s, Math.min(metàCursore - presa, e - lunghezza + 1));
  }

  /** Stesso giorno: sposta, tutto o niente. */
  function sposta(H, { id, a, b }, t) {
    const N = [...H];
    for (let m = a; m <= b; m++) N[m] = null;
    for (let k = 0; k <= b - a; k++) if (N[t + k]) return null;
    for (let k = 0; k <= b - a; k++) N[t + k] = id;
    return N;
  }

  /** Altro giorno (e incolla): copia la parte che entra, fino al primo pieno. */
  function copiaIn(H, id, lunghezza, t) {
    const N = [...H];
    const [, e] = limiti(t);
    let n = 0;
    for (let k = 0; k < lunghezza && t + k <= e && !N[t + k]; k++, n++) N[t + k] = id;
    return n ? N : null;
  }

  // ─────────────── stato della vista

  let giorno = feriale(leggi(CHIAVE_GIORNO) || oggi());
  let mese = giorno.slice(0, 7);   // il mese della griglia sul PC
  let scelta = null;               // { data, ora: 0–7, meta: 0 | 1 | null }
  let accorpata = false;
  let appunti = null;              // { tipo: 'slot', id, lunghezza } | { tipo: 'giorno', voci }
  let anteprima = null;            // { data, H } mentre si allunga un blocco
  let ricerca = '';
  const storia = [];               // passi: [{ anno, data, prima, dopo }]
  let futuro = [];
  const daGiocare = [];            // effetti che aspettano il disegno

  const pc = window.matchMedia('(min-width: 1000px)');
  const suPc = () => pc.matches;

  const etichettaDi = (info, id) => {
    const c = info && info.commesse.get(id);
    return c ? String(c.label || c.codice || id) : String(id);
  };

  function infoGiorno(data) {
    const info = documento(annoDi(data));
    const g = info ? info.giorni.get(data) || null : null;
    return { info, g };
  }

  function righeDi(data) {
    const { info, g } = infoGiorno(data);
    const r = grigliaDi(data, g);
    if (anteprima && anteprima.data === data) r.ore = daMetà(r.ore, anteprima.H);
    return { ...r, info, g };
  }

  const minutiDi = data => minutiGiorno(infoGiorno(data).g);

  function avvisa(testo) {
    if (suPc() && document.body.classList.contains('vista-ore')) {
      const m = $('mese-msg');
      m.textContent = testo;
      clearTimeout(avvisa.t);
      avvisa.t = setTimeout(() => { m.textContent = ''; }, 4000);
    } else {
      mostraMessaggio(testo);
    }
  }

  // ─────────────── gli effetti, dopo il disegno

  const cellaDi = (data, ora, meta) =>
    document.querySelector(`.cella[data-data="${data}"][data-ora="${ora}"][data-meta="${meta == null ? '' : meta}"]`);
  const colonnaDi = data => (suPc()
    ? document.querySelector(`.giorno-col[data-giorno="${data}"]`)
    : (data === giorno ? $('ore-slot') : null));
  const rettDi = el => (el && el.getBoundingClientRect ? el.getBoundingClientRect() : el || null);
  const schermo = () => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });

  function effetto(tipo, trova, opzioni) { daGiocare.push({ tipo, trova, opzioni }); }

  function giocaEffetti() {
    const lista = daGiocare.splice(0);
    if (!lista.length) return;
    requestAnimationFrame(() => {
      for (const e of lista) {
        const r = rettDi(e.trova());
        const op = e.opzioni && e.opzioni.da ? { ...e.opzioni, da: rettDi(e.opzioni.da()) || r } : e.opzioni;
        if (r && r.width) effetti.gioca(e.tipo, r, op);
      }
    });
  }

  // ─────────────── modificare

  const settimanaDi = data => {
    const out = [];
    let d = lunedi(data);
    for (let i = 0; i < 5; i++, d = spostaLavorativo(d, 1)) out.push(d);
    return out;
  };
  const settimanaPiena = data => settimanaDi(data).every(d => minutiDi(d) === GIORNATA);

  // Il mese è quello della targa: le 25 giornate della griglia. Una giornata a cavallo
  // può stare in due griglie (fine settembre è anche nella griglia di ottobre): conta
  // quella che si completa.
  function mesiCon(data) {
    const d = daData(data.slice(0, 7) + '-01');
    const out = [];
    for (const passo of [-1, 0, 1]) {
      const x = new Date(d.getFullYear(), d.getMonth() + passo, 1);
      const m = aData(x).slice(0, 7);
      if (giorniGriglia(m).includes(data)) out.push(m);
    }
    return out;
  }
  const meseCompleto = m => giorniGriglia(m).every(d => minutiDi(d) === GIORNATA);
  const mesiCompleti = data => mesiCon(data).filter(meseCompleto);

  /** Un passo della storia: le giornate com'erano prima e dopo. */
  function applicaPasso(giorni, quale) {
    for (const p of giorni) {
      statoAnno(p.anno).modifiche[p.data] = p[quale];
      cambiato(p.anno);
    }
  }

  function cambiaGiornata(data, voci, { registra = true } = {}) {
    const anno = annoDi(data);
    const { info, g } = infoGiorno(data);
    if (!info || info.solaLettura) return false;
    const prima = g && Array.isArray(g.voci) ? g.voci : [];
    if (JSON.stringify(prima) === JSON.stringify(voci)) return false;

    const eraPiena = minutiGiorno(g) === GIORNATA;
    const eraSettimana = settimanaPiena(data);
    const eranoMesi = mesiCompleti(data);
    if (registra) {
      storia.push([{ anno, data, prima, dopo: voci }]);
      if (storia.length > PASSI_STORIA) storia.shift();
      futuro = [];
    }
    statoAnno(anno).modifiche[data] = voci;
    cambiato(anno);

    // Le feste a tutto schermo, una sola: il mese copre la settimana, che copre la giornata.
    if (mesiCompleti(data).some(m => !eranoMesi.includes(m))) {
      effetto('meseSchermo', schermo);
      avvisa('Mese completo!');
    } else if (!eraSettimana && settimanaPiena(data)) {
      effetto('settimanaSchermo', schermo);
      avvisa('Settimana completa.');
    } else if (!eraPiena && minutiDi(data) === GIORNATA) {
      effetto('giornataSchermo', schermo, { da: () => colonnaDi(data) });
      avvisa('Giornata finita.');
    }
    return true;
  }

  /** Cambia le righe di una giornata; tiene a mente le ore vuote divise. */
  function modificaRighe(data, fn) {
    const { info, g } = infoGiorno(data);
    if (!info || info.solaLettura) return false;
    const r = grigliaDi(data, g);
    if (!r.modificabile) return false;
    const nuove = fn(r.ore);
    if (!nuove) return false;
    nuove.forEach((h, i) => {
      const k = `${data}|${i}`;
      if (h.diviso && !h.meta[0] && !h.meta[1]) divise.add(k);
      else divise.delete(k);
    });
    cambiaGiornata(data, vociDa(nuove));
    return true;
  }

  const scriviMetà = (data, H) => modificaRighe(data, ore => daMetà(ore, H));

  function imposta(slot, id) {
    const fatto = modificaRighe(slot.data, ore => {
      const H = metàDi(ore);
      for (const m of metàDiCella(ore[slot.ora], slot.ora, slot.meta)) H[m] = id;
      return daMetà(ore, H);
    });
    if (!fatto) return;
    const { info } = infoGiorno(slot.data);
    const tinta = id ? tinte(metàDi(righeDi(slot.data).ore), x => etichettaDi(info, x)).get(id) : 0;
    effetto(id ? 'scrivi' : 'cancella', () => cellaDi(slot.data, slot.ora, slot.meta), { colore: coloreCss(tinta || 0) });
  }

  function dividi(slot) {
    modificaRighe(slot.data, ore => ore.map((h, i) => {
      if (i !== slot.ora) return h;
      if (!h.diviso) return { ...h, diviso: true };
      const c = h.meta[0] || h.meta[1];
      return { ...h, diviso: false, meta: [c, c] };
    }));
    const h = righeDi(slot.data).ore[slot.ora];
    slot.meta = h.diviso ? 0 : null;
  }

  /** Lo slot dopo nella giornata; null in fondo, dove ci si ferma. */
  function slotDopo(slot, passo = 1) {
    const unità = [];
    righeDi(slot.data).ore.forEach((h, i) => {
      if (h.diviso) unità.push([i, 0], [i, 1]);
      else unità.push([i, null]);
    });
    const ora = unità.findIndex(([i, k]) => i === slot.ora && (k === slot.meta || (k === 0 && slot.meta == null)));
    const u = unità[ora + passo];
    return u ? { data: slot.data, ora: u[0], meta: u[1] } : null;
  }

  function slotAccanto(slot, passo) {
    const data = spostaLavorativo(slot.data, passo);
    const h = righeDi(data).ore[slot.ora];
    return { data, ora: slot.ora, meta: h.diviso ? (slot.meta || 0) : null };
  }

  const vociDelloSlot = slot => {
    const h = righeDi(slot.data).ore[slot.ora];
    return h.diviso ? h.meta[slot.meta || 0] : h.meta[0];
  };

  function annulla() {
    const passo = storia.pop();
    if (!passo) return;
    futuro.push(passo);
    applicaPasso(passo, 'prima');
    vaiA(passo[0].data, { tieniScelta: true });
    passo.forEach(p => effetto('annulla', () => colonnaDi(p.data)));
    avvisa('Annullato.');
    disegna();
  }

  function rifai() {
    const passo = futuro.pop();
    if (!passo) return;
    storia.push(passo);
    applicaPasso(passo, 'dopo');
    vaiA(passo[0].data, { tieniScelta: true });
    passo.forEach(p => effetto('rifai', () => colonnaDi(p.data)));
    avvisa('Rifatto.');
    disegna();
  }

  // ─────────────── copia e incolla
  //
  // Con uno slot scelto si copia lo slot, e incollandolo va sull'ora scelta, con le
  // stesse regole del trascinamento su un altro giorno; senza slot si copia la
  // giornata, e incollandola sostituisce la giornata scelta. Decide quello che c'è
  // negli appunti, non un tasto diverso.

  function copia({ giornata = false } = {}) {
    const { info, g } = infoGiorno(scelta ? scelta.data : giorno);
    if (!info) return;
    if (scelta && !giornata) {
      const id = vociDelloSlot(scelta);
      if (!id) { avvisa('Lo slot è vuoto: niente da copiare.'); return; }
      const h = righeDi(scelta.data).ore[scelta.ora];
      appunti = { tipo: 'slot', id, lunghezza: h.diviso ? 1 : 2 };
      const s = { ...scelta };
      effetto('copia', () => cellaDi(s.data, s.ora, s.meta));
      avvisa(`Copiato ${etichettaDi(info, id)}`);
      try { navigator.clipboard.writeText(etichettaDi(info, id)).catch(() => {}); } catch (_) {}
    } else {
      const data = scelta ? scelta.data : giorno;
      appunti = { tipo: 'giorno', voci: JSON.parse(JSON.stringify((g && g.voci) || [])), da: data };
      effetto('copia', () => colonnaDi(data));
      avvisa(`Copiata la giornata di ${daData(data).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}`);
    }
    disegna();
  }

  function incolla() {
    if (!appunti) { avvisa('Non c\'è niente da incollare.'); return; }
    if (appunti.tipo === 'slot') {
      if (!scelta) { avvisa('Scegli prima l\'ora su cui incollare.'); return; }
      const slot = { ...scelta };
      const righe = righeDi(slot.data).ore;
      const t = metàDiCella(righe[slot.ora], slot.ora, slot.meta)[0];
      const N = copiaIn(metàDi(righe), appunti.id, appunti.lunghezza, t);
      if (!N) { avvisa('Lo slot è occupato: svuotalo prima.'); return; }
      scriviMetà(slot.data, N);
      effetto('incolla', () => cellaDi(slot.data, slot.ora, slot.meta));
    } else {
      const data = scelta ? scelta.data : giorno;
      if (cambiaGiornata(data, JSON.parse(JSON.stringify(appunti.voci)))) {
        effetto('incolla', () => colonnaDi(data));
        avvisa('Giornata incollata.');
      }
    }
    disegna();
  }

  // ─────────────── nuove commesse

  // Un numero di commessa ha la forma 26045G04: anno, progressivo, lettera, due cifre.
  const NUMERO = /\b(\d{5}[A-Za-z]\d{2})\b/;

  function nuovaCommessa(data, testo) {
    const info = documento(annoDi(data));
    const s = statoAnno(annoDi(data));
    const label = testo.trim().replace(/\s+/g, ' ');
    const numero = (label.match(NUMERO) || [])[1];
    const base = 'c-' + (chiaro(numero || label).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'voce');
    let id = base;
    for (let n = 2; info.commesse.has(id) || s.nuove.some(c => c.id === id); n++) id = `${base}-${n}`;
    const c = {
      id, label, codice: numero ? numero.toUpperCase() : null, cliente: null,
      colore: null, alias: [], attiva: true
    };
    s.nuove.push(c);
    s.doc = null;
    return c;
  }

  // ─────────────── l'autocomplete
  //
  // Cerca su label, alias e codice, anche a metà parola. Prima chi combacia meglio
  // (esatto, poi dall'inizio, poi dentro), a pari merito chi ha più ore nel mese.

  function oreNelMese(info, prefisso) {
    const tot = new Map();
    if (!info) return tot;
    for (const [data, g] of info.giorni) {
      if (!data.startsWith(prefisso)) continue;
      for (const v of g.voci || []) tot.set(v.commessaId, (tot.get(v.commessaId) || 0) + (Number(v.durata) || 0));
    }
    return tot;
  }

  function proposte(info, data, query, idsGiorno) {
    const q = chiaro(query.trim());
    const mese = oreNelMese(info, data.slice(0, 7));
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

  /**
   * Disegna l'elenco delle proposte per uno slot e restituisce le azioni, una per riga
   * (l'ultima può essere «Nuova voce»). Lo usano il pannello del telefono e il campo
   * del PC.
   */
  function disegnaElenco(lista, slot, query, evidenziata, scegliFn) {
    lista.replaceChildren();
    const { info, ore: righe } = righeDi(slot.data);
    if (!info) return [];
    const idsGiorno = metàDi(righe).filter(Boolean);
    const { righe: trovate, mese } = proposte(info, slot.data, query, idsGiorno);
    const colori = tinte([...idsGiorno, ...trovate.map(t => t.c.id)], id => etichettaDi(info, id));
    const attuale = vociDelloSlot(slot);
    const testo = query.trim();
    const esatta = trovate.some(t => t.punti === 0);
    const azioni = trovate.map(t => () => imposta(slot, t.c.id));
    if (testo && !esatta) azioni.push(() => imposta(slot, nuovaCommessa(slot.data, testo).id));

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
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => scegliFn(i));
      li.append(b);
      lista.append(li);
    });
    if (testo && !esatta) {
      const li = el('li');
      const b = el('button', 'nuova' + (evidenziata === trovate.length ? ' attiva' : ''), `Nuova voce «${testo}»`);
      b.type = 'button';
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => scegliFn(trovate.length));
      li.append(b);
      lista.append(li);
    }
    if (!testo && trovate.length === 0) {
      lista.append(el('li', 'riep-piede', 'Scrivi per cercare una commessa o crearne una nuova.'));
    }
    return azioni;
  }

  /** La commessa che corrisponde esattamente al testo (label, alias o codice). */
  function esatta(data, testo) {
    const info = documento(annoDi(data));
    const q = chiaro(testo.trim());
    if (!info || !q) return null;
    for (const c of info.commesse.values()) {
      const valori = [c.label, c.codice, ...(Array.isArray(c.alias) ? c.alias : [])];
      if (valori.some(v => v && chiaro(String(v)) === q)) return c.id;
    }
    return null;
  }

  // ─────────────── la ricerca
  //
  // Cerca su label, alias, codice e cliente in tutti gli anni che ci sono su OneDrive,
  // e dice dove compare il risultato, giornata per giornata, con la somma delle ore.
  // Sul PC spegne anche gli slot della griglia che non corrispondono.

  let anniCaricati = false;
  async function caricaAnniPerRicerca() {
    if (anniCaricati || !onedrive.collegato()) return;
    anniCaricati = true;
    const quest = new Date().getFullYear();
    for (let a = quest; a >= quest - 6; a--) {
      const s = statoAnno(a);
      if (s.testo || anniAperti.has(a)) continue;
      try {
        const f = await onedrive.leggiFile(percorso(a));
        if (f) { s.testo = f.testo; s.eTag = f.eTag; s.doc = null; salvaAnno(a); }
      } catch (_) {}
    }
    disegnaRisultati();
  }

  function corrisponde(c, q) {
    if (!c || !q) return false;
    return [c.label, c.codice, c.cliente, ...(Array.isArray(c.alias) ? c.alias : [])]
      .some(v => v && chiaro(String(v)).includes(q));
  }

  function risultati(query) {
    const q = chiaro(query.trim());
    const perVoce = new Map();
    const giorni = [];
    let totale = 0;
    if (!q) return { totale, perVoce: [], giorni };
    const anniNoti = [...anni.keys()].sort((a, b) => b - a);
    for (const anno of anniNoti) {
      const info = documento(anno);
      if (!info) continue;
      const ids = new Set([...info.commesse.values()].filter(c => corrisponde(c, q)).map(c => c.id));
      if (!ids.size) continue;
      for (const [data, g] of info.giorni) {
        let min = 0;
        const voci = new Map();
        for (const v of g.voci || []) {
          if (!ids.has(v.commessaId)) continue;
          const d = Number(v.durata) || 0;
          min += d;
          const etichetta = etichettaDi(info, v.commessaId);
          voci.set(etichetta, (voci.get(etichetta) || 0) + d);
          perVoce.set(etichetta, (perVoce.get(etichetta) || 0) + d);
        }
        if (min) { giorni.push({ data, min, voci }); totale += min; }
      }
    }
    giorni.sort((a, b) => (a.data < b.data ? 1 : -1));
    return { totale, perVoce: [...perVoce.entries()].sort((a, b) => b[1] - a[1]), giorni };
  }

  function disegnaRisultati() {
    const box = suPc() ? $('mese-risultati') : $('ricerca-risultati');
    const query = suPc() ? $('mese-cerca').value : $('ricerca-testo').value;
    box.replaceChildren();
    if (suPc()) box.hidden = !query.trim();
    if (!query.trim()) return;

    const r = risultati(query);
    const testa = el('div', 'ris-testa');
    testa.append(el('b', null, `${fmt(r.totale)} h`),
      ` in ${r.giorni.length} ${r.giorni.length === 1 ? 'giornata' : 'giornate'}`);
    if (r.perVoce.length > 1) testa.append(` · ${r.perVoce.length} voci`);
    box.append(testa);
    if (suPc()) $('mese-msg').textContent = `«${query.trim()}»: ${fmt(r.totale)} h in ${r.giorni.length} giornate`;
    if (!r.giorni.length) {
      box.append(el('p', 'riep-piede', anniCaricati ? 'Nessuna occorrenza.' : 'Nessuna occorrenza negli anni caricati.'));
      return;
    }

    const voci = el('div', 'ris-voci');
    for (const [etichetta, m] of r.perVoce) {
      const riga = el('div', 'ris-voce');
      riga.append(el('span', null, etichetta), el('span', 'n', `${fmt(m)} h`));
      voci.append(riga);
    }
    box.append(voci);

    const elenco = el('div', 'ris-giorni');
    let meseCorrente = null, testaMese = null, totMese = 0;
    const chiudiMese = () => { if (testaMese) testaMese.lastChild.textContent = `${fmt(totMese)} h`; };
    for (const gg of r.giorni.slice(0, 400)) {
      const m = gg.data.slice(0, 7);
      if (m !== meseCorrente) {
        chiudiMese();
        meseCorrente = m;
        totMese = 0;
        const nome = daData(gg.data).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
        testaMese = el('div', 'ris-mese');
        testaMese.append(el('span', null, nome.charAt(0).toUpperCase() + nome.slice(1)), el('span', 'n', ''));
        elenco.append(testaMese);
      }
      totMese += gg.min;
      const b = el('button', 'ris-giorno');
      b.type = 'button';
      b.append(el('span', 'quando', daData(gg.data).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })),
        el('span', 'cosa', [...gg.voci.keys()].join(', ')), el('span', 'n', `${fmt(gg.min)} h`));
      b.addEventListener('click', () => {
        if (!suPc()) $('ricerca-ore').close();
        mese = gg.data.slice(0, 7);
        vaiA(gg.data);
      });
      elenco.append(b);
    }
    chiudiMese();
    box.append(elenco);
  }

  let timerRicerca = null;
  function cercaDopo(testo) {
    clearTimeout(timerRicerca);
    timerRicerca = setTimeout(() => {
      ricerca = chiaro(testo.trim());
      caricaAnniPerRicerca();
      disegna();
      disegnaRisultati();
    }, 180);
  }

  // ─────────────── disegnare

  function vaiA(data, { tieniScelta = false } = {}) {
    giorno = feriale(data);
    scriviLocale(CHIAVE_GIORNO, giorno);
    if (!tieniScelta && scelta && scelta.data !== giorno && !$('scheda-ore').open) scelta = null;
    if (!suPc() || !giorniGriglia(mese).includes(giorno)) mese = giorno.slice(0, 7);
    for (const d of [...giorniGriglia(mese), ...settimanaDi(giorno)]) apriAnno(annoDi(d));
    disegna();
  }

  /** Le 25 giornate della griglia: cinque settimane dalla prima lavorativa del mese. */
  function giorniGriglia(m) {
    const [y, mm] = m.split('-').map(Number);
    const primo = new Date(y, mm - 1, 1);
    while (festivo(primo)) primo.setDate(primo.getDate() + 1);
    const out = [];
    let d = lunedi(aData(primo));
    for (let i = 0; i < 25; i++, d = spostaLavorativo(d, 1)) out.push(d);
    return out;
  }

  function disegna() {
    document.body.classList.toggle('ore-pc', suPc());
    disegnaTarga();
    // Una vista sola alla volta nel DOM: le celle dell'altra confonderebbero i clic.
    if (suPc()) { $('ore-slot').replaceChildren(); disegnaMese(); }
    else { $('mese-griglia').replaceChildren(); disegnaTelefono(); }
    if ($('scheda-ore').open) disegnaProposte();
    if ($('riepilogo-ore').open) disegnaRiepilogo();
    for (const id of ['ore-annulla', 'mese-annulla']) $(id).disabled = storia.length === 0;
    for (const id of ['ore-rifai', 'mese-rifai']) $(id).disabled = futuro.length === 0;
    $('ore-incolla').disabled = !appunti || appunti.tipo !== 'giorno';
    $('ore-oggi').hidden = giorno === feriale(oggi());
    if ($('ore-campo').hidden === false) posizionaCampo();
    giocaEffetti();
  }

  function disegnaTarga() {
    const giorni = giorniGriglia(mese);
    const nomeMese = daData(mese + '-01').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    const testa = nomeMese.charAt(0).toUpperCase() + nomeMese.slice(1);
    const pronti = giorni.every(d => documento(annoDi(d)));
    for (const targa of [$('targa-ore'), $('mese-targa')]) {
      targa.replaceChildren();
      if (targa.id === 'targa-ore') targa.append(testa + ' · ');
      if (!pronti) { targa.append('…'); continue; }
      // Le 25 giornate della griglia, otto ore ciascuna: come l'app sul PC.
      const fatte = giorni.reduce((t, d) => t + minutiDi(d), 0);
      const obiettivo = giorni.length * GIORNATA;
      targa.append(el('b', null, fmt(fatte)), ` / ${fmt(obiettivo)} h`);
      if (obiettivo > fatte) targa.append(' · ', el('span', 'da-fare', `${fmt(obiettivo - fatte)} da fare`));
      else targa.append(' · ', el('span', 'fatto', 'completo'));
    }
  }

  // ─────────────── una giornata, sul telefono o in una colonna del PC

  function disegnaGiornata(data, box, { compatto = false } = {}) {
    box.replaceChildren();
    const { info, ore: righe, modificabile } = righeDi(data);
    if (!info) return { info, modificabile };
    const sola = info.solaLettura || !modificabile;
    box.classList.toggle('sola-lettura', sola);

    const H = metàDi(righe);
    const colori = tinte(H, id => etichettaDi(info, id));
    const totali = new Map();
    for (const id of H) if (id) totali.set(id, (totali.get(id) || 0) + 30);
    const spenta = id => ricerca && !(id && corrisponde(info.commesse.get(id), ricerca));

    let indice = 0;
    SESSIONI.forEach((sessione, n) => {
      if (n > 0) {
        const p = el('div', 'pausa');
        if (!compatto) p.append(el('span', null, 'pausa'));
        box.append(p);
      }
      const blocco = el('div', 'sessione');
      const primo = indice, ultimo = indice + sessione.length - 1;
      for (; indice <= ultimo; indice++) {
        const h = righe[indice];
        const prec = indice > primo ? righe[indice - 1] : null;
        // Le ore di fila con la stessa voce sono un blocco: le righe dentro il blocco
        // non ripetono il nome, e la prima dice l'intervallo.
        const continua = prec && h.meta[0] && !h.diviso && !prec.diviso && prec.meta[0] === h.meta[0];
        let fine = indice;
        while (h.meta[0] && !h.diviso && fine < ultimo && !righe[fine + 1].diviso && righe[fine + 1].meta[0] === h.meta[0]) fine++;

        const riga = el('div', 'ora' + (continua ? ' dentro' : ''));
        riga.append(el('div', 'quando', testoOra(h.inizio)));
        const metà = el('div', 'metà');
        for (const k of h.diviso ? [0, 1] : [null]) {
          const c = h.meta[k || 0];
          const cella = el('div', 'cella' + (c ? '' : ' vuota'));
          cella.dataset.data = data;
          cella.dataset.ora = String(indice);
          cella.dataset.meta = k == null ? '' : String(k);
          cella.tabIndex = -1;
          cella.setAttribute('role', 'button');
          if (c) {
            coloraVoce(cella, colori.get(c));
            const tipo = assenza(etichettaDi(info, c));
            if (tipo) cella.classList.add('assenza', tipo);
          }
          if (spenta(c)) cella.classList.add('spenta');
          if (scelta && scelta.data === data && scelta.ora === indice && (scelta.meta ?? null) === k) cella.classList.add('scelta');

          const da = h.inizio + 30 * (k || 0);
          const a = h.diviso ? da + 30 : righe[fine].inizio + 60;
          if (c && !continua) {
            cella.append(el('span', 'nome', etichettaDi(info, c)));
            if (!compatto && (h.diviso || fine > indice)) cella.append(el('span', 'intervallo', `${testoOra(da)}–${testoOra(a)}`));
            const t = el('span', 'tot', fmt(totali.get(c)));
            cella.append(t);
            cella.title = `${etichettaDi(info, c)} · ${testoOra(da)}–${testoOra(a)} · ${fmt(totali.get(c))} h in tutta la giornata`;
          } else if (!c) {
            cella.append(el('span', 'nome', compatto ? '' : (h.diviso ? `${testoOra(da)} vuota` : 'vuota')));
          } else {
            cella.title = `${etichettaDi(info, c)} · ${fmt(totali.get(c))} h in tutta la giornata`;
          }

          // La presa per allungare: al centro del bordo inferiore, sull'ultima cella del blocco.
          if (c && !sola) {
            const ultimaMetà = metàDiCella(h, indice, k).slice(-1)[0];
            if (ultimaMetà === 15 || ultimaMetà === 7 || H[ultimaMetà + 1] !== c) cella.append(el('span', 'presa'));
          }
          cella.setAttribute('aria-label', `${testoOra(da)}: ${c ? etichettaDi(info, c) : 'vuota'}`);
          metà.append(cella);
        }
        riga.append(metà);
        blocco.append(riga);
      }
      box.append(blocco);
    });
    return { info, modificabile };
  }

  // La vista accorpata: una riga per voce con le ore sommate, alta in proporzione,
  // con la stessa scala degli slot. Si somma per singola giornata.
  function disegnaAccorpata(data, box) {
    box.replaceChildren();
    const { info, g } = infoGiorno(data);
    if (!info) return;
    const tot = new Map();
    for (const v of (g && g.voci) || []) tot.set(v.commessaId, (tot.get(v.commessaId) || 0) + (Number(v.durata) || 0));
    const voci = [...tot.entries()].sort((a, b) => b[1] - a[1] ||
      etichettaDi(info, a[0]).localeCompare(etichettaDi(info, b[0]), 'it'));
    const colori = tinte(voci.map(v => v[0]), id => etichettaDi(info, id));
    const corpo = el('div', 'accorpata');
    for (const [id, m] of voci) {
      const r = el('div', 'cella accorpo');
      coloraVoce(r, colori.get(id));
      const tipo = assenza(etichettaDi(info, id));
      if (tipo) r.classList.add('assenza', tipo);
      if (ricerca && !corrisponde(info.commesse.get(id), ricerca)) r.classList.add('spenta');
      r.style.height = `calc(var(--ora) * ${m / 60})`;
      r.append(el('span', 'nome', etichettaDi(info, id)), el('span', 'tot', fmt(m)));
      corpo.append(r);
    }
    box.append(corpo);
  }

  // ─────────────── il telefono: una giornata per schermata

  function disegnaTelefono() {
    const d = daData(giorno);
    const testo = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    $('ore-data-testo').textContent = testo.charAt(0).toUpperCase() + testo.slice(1);
    const { info, g } = infoGiorno(giorno);
    const tot = $('ore-totale');
    const m = minutiGiorno(g);
    tot.textContent = info ? `${fmt(m)} / ${fmt(GIORNATA)} h` : '';
    tot.className = m === GIORNATA ? 'pieno' : 'meno';
    const nota = $('ore-nota');
    nota.hidden = !(g && g.nota);
    nota.textContent = g && g.nota ? g.nota : '';

    disegnaSettimana();

    const anno = annoDi(giorno);
    const s = statoAnno(anno);
    if (!info) {
      $('ore-slot').replaceChildren();
      avvisoAnno(anno, s);
    } else {
      const { modificabile } = disegnaGiornata(giorno, $('ore-slot'));
      if (info.solaLettura) disegnaAvviso('Il file è in un formato più nuovo di questa app: le ore si possono solo guardare.', 'errore-ore');
      else if (!modificabile) disegnaAvviso('Questa giornata ha voci che qui non si possono rappresentare (orari fuori dagli slot o più fini della mezz\'ora): modificala dal PC.');
      else disegnaAvviso('');
    }
    adattaTelefono();
  }

  function avvisoAnno(anno, s, box = $('ore-avviso')) {
    if (s.manca) {
      disegnaAvviso(`Non trovo il file ${percorso(anno)} sul tuo OneDrive. Se l'app sul PC salva altrove, ` +
        `la cartella va cambiata in ORE_CONFIG; altrimenti si può crearlo adesso.`, '', {
        testo: `Crea ore_${anno}.json`,
        azione: () => { s.creare = true; salvaAnno(anno); onedrive.sincronizza(); }
      }, box);
    } else if (s.errore) {
      disegnaAvviso(s.errore, 'errore-ore', null, box);
    } else {
      disegnaAvviso('Carico le ore da OneDrive…', '', null, box);
    }
  }

  // L'altezza delle righe si adatta perché la giornata intera stia nello schermo senza
  // scorrere: si misura dove comincia e quanto resta sotto.
  function adattaTelefono() {
    const slot = $('ore-slot');
    if (!slot.offsetParent) return;
    const sopra = slot.getBoundingClientRect().top + window.scrollY;
    const sotto = $('ore-comandi').offsetHeight + 12 +
      parseFloat(getComputedStyle(document.body).paddingBottom || '0');
    const pausa = 30, bordi = 6;
    const h = Math.floor((window.innerHeight - sopra - sotto - pausa - bordi) / 8);
    slot.style.setProperty('--ora', `${Math.max(30, Math.min(52, h))}px`);
  }

  function disegnaSettimana() {
    const box = $('ore-settimana');
    box.replaceChildren();
    for (const data of settimanaDi(giorno)) {
      const d = daData(data);
      const { info, g } = infoGiorno(data);
      const b = el('button');
      b.type = 'button';
      if (data === giorno) b.setAttribute('aria-current', 'date');
      if (data === oggi()) b.classList.add('oggi');
      b.append(el('span', null, d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '')));
      b.append(el('span', 'num', String(d.getDate())));
      const m = info ? minutiGiorno(g) : null;
      b.append(el('span', 'tot ' + (m === GIORNATA ? 'pieno' : m ? 'meno' : ''), m == null ? '' : m ? fmt(m) : '—'));
      b.addEventListener('click', () => vaiA(data));
      box.append(b);
    }
  }

  function disegnaAvviso(testo, classe, pulsante, box = $('ore-avviso')) {
    box.hidden = !testo;
    box.className = 'ore-avviso' + (classe ? ' ' + classe : '');
    box.replaceChildren();
    if (!testo) return;
    box.append(testo);
    if (pulsante) {
      const b = el('button', 'primario', pulsante.testo);
      b.type = 'button';
      b.addEventListener('click', pulsante.azione);
      box.append(b);
    }
  }

  // ─────────────── il PC: la griglia del mese

  function disegnaMese() {
    const nome = daData(mese + '-01').toLocaleDateString('it-IT', { month: 'long' });
    $('mese-nome').textContent = nome.charAt(0).toUpperCase() + nome.slice(1);
    $('mese-anno').textContent = mese.slice(0, 4);
    $('mese-accorpa').setAttribute('aria-pressed', String(accorpata));

    const giorni = giorniGriglia(mese);
    const anno = annoDi(giorni[12]);
    const s = statoAnno(anno);
    if (documento(anno)) disegnaAvviso('', '', null, $('mese-avviso'));
    else avvisoAnno(anno, s, $('mese-avviso'));

    const griglia = $('mese-griglia');
    griglia.replaceChildren();
    for (let w = 0; w < 5; w++) {
      const riga = el('div', 'settimana');
      riga.dataset.lunedi = giorni[w * 5];
      for (const data of giorni.slice(w * 5, w * 5 + 5)) {
        const d = daData(data);
        const col = el('div', 'giorno-col');
        col.dataset.giorno = data;
        if (data.slice(0, 7) !== mese) col.classList.add('fuori');
        if (!scelta && data === giorno) col.classList.add('giorno-scelto');

        const { info, g } = infoGiorno(data);
        const testa = el('button', 'giorno-testa');
        testa.type = 'button';
        testa.dataset.giorno = data;
        const quando = el('span', 'quando');
        quando.append(el('span', null, d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '').toUpperCase() + ' '));
        quando.append(el('span', 'num' + (data === oggi() ? ' oggi' : ''), String(d.getDate())));
        quando.append(el('span', null, ' ' + d.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '').toUpperCase()));
        testa.append(quando);
        if (g && g.nota) {
          const n = el('span', 'segno-nota', '✎');
          n.title = g.nota;
          testa.append(n);
        }
        const m = info ? minutiGiorno(g) : null;
        testa.append(el('span', 'tot ' + (m === GIORNATA ? 'pieno' : 'meno'), m == null ? '' : fmt(m)));
        col.append(testa);

        const corpo = el('div', 'giorno-corpo');
        if (accorpata) disegnaAccorpata(data, corpo);
        else disegnaGiornata(data, corpo, { compatto: true });
        col.append(corpo);
        riga.append(col);
      }
      griglia.append(riga);
    }
    adattaMese();
  }

  // La griglia sta sempre tutta nella finestra: l'altezza di uno slot si ricava da
  // quella che resta, cinque settimane di otto ore più testate e pause.
  function adattaMese() {
    const g = $('mese-griglia');
    const ora = parseFloat(getComputedStyle(g).getPropertyValue('--ora')) || 20;
    const r = g.getBoundingClientRect();
    // Quello che non sono slot (testate, pause, bordi, spazi) si misura e si toglie.
    const fisso = r.height - 40 * ora;
    const resto = window.innerHeight - (r.top + window.scrollY) - 12;
    const h = Math.floor((resto - fisso) / 40);
    g.style.setProperty('--ora', `${Math.max(14, Math.min(44, h))}px`);
  }

  // ─────────────── il pannello per scegliere la voce (telefono)

  let evidenziata = 0;
  let azioniPannello = [];

  function apriScelta(slot) {
    scelta = { ...slot };
    $('ore-cerca').value = '';
    evidenziata = 0;
    disegna();
    if (!$('scheda-ore').open) $('scheda-ore').showModal();
    disegnaProposte();
    if (window.matchMedia('(pointer: fine)').matches) $('ore-cerca').focus();
  }

  function disegnaProposte() {
    if (!scelta) return;
    const { ore: righe } = righeDi(scelta.data);
    const h = righe[scelta.ora];
    const inizio = h.inizio + (h.diviso ? 30 * (scelta.meta || 0) : 0);
    const durata = h.diviso ? 30 : 60;
    $('ore-sel').textContent = `${daData(scelta.data).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })} · ${testoOra(inizio)}–${testoOra(inizio + durata)}`;
    $('ore-dividi').textContent = h.diviso ? 'Ora intera' : '½ ora';
    const piena = !!vociDelloSlot(scelta);
    $('ore-svuota').disabled = !piena;
    $('ore-copia').disabled = !piena;
    $('ore-incolla-slot').disabled = !appunti || appunti.tipo !== 'slot';
    azioniPannello = disegnaElenco($('ore-proposte'), scelta, $('ore-cerca').value, evidenziata, scegliPannello);
    if (evidenziata >= azioniPannello.length) evidenziata = 0;
  }

  function scegliPannello(i) {
    const f = azioniPannello[i];
    if (!f) return;
    f();
    $('ore-cerca').value = '';
    evidenziata = 0;
    const dopo = slotDopo(scelta);
    if (!dopo) { $('scheda-ore').close(); disegna(); return; }
    scelta = dopo;
    disegna();
  }

  // ─────────────── il campo sopra lo slot (PC)
  //
  // Cominciare a scrivere apre il campo con quella lettera dentro e sostituisce la
  // voce; Invio o F2 lo apre con la voce che c'è, il cursore in fondo e niente
  // selezionato. Invio conferma e passa allo slot dopo restando in modifica.

  let azioniCampo = [];
  let evidenziataCampo = 0;

  function apriCampo(testo) {
    if (!scelta) return;
    const { info, modificabile } = righeDi(scelta.data);
    if (!info || info.solaLettura || !modificabile) return;
    const campo = $('ore-campo');
    campo.hidden = false;
    $('ore-campo-lista').hidden = false;
    const input = $('ore-campo-testo');
    input.value = testo;
    evidenziataCampo = 0;
    posizionaCampo();
    disegnaCampo();
    input.focus();
    input.setSelectionRange(testo.length, testo.length);
  }

  function chiudiCampo() {
    $('ore-campo').hidden = true;
    const c = scelta && cellaDi(scelta.data, scelta.ora, scelta.meta);
    if (c) c.focus({ preventScroll: true });
  }

  function posizionaCampo() {
    const c = scelta && cellaDi(scelta.data, scelta.ora, scelta.meta);
    if (!c) { $('ore-campo').hidden = true; return; }
    const r = c.getBoundingClientRect();
    const campo = $('ore-campo');
    const largo = Math.max(r.width, 300);
    campo.style.left = `${Math.min(r.left, window.innerWidth - largo - 8)}px`;
    campo.style.top = `${r.top}px`;
    campo.style.width = `${largo}px`;
    const lista = $('ore-campo-lista');
    // La tendina va sotto, o sopra se sotto non c'è posto.
    const sotto = window.innerHeight - r.bottom;
    lista.classList.toggle('sopra', sotto < 260 && r.top > sotto);
  }

  function disegnaCampo() {
    azioniCampo = disegnaElenco($('ore-campo-lista'), scelta, $('ore-campo-testo').value, evidenziataCampo, scegliCampo);
    if (evidenziataCampo >= azioniCampo.length) evidenziataCampo = 0;
  }

  function scegliCampo(i) {
    const testo = $('ore-campo-testo').value;
    if (i == null) {
      // Invio: il testo esatto di una commessa, se c'è; altrimenti la proposta evidenziata.
      const id = esatta(scelta.data, testo);
      if (!testo.trim()) imposta(scelta, null);
      else if (id) imposta(scelta, id);
      else if (azioniCampo[evidenziataCampo]) azioniCampo[evidenziataCampo]();
      else return;
    } else if (azioniCampo[i]) {
      azioniCampo[i]();
    }
    const dopo = slotDopo(scelta);
    if (!dopo) { disegna(); chiudiCampo(); return; }
    scelta = dopo;
    $('ore-campo-testo').value = '';
    evidenziataCampo = 0;
    disegna();
    posizionaCampo();
    disegnaCampo();
  }

  // ─────────────── il trascinamento
  //
  // Due gesti, distinti da dove si prende il blocco: dalla presa al centro del bordo
  // inferiore si allunga o si accorcia; dal corpo si porta altrove (stesso giorno:
  // sposta; altro giorno: copia). Col mouse parte muovendosi, col dito dopo una
  // pressione lunga. Esc lo annulla.

  let gesto = null;
  let ignoraFino = 0;   // dopo un trascinamento, il clic che lo chiude non conta

  function metàDaCella(cella, y) {
    const data = cella.dataset.data, i = Number(cella.dataset.ora);
    const k = cella.dataset.meta === '' ? null : Number(cella.dataset.meta);
    const h = righeDi(data).ore[i];
    const metà = metàDiCella(h, i, k);
    if (metà.length === 1) return { data, m: metà[0] };
    const r = cella.getBoundingClientRect();
    return { data, m: y < r.top + r.height / 2 ? metà[0] : metà[1] };
  }

  function metàDaPunto(x, y) {
    const e = document.elementFromPoint(x, y);
    const cella = e && e.closest('.cella[data-data]');
    return cella ? metàDaCella(cella, y) : null;
  }

  function rettMetà(data, m) {
    const i = m >> 1, k = m & 1;
    const intera = cellaDi(data, i, null);
    if (intera) {
      const r = intera.getBoundingClientRect();
      const meta = r.height / 2;
      return { left: r.left, width: r.width, top: r.top + k * meta, height: meta, bottom: r.top + (k + 1) * meta };
    }
    const c = cellaDi(data, i, k);
    return c ? c.getBoundingClientRect() : null;
  }

  function giùPuntatore(e) {
    const cella = e.target.closest('.cella[data-data]');
    if (!cella || e.button > 0 || accorpata) return;
    const { info, modificabile, ore: righe } = righeDi(cella.dataset.data);
    if (!info || info.solaLettura || !modificabile) return;
    const { data, m } = metàDaCella(cella, e.clientY);
    const c = corsa(metàDi(righe), m);
    if (!c) return;

    if (e.target.closest('.presa')) {
      e.preventDefault();
      gesto = { tipo: 'allunga', data, corsa: c, fine: c.b, puntatore: e.pointerId };
      return;
    }
    gesto = {
      tipo: 'forse', data, corsa: c, presa: m - c.a, x: e.clientX, y: e.clientY,
      dito: e.pointerType !== 'mouse', puntatore: e.pointerId
    };
    if (gesto.dito) {
      gesto.timer = setTimeout(() => {
        if (gesto && gesto.tipo === 'forse') { iniziaSposta(); if (navigator.vibrate) navigator.vibrate(12); }
      }, 380);
    }
  }

  function iniziaSposta() {
    gesto.tipo = 'sposta';
    document.body.classList.add('trascina');
    const f = $('ore-fantasma');
    f.hidden = false;
    const { info } = infoGiorno(gesto.data);
    f.textContent = etichettaDi(info, gesto.corsa.id);
    aggiornaFantasma(gesto.x, gesto.y);
  }

  function aggiornaFantasma(x, y) {
    const f = $('ore-fantasma');
    const sotto = metàDaPunto(x, y);
    const lunghezza = gesto.corsa.b - gesto.corsa.a + 1;
    gesto.dest = null;
    if (!sotto) { f.classList.add('fuori'); return; }
    const t = dove(sotto.m, gesto.presa, lunghezza);
    const a = rettMetà(sotto.data, t), b = rettMetà(sotto.data, t + lunghezza - 1);
    if (!a || !b) return;
    // Il fantasma non segue la mano: si aggancia al riquadro dove il blocco finirà.
    f.classList.remove('fuori');
    f.style.left = `${a.left}px`;
    f.style.top = `${a.top}px`;
    f.style.width = `${a.width}px`;
    f.style.height = `${b.bottom - a.top}px`;
    gesto.dest = { data: sotto.data, t };
    f.classList.toggle('copia', sotto.data !== gesto.data);
  }

  function muoviPuntatore(e) {
    if (!gesto || e.pointerId !== gesto.puntatore) return;
    if (gesto.tipo === 'forse') {
      const d = Math.hypot(e.clientX - gesto.x, e.clientY - gesto.y);
      if (d > (gesto.dito ? 10 : 5)) {
        if (gesto.dito) { clearTimeout(gesto.timer); gesto = null; return; }   // era uno scorrimento
        iniziaSposta();
      }
      return;
    }
    if (gesto.tipo === 'sposta') { aggiornaFantasma(e.clientX, e.clientY); return; }
    if (gesto.tipo === 'allunga') {
      const [, fineSessione] = limiti(gesto.corsa.a);
      let fine = gesto.corsa.a;
      for (let m = gesto.corsa.a; m <= fineSessione; m++) {
        const r = rettMetà(gesto.data, m);
        if (r && e.clientY >= r.top) fine = m;
      }
      if (fine === gesto.fine) return;
      const tacche = Math.abs(fine - gesto.fine);
      gesto.fine = fine;
      const H = metàDi(grigliaDi(gesto.data, infoGiorno(gesto.data).g).ore);
      anteprima = { data: gesto.data, H: allunga(H, gesto.corsa, fine) };
      disegna();
      const r = rettMetà(gesto.data, fine);
      if (r) effetti.gioca('misura', r, { tacche });
    }
  }

  function suPuntatore(e) {
    if (!gesto || e.pointerId !== gesto.puntatore) return;
    const g = gesto;
    clearTimeout(g.timer);
    gesto = null;
    document.body.classList.remove('trascina');
    $('ore-fantasma').hidden = true;

    if (g.tipo === 'allunga') {
      ignoraFino = performance.now() + 400;
      const H = anteprima && anteprima.H;
      anteprima = null;
      if (H) scriviMetà(g.data, H);
      disegna();
    } else if (g.tipo === 'sposta') {
      ignoraFino = performance.now() + 400;
      if (!g.dest) return;
      const lunghezza = g.corsa.b - g.corsa.a + 1;
      const H = metàDi(righeDi(g.dest.data).ore);
      const stesso = g.dest.data === g.data;
      const N = stesso ? sposta(H, g.corsa, g.dest.t) : copiaIn(H, g.corsa.id, lunghezza, g.dest.t);
      if (!N) { avvisa(stesso ? 'Lì non ci sta per intero: non si sposta.' : 'Lì è tutto occupato.'); return; }
      scriviMetà(g.dest.data, N);
      const ora = g.dest.t >> 1;
      effetto('scrivi', () => cellaDi(g.dest.data, ora, righeDi(g.dest.data).ore[ora].diviso ? (g.dest.t & 1) : null));
      if (!stesso) avvisa('Copiato.');
      disegna();
    }
  }

  function annullaGesto() {
    if (!gesto) return false;
    clearTimeout(gesto.timer);
    gesto = null;
    anteprima = null;
    document.body.classList.remove('trascina');
    $('ore-fantasma').hidden = true;
    disegna();
    return true;
  }

  function clic(e) {
    if (performance.now() < ignoraFino) return;
    const testa = e.target.closest('.giorno-testa');
    if (testa) {
      scelta = null;
      giorno = testa.dataset.giorno;
      scriviLocale(CHIAVE_GIORNO, giorno);
      disegna();
      return;
    }
    const cella = e.target.closest('.cella[data-data]');
    if (!cella) return;
    const slot = {
      data: cella.dataset.data, ora: Number(cella.dataset.ora),
      meta: cella.dataset.meta === '' ? null : Number(cella.dataset.meta)
    };
    const { info, modificabile } = righeDi(slot.data);
    if (!info) return;
    if (suPc()) {
      scelta = slot;
      giorno = slot.data;
      chiudiCampo();
      disegna();
      const c = cellaDi(slot.data, slot.ora, slot.meta);
      if (c) c.focus({ preventScroll: true });
    } else if (!info.solaLettura && modificabile) {
      apriScelta(slot);
    }
  }

  // ─────────────── la tastiera (PC), come in un foglio di calcolo

  function tasto(e) {
    if (!document.body.classList.contains('vista-ore')) return;
    if (e.key === 'Escape' && annullaGesto()) { e.preventDefault(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (e.target.closest('input, textarea')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); annulla(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); rifai(); return; }

    if (!suPc()) {
      if (!ctrl && e.key === 'ArrowLeft') vaiA(spostaLavorativo(giorno, -1));
      else if (!ctrl && e.key === 'ArrowRight') vaiA(spostaLavorativo(giorno, 1));
      return;
    }

    if (e.key === 'F4') { e.preventDefault(); accorpata = !accorpata; disegna(); return; }
    if (ctrl && k === 'c') { e.preventDefault(); copia({ giornata: e.shiftKey }); return; }
    if (ctrl && k === 'v') { e.preventDefault(); incolla(); return; }

    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (!scelta) { scelta = { data: giorno, ora: 0, meta: righeDi(giorno).ore[0].diviso ? 0 : null }; disegna(); return; }
      let dopo = null;
      if (e.key === 'ArrowDown') dopo = slotDopo(scelta, 1);
      if (e.key === 'ArrowUp') dopo = slotDopo(scelta, -1);
      if (e.key === 'ArrowLeft') dopo = slotAccanto(scelta, -1);
      if (e.key === 'ArrowRight') dopo = slotAccanto(scelta, 1);
      if (dopo) {
        scelta = dopo;
        if (!giorniGriglia(mese).includes(dopo.data)) mese = dopo.data.slice(0, 7);
        vaiA(dopo.data, { tieniScelta: true });
        const c = cellaDi(scelta.data, scelta.ora, scelta.meta);
        if (c) c.focus({ preventScroll: true });
      }
      return;
    }
    if (e.key === 'Escape') { scelta = null; disegna(); return; }
    if (!scelta || accorpata) return;

    if (ctrl && k === 'd') { e.preventDefault(); dividi(scelta); disegna(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); imposta(scelta, null); disegna(); return; }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const id = vociDelloSlot(scelta);
      apriCampo(id ? etichettaDi(infoGiorno(scelta.data).info, id) : '');
      return;
    }
    if (!ctrl && !e.altKey && e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      apriCampo(e.key);
    }
  }

  // ─────────────── il riepilogo

  let perimetro = 'mese', vista = 'commessa';

  function disegnaRiepilogo() {
    const righe = $('riep-righe');
    righe.replaceChildren();
    $('riep-perimetro').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === perimetro)));
    $('riep-vista').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === vista)));

    // Mese: le 25 giornate della griglia. Anno: l'anno del giorno guardato.
    const giorniMese = new Set(giorniGriglia(mese));
    const anno = perimetro === 'mese' ? null : Number(mese.slice(0, 4));
    const docs = perimetro === 'mese'
      ? [...new Set([...giorniMese].map(annoDi))].map(documento)
      : [documento(anno)];
    if (docs.some(d => !d)) { $('riep-sotto').textContent = 'Le ore non sono ancora arrivate da OneDrive.'; return; }
    const dentro = data => (perimetro === 'mese' ? giorniMese.has(data) : annoDi(data) === anno);

    const nomeMese = daData(mese + '-01').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    const nome = perimetro === 'mese' ? nomeMese : String(anno);
    const soloNumerate = $('riep-numerate').checked;
    const tot = new Map();
    let totale = 0, senzaNumero = 0;
    const etichette = new Map();
    for (const info of docs) {
      for (const [data, g] of info.giorni) {
        if (!dentro(data)) continue;
        for (const v of g.voci || []) {
          const c = info.commesse.get(v.commessaId);
          const m = Number(v.durata) || 0;
          if (!c || !c.codice) senzaNumero += m;
          if (soloNumerate && !(c && c.codice)) continue;
          const chiave = vista === 'commessa' ? v.commessaId : (c && c.cliente) || '';
          etichette.set(chiave, vista === 'commessa' ? etichettaDi(info, v.commessaId) : (chiave || 'senza cliente'));
          tot.set(chiave, (tot.get(chiave) || 0) + m);
          totale += m;
        }
      }
    }

    $('riep-sotto').textContent = `${nome.charAt(0).toUpperCase() + nome.slice(1)} · ${fmt(totale)} h`;
    const ordinate = [...tot.entries()].sort((a, b) => b[1] - a[1] ||
      String(etichette.get(a[0])).localeCompare(String(etichette.get(b[0])), 'it'));
    const colori = tinte(ordinate.map(([k]) => k), k => etichette.get(k));
    for (const [k, m] of ordinate) {
      const r = el('div', 'riep-riga');
      r.append(el('span', null, etichette.get(k)), el('span', 'n', `${fmt(m)} h`),
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

    let vuote = 0;
    const fino = oggi();
    if (perimetro === 'mese') {
      for (const d of giorniMese) if (d <= fino) vuote += Math.max(0, GIORNATA - minutiDi(d));
    } else {
      for (const x = new Date(anno, 0, 1); x.getFullYear() === anno && aData(x) <= fino; x.setDate(x.getDate() + 1)) {
        if (!festivo(x)) vuote += Math.max(0, GIORNATA - minutiDi(aData(x)));
      }
    }
    $('riep-piede').textContent = `Slot vuoti fino a oggi: ${fmt(vuote)} h · voci senza numero di commessa: ${fmt(senzaNumero)} h`;
  }

  // ─────────────── le schede Ore, Laser e Gestione PC

  const SCHEDE = { ore: 'Ore', laser: 'Laser Servo-Robot', pc: 'Gestione PC' };

  function mostraScheda(nome) {
    // Con i dati nella cartella condivisa le ore non ci sono: sono personali e stanno con
    // l'app del PC su OneDrive. Si va a Gestione PC.
    if (!SCHEDE[nome] || (DATI_IN_CARTELLA && nome === 'ore')) nome = DATI_IN_CARTELLA ? 'pc' : 'ore';
    for (const n of Object.keys(SCHEDE)) document.body.classList.toggle('vista-' + n, nome === n);
    $('titolo').textContent = SCHEDE[nome];
    document.querySelectorAll('.schede button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.scheda === nome)));
    scriviLocale(CHIAVE_SCHEDA, nome);
    if (nome === 'ore') disegna();
    if (nome === 'pc') pcCommesse.mostra();
  }

  // ─────────────── avvio

  function avvia() {
    document.querySelectorAll('.schede button').forEach(b =>
      b.addEventListener('click', () => mostraScheda(b.dataset.scheda)));

    // Telefono
    $('ore-prima').addEventListener('click', () => vaiA(spostaLavorativo(giorno, -1)));
    $('ore-dopo').addEventListener('click', () => vaiA(spostaLavorativo(giorno, 1)));
    $('ore-oggi').addEventListener('click', () => vaiA(oggi()));
    $('ore-annulla').addEventListener('click', annulla);
    $('ore-rifai').addEventListener('click', rifai);
    $('ore-copia-giorno').addEventListener('click', () => { scelta = null; copia({ giornata: true }); });
    $('ore-incolla').addEventListener('click', () => { scelta = null; incolla(); });
    $('ore-cerca-apri').addEventListener('click', () => {
      $('ricerca-ore').showModal();
      $('ricerca-testo').focus();
      disegnaRisultati();
    });
    $('ricerca-testo').addEventListener('input', e => cercaDopo(e.target.value));
    $('ricerca-ore').addEventListener('close', () => {
      if (!$('ricerca-testo').value.trim()) { ricerca = ''; disegna(); }
    });
    $('ricerca-pulisci').addEventListener('click', () => {
      $('ricerca-testo').value = ''; ricerca = ''; disegnaRisultati(); disegna(); $('ricerca-ore').close();
    });

    // Scorrere col dito di lato cambia giorno (se non si sta trascinando).
    let tocco = null;
    $('ore-slot').addEventListener('touchstart', e => {
      const t = e.touches[0];
      tocco = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    $('ore-slot').addEventListener('touchend', e => {
      if (!tocco || (gesto && gesto.tipo !== 'forse')) { tocco = null; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - tocco.x, dy = t.clientY - tocco.y;
      tocco = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) vaiA(spostaLavorativo(giorno, dx < 0 ? 1 : -1));
    });
    // Mentre si trascina col dito la pagina non deve scorrere.
    document.addEventListener('touchmove', e => {
      if (gesto && gesto.tipo !== 'forse') e.preventDefault();
    }, { passive: false });

    // Il pannello del telefono
    $('ore-cerca').addEventListener('input', () => { evidenziata = 0; disegnaProposte(); });
    $('ore-cerca').addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = azioniPannello.length;
        if (n) evidenziata = (evidenziata + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        disegnaProposte();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if ($('ore-cerca').value.trim()) scegliPannello(evidenziata);
      }
    });
    $('ore-svuota').addEventListener('click', () => { imposta(scelta, null); disegna(); });
    $('ore-dividi').addEventListener('click', () => { dividi(scelta); disegna(); });
    $('ore-copia').addEventListener('click', () => copia());
    $('ore-incolla-slot').addEventListener('click', () => incolla());
    $('ore-fine').addEventListener('click', () => $('scheda-ore').close());
    $('scheda-ore').addEventListener('click', e => { if (e.target === $('scheda-ore')) $('scheda-ore').close(); });
    $('scheda-ore').addEventListener('close', () => { scelta = null; disegna(); });

    // Il PC
    $('mese-prima').addEventListener('click', () => {
      const d = daData(mese + '-01'); d.setMonth(d.getMonth() - 1);
      mese = aData(d).slice(0, 7); scelta = null; vaiA(giorniGriglia(mese).find(x => x.startsWith(mese)));
    });
    $('mese-dopo').addEventListener('click', () => {
      const d = daData(mese + '-01'); d.setMonth(d.getMonth() + 1);
      mese = aData(d).slice(0, 7); scelta = null; vaiA(giorniGriglia(mese).find(x => x.startsWith(mese)));
    });
    $('mese-annulla').addEventListener('click', annulla);
    $('mese-rifai').addEventListener('click', rifai);
    $('mese-accorpa').addEventListener('click', () => { accorpata = !accorpata; disegna(); });
    $('mese-riepilogo').addEventListener('click', () => { disegnaRiepilogo(); $('riepilogo-ore').showModal(); });
    $('mese-cerca').addEventListener('input', e => cercaDopo(e.target.value));
    $('mese-cerca').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.target.value = ''; cercaDopo(''); e.target.blur(); }
    });
    $('mese-griglia').addEventListener('dblclick', e => {
      if (!e.target.closest('.cella[data-data]') || !scelta) return;
      const id = vociDelloSlot(scelta);
      apriCampo(id ? etichettaDi(infoGiorno(scelta.data).info, id) : '');
    });

    // Il campo del PC
    const testo = $('ore-campo-testo');
    testo.addEventListener('input', () => { evidenziataCampo = 0; $('ore-campo-lista').hidden = false; disegnaCampo(); });
    testo.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        $('ore-campo-lista').hidden = false;
        const n = azioniCampo.length;
        if (n) evidenziataCampo = (evidenziataCampo + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        disegnaCampo();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        scegliCampo(null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Esc chiude la tendina, poi il campo.
        if (!$('ore-campo-lista').hidden) $('ore-campo-lista').hidden = true;
        else chiudiCampo();
      }
    });
    testo.addEventListener('blur', () => {
      if ($('ore-campo').hidden) return;
      // Lasciando il campo, il testo vale solo se corrisponde a una commessa.
      const id = esatta(scelta.data, testo.value);
      if (id && id !== vociDelloSlot(scelta)) { imposta(scelta, id); disegna(); }
      $('ore-campo').hidden = true;
    });

    // Clic, trascinamento e tastiera, per tutte e due le viste
    for (const box of [$('ore-slot'), $('mese-griglia')]) {
      box.addEventListener('click', clic);
      box.addEventListener('pointerdown', giùPuntatore);
    }
    document.addEventListener('pointermove', muoviPuntatore);
    document.addEventListener('pointerup', suPuntatore);
    document.addEventListener('pointercancel', annullaGesto);
    document.addEventListener('keydown', e => {
      // Ctrl+1/2/3 (o Alt+1/2/3, che il browser non si tiene) cambiano scheda.
      if ((e.ctrlKey || e.altKey) && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        mostraScheda({ 1: 'ore', 2: 'laser', 3: 'pc' }[e.key]);
        return;
      }
      tasto(e);
    });

    // Il riepilogo
    $('ore-riepilogo').addEventListener('click', () => { disegnaRiepilogo(); $('riepilogo-ore').showModal(); });
    $('riepilogo-ore').addEventListener('click', e => { if (e.target === $('riepilogo-ore')) $('riepilogo-ore').close(); });
    $('riep-perimetro').addEventListener('click', e => {
      const b = e.target.closest('button'); if (b) { perimetro = b.dataset.v; disegnaRiepilogo(); }
    });
    $('riep-vista').addEventListener('click', e => {
      const b = e.target.closest('button'); if (b) { vista = b.dataset.v; disegnaRiepilogo(); }
    });
    $('riep-numerate').addEventListener('change', disegnaRiepilogo);

    // Gli effetti si possono spegnere dal pannello di OneDrive.
    const interruttore = $('effetti-acceso');
    interruttore.checked = effetti.acceso();
    interruttore.addEventListener('change', () => effetti.imposta(interruttore.checked));

    let misura = null;
    window.addEventListener('resize', () => {
      clearTimeout(misura);
      misura = setTimeout(() => { if (document.body.classList.contains('vista-ore')) disegna(); }, 120);
    });
    pc.addEventListener('change', () => { scelta = null; chiudiCampo(); vaiA(giorno); });

    // A mezzanotte «oggi» cambia: la targhetta va spostata da sé.
    let ieri = oggi();
    setInterval(() => { if (oggi() !== ieri) { ieri = oggi(); disegna(); } }, 60 * 1000);

    // Gli anni con modifiche non ancora inviate si sincronizzano anche se non si guardano.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^rd\.ore\.v1\.(\d{4})$/.exec(localStorage.key(i) || '');
        if (m && inAttesa(statoAnno(Number(m[1])))) anniAperti.add(Number(m[1]));
      }
    } catch (_) {}

    if (DATI_IN_CARTELLA) $('scheda-ore-btn').hidden = true;
    else onedrive.registra(sincronizza);
    mostraScheda(leggi(CHIAVE_SCHEDA) || 'ore');
    vaiA(giorno);
  }

  return { avvia, disegna };
})();

ore.avvia();
