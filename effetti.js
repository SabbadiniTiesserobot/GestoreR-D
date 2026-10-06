'use strict';

// ════════════════════════════════════════════════ gli effetti
//
// Le animazioni di conferma in stile retro del modulo Ore: fotogrammi discreti a
// 30 fps (un numero intero di rinfreschi a 60 Hz), una griglia di pixel da 3, tavolozze
// fisse che ciclano, fra 140 e 700 ms. Ogni effetto ha la sua sagoma e la sua tavolozza,
// così si riconosce con la coda dell'occhio. Si disegnano su una tela sopra la pagina,
// che non riceve tocchi: la griglia sotto non cambia mai opacità.

const effetti = (() => {
  const PX = 3;
  const FOTOGRAMMA = 1000 / 30;
  const CHIAVE = 'rd.effetti';

  const DURATE = {
    scrivi: 300, cancella: 460, giornata: 600, settimana: 700,
    misura: 140, copia: 400, incolla: 400, annulla: 600, rifai: 600,
    // Le due feste a tutto schermo: giornata e settimana completate.
    giornataSchermo: 1300, settimanaSchermo: 1800, meseSchermo: 2600
  };

  const FUOCO = ['#ffffff', '#ffe14d', '#ff9b21', '#e8461b', '#8b1a10'];
  const MATTONE = ['#c46a3e', '#8e4325'];
  const VERDI = ['#e9ffe0', '#7bf06a', '#2fbf3a', '#137a2a'];
  const TETRAMINI = ['#33d6e8', '#f2d22e', '#a64fe0', '#46d04a', '#e8423a', '#3a62e8', '#f08a2a'];
  const FUOCHI = [['#fff3b0', '#ffd23f', '#f6a21a', '#c46a10'], ['#ffd0f0', '#ff6fc8', '#d6308f'],
    ['#c9f7ff', '#33d6e8', '#1a7ec4'], ['#e9ffe0', '#7bf06a', '#2fbf3a'], ['#efe0ff', '#a64fe0', '#6f2bb0']];
  const CLONE = ['#ffffff', '#9fefff', '#3fc8f0', '#1a7ec4'];
  const TELE = ['#ffffff', '#ffe9a8', '#f6b93b', '#c97a12'];
  const CANCELLO_INDIETRO = ['#ffffff', '#b9a8ff', '#6f4bff', '#2a1a8a', '#43e0ff'];
  const CANCELLO_AVANTI = ['#ffffff', '#ffd6a8', '#ff8a3d', '#a8340f', '#ffe14d'];

  let tela = null, ctx = null;
  let attivi = [];
  let giro = null;

  const leggi = () => { try { return localStorage.getItem(CHIAVE); } catch (_) { return null; } };
  const riduci = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let acceso = leggi() === null ? !riduci : leggi() === '1';

  function imposta(si) {
    acceso = !!si;
    try { localStorage.setItem(CHIAVE, acceso ? '1' : '0'); } catch (_) {}
    if (!acceso) { attivi = []; pulisci(); }
  }

  function prepara() {
    if (tela) return true;
    tela = document.getElementById('effetti');
    if (!tela) return false;
    ctx = tela.getContext('2d');
    const misura = () => {
      tela.width = Math.ceil(window.innerWidth / PX);
      tela.height = Math.ceil(window.innerHeight / PX);
      ctx.imageSmoothingEnabled = false;
    };
    misura();
    window.addEventListener('resize', misura);
    return true;
  }

  function pulisci() { if (ctx) ctx.clearRect(0, 0, tela.width, tela.height); }

  const inPixel = rett => ({
    x: Math.floor(rett.left / PX), y: Math.floor(rett.top / PX),
    w: Math.max(2, Math.round(rett.width / PX)), h: Math.max(2, Math.round(rett.height / PX))
  });

  /** Un effetto sul rettangolo (coordinate dello schermo, come getBoundingClientRect). */
  function gioca(tipo, rett, opzioni = {}) {
    if (!acceso || !rett || !DURATE[tipo] || !prepara()) return;
    const r = inPixel(rett);
    // Le feste a tutto schermo partono da dove è successo (opzioni.da), ma occupano tutto.
    if (opzioni.da) opzioni = { ...opzioni, da: inPixel(opzioni.da) };
    attivi.push({ tipo, r, inizio: performance.now(), n: Math.round(DURATE[tipo] / FOTOGRAMMA), op: opzioni });
    if (!giro) giro = requestAnimationFrame(passo);
  }

  let ultimo = -1;
  function passo(adesso) {
    giro = null;
    // Si ridisegna solo quando cambia il fotogramma: 30 al secondo, non 60.
    const f = Math.floor(adesso / FOTOGRAMMA);
    if (f !== ultimo) {
      ultimo = f;
      pulisci();
      attivi = attivi.filter(e => {
        const i = Math.floor((adesso - e.inizio) / FOTOGRAMMA);
        if (i >= e.n) return false;
        DISEGNI[e.tipo](e.r, i, e.n, e.op);
        return true;
      });
    }
    if (attivi.length) giro = requestAnimationFrame(passo);
    else pulisci();
  }

  // ─────────────── i mattoni del disegno, in pixel da 3

  const px = (x, y, c, w = 1, h = 1) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
  function diamante(cx, cy, r, c) {
    for (let dy = -r; dy <= r; dy++) {
      const w = r - Math.abs(dy);
      px(cx - w, cy + dy, c, w * 2 + 1, 1);
    }
  }
  function anello(cx, cy, rx, ry, c, spessore = 1) {
    const passi = Math.max(12, Math.round((rx + ry) * 3));
    for (let k = 0; k < passi; k++) {
      const a = (k / passi) * Math.PI * 2;
      px(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, c, spessore, spessore);
    }
  }
  const centro = r => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });

  // ─────────────── i disegni, uno per gesto

  const DISEGNI = {
    // Scrivere: onde e puntini tondi, bianco e tinta della voce.
    scrivi(r, i, n, op) {
      const { cx, cy } = centro(r);
      const tinta = op.colore || '#5bd9c0';
      for (let k = 0; k < 3; k++) {
        const t = i - k * 2;
        if (t < 0) continue;
        anello(cx, cy, Math.min(r.w / 2, t * 2.2), Math.min(r.h / 2, t * 1.1), k % 2 ? tinta : '#ffffff');
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.3;
        const d = i * 1.8;
        px(cx + Math.cos(a) * d * 1.6, cy + Math.sin(a) * d * 0.8, (k + i) % 2 ? '#ffffff' : tinta, 2, 2);
      }
    },

    // Cancellare: una croce di mattoni alla Bomberman, poi il fuoco e le schegge.
    cancella(r, i, n) {
      const { cx, cy } = centro(r);
      const crescita = Math.min(1, (i + 1) / 5);
      const bx = Math.floor((r.w / 2) * crescita), by = Math.floor((r.h / 2) * crescita);
      const fuoco = i >= 5;
      for (let x = -bx; x <= bx; x++) {
        for (let y = -1; y <= 1; y++) {
          const c = fuoco ? FUOCO[(Math.abs(x) + i) % FUOCO.length] : MATTONE[(x + y + 64) % 3 === 0 ? 1 : 0];
          px(cx + x, cy + y, c);
        }
      }
      for (let y = -by; y <= by; y++) {
        for (let x = -1; x <= 1; x++) {
          const c = fuoco ? FUOCO[(Math.abs(y) + i) % FUOCO.length] : MATTONE[(y + x + 64) % 3 === 0 ? 1 : 0];
          px(cx + x, cy + y, c);
        }
      }
      if (fuoco) {
        const t = i - 5;
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy], k) =>
          diamante(cx + dx * t * 2.2, cy + dy * t * 1.4, 1, FUOCO[(k + i) % 4]));
      }
    },

    // Giornata completata: un anello e i diamanti verdi.
    giornata(r, i, n) {
      const { cx, cy } = centro(r);
      const t = (i + 1) / n;
      const rx = (r.w / 2) * t, ry = (r.h / 2) * t;
      anello(cx, cy, rx, ry, VERDI[i % VERDI.length], 2);
      anello(cx, cy, rx * 0.7, ry * 0.7, VERDI[(i + 2) % VERDI.length]);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + i * 0.25;
        diamante(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 2, VERDI[(k + i) % VERDI.length]);
      }
    },

    // Settimana completata: il «line clear» di Tetris, nei colori dei tetramini.
    settimana(r, i, n) {
      const lato = 4;
      const colonne = Math.max(1, Math.floor(r.w / lato));
      const y = r.y + Math.floor(r.h / 2) - lato;
      const via = Math.max(0, i - 4) * (colonne / (2 * (n - 5)));
      for (let k = 0; k < colonne; k++) {
        const d = Math.abs(k - (colonne - 1) / 2);
        if (d < via) continue;
        const c = i < 4 && i % 2 ? '#ffffff' : TETRAMINI[(k + i) % TETRAMINI.length];
        for (let riga = 0; riga < 2; riga++) {
          px(r.x + k * lato, y + riga * lato, c, lato - 1, lato - 1);
        }
      }
    },

    // Allungare o accorciare: il misuratore, una tacca per ogni mezz'ora attraversata.
    misura(r, i, n, op) {
      const y = r.y + r.h - 1;
      const c = i % 2 ? '#ffffff' : '#5bd9c0';
      px(r.x + r.w / 2 - 8, y, c, 16, 1);
      px(r.x + r.w / 2 - 1, y - 3, c, 2, 4);
      for (let k = 1; k <= Math.min(op.tacche || 1, 8); k++) px(r.x + r.w / 2 + 9 + k * 3, y - 1, '#ffe14d', 2, 2);
    },

    // Copiare: la clonazione, che sale e si stringe.
    copia(r, i, n) {
      for (let k = 0; k < 3; k++) {
        const t = i - k * 2;
        if (t < 0) continue;
        const ins = t;
        const x = r.x + ins, w = r.w - ins * 2, h = r.h - ins, y = r.y - t * 2;
        if (w <= 0 || h <= 0) continue;
        const c = CLONE[(k + i) % CLONE.length];
        px(x, y, c, w, 1); px(x, y + h - 1, c, w, 1); px(x, y, c, 1, h); px(x + w - 1, y, c, 1, h);
      }
    },

    // Incollare: il teletrasporto, che scende e si compone.
    incolla(r, i, n) {
      const meta = Math.floor(n / 2);
      if (i < meta) {
        for (let k = 0; k < 5; k++) {
          const x = r.x + Math.round(((k + 0.5) / 5) * r.w);
          const fino = r.y + Math.round((i / meta) * r.h);
          px(x, r.y - 8, TELE[(k + i) % TELE.length], 1, fino - r.y + 8);
        }
      } else {
        const righe = Math.round(((i - meta + 1) / (n - meta)) * r.h);
        for (let y = 0; y < righe; y += 2) px(r.x, r.y + y, TELE[(y + i) % TELE.length], r.w, 1);
      }
    },

    // Annulla e rifai: il Cancello, in versi opposti. Annulla si chiude girando a
    // sinistra, rifai si apre girando a destra.
    // Giornata completata, a tutto schermo: un lampo verde, anelli e diamanti che partono
    // dalla giornata e invadono lo schermo, e la scritta.
    giornataSchermo(r, i, n, op) {
      const o = op.da ? centro(op.da) : centro(r);
      const lontano = Math.hypot(Math.max(o.cx, r.w - o.cx), Math.max(o.cy, r.h - o.cy));
      if (i < 4) { ctx.globalAlpha = 0.22 - i * 0.05; px(0, 0, VERDI[2], r.w, r.h); ctx.globalAlpha = 1; }
      for (let k = 0; k < 4; k++) {
        const t = (i - k * 4) / (n - 10);
        if (t <= 0 || t > 1) continue;
        anello(o.cx, o.cy, lontano * t, lontano * t, VERDI[(k + i) % VERDI.length], 2);
      }
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2 + (k % 2) * 0.11;
        const d = i * (2.2 + (k % 5) * 0.55);
        if (d > lontano) continue;
        diamante(o.cx + Math.cos(a) * d, o.cy + Math.sin(a) * d, 1 + (k % 3), VERDI[(k + i) % VERDI.length]);
      }
      if (i >= 3 && i < n - 2) scritta(r, i, 'GIORNATA FATTA!', '8,0 h', VERDI, i - 3);
    },

    // Settimana completata, a tutto schermo: il «line clear» di Tetris. I blocchi salgono
    // dal fondo fino a riempire lo schermo, lampeggiano, e si sgombrano dal centro.
    settimanaSchermo(r, i, n) {
      const lato = 8;
      const colonne = Math.ceil(r.w / lato), righe = Math.ceil(r.h / lato);
      const salita = 14, lampo = 22;
      const piene = Math.min(righe, Math.ceil((Math.min(i, salita) / salita) * righe));
      const via = i < lampo ? -1 : ((i - lampo) / (n - lampo - 6)) * (colonne / 2 + 1);
      ctx.globalAlpha = 0.88;
      for (let rg = 0; rg < piene; rg++) {
        const y = r.h - (rg + 1) * lato;
        for (let c = 0; c < colonne; c++) {
          if (Math.abs(c - (colonne - 1) / 2) < via) continue;
          const bianca = i >= salita && i < lampo && (i + rg) % 2 === 0;
          const col = bianca ? '#ffffff' : TETRAMINI[(c * 3 + rg * 5 + Math.floor(c / 4)) % TETRAMINI.length];
          px(c * lato, y, col, lato - 1, lato - 1);
          if (!bianca) px(c * lato, y, 'rgba(255,255,255,.35)', lato - 1, 1);
        }
      }
      ctx.globalAlpha = 1;
      if (i >= salita - 2) scritta(r, i, 'SETTIMANA COMPLETA!', '40,0 h', ['#ffffff', '#ffe14d', '#33d6e8', '#f08a2a'], i - salita + 2);
    },

    // Mese completato, a tutto schermo: fuochi d'artificio. Razzi che salgono dal fondo
    // e scoppiano in pixel che ricadono, uno dopo l'altro, e la scritta.
    meseSchermo(r, i, n) {
      const razzi = 9;
      for (let k = 0; k < razzi; k++) {
        const parte = k * 6;                       // ogni razzo parte sei fotogrammi dopo
        const t = i - parte;
        if (t < 0 || t > 40) continue;
        // Posizioni fisse ma sparse: niente casuale, così ogni volta è uguale.
        const x = r.w * (0.12 + ((k * 0.37) % 0.76));
        const alto = r.h * (0.18 + ((k * 0.23) % 0.32));
        const tav = FUOCHI[k % FUOCHI.length];
        const salita = 9;
        if (t < salita) {
          const y = r.h - (r.h - alto) * (t / salita);
          px(x, y, '#ffffff', 1, 3);
          px(x, y + 3, tav[2], 1, 3);
          continue;
        }
        const e = t - salita;                       // fotogrammi dallo scoppio
        if (e < 2) { ctx.globalAlpha = 0.18; px(0, 0, tav[0], r.w, r.h); ctx.globalAlpha = 1; }
        // Lo scoppio si misura sullo schermo: grande sul PC, comunque pieno sul telefono.
        const raggio = Math.min(e, 14) * Math.max(2.6, Math.min(r.w, r.h) / 55);
        const scintille = 36;
        for (let q = 0; q < scintille; q++) {
          const a = (q / scintille) * Math.PI * 2 + k;
          const caduta = e > 8 ? (e - 8) * (e - 8) * 0.08 : 0;
          const xx = x + Math.cos(a) * raggio * (0.8 + (q % 3) * 0.15);
          const yy = alto + Math.sin(a) * raggio * 0.85 + caduta;
          if (e > 26 && (q + e) % 3 === 0) continue;   // le ultime scintille si spengono a scatti
          const lato = e < 10 ? 3 : e < 20 ? 2 : 1;
          px(xx, yy, tav[Math.min(tav.length - 1, Math.floor(e / 7))], lato, lato);
          // La scia verso il centro, nei primi fotogrammi.
          if (e < 8) px(x + (xx - x) * 0.7, alto + (yy - alto) * 0.7, tav[0], 1, 1);
        }
      }
      if (i >= 8 && i < n - 2) scritta(r, i, 'MESE COMPLETO!', '200,0 h', ['#ffd23f', '#ffffff', '#ff6fc8', '#33d6e8'], i - 8);
    },

    annulla(r, i, n) { cancello(r, i, n, -1, CANCELLO_INDIETRO); },
    rifai(r, i, n) { cancello(r, i, n, 1, CANCELLO_AVANTI); }
  };

  /** La scritta delle feste: entra ingrandendosi, con l'ombra e i colori che ciclano. */
  function scritta(r, i, titolo, sotto, tavolozza, t) {
    const cx = Math.round(r.w / 2), cy = Math.round(r.h / 2);
    const piena = Math.max(8, Math.min(Math.floor(r.w / (titolo.length * 0.68)), 30));
    const grande = Math.round(piena * Math.min(1, 0.4 + t * 0.2));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    px(0, cy - grande, 'rgba(10,12,16,.55)', r.w, grande * 2 + Math.round(grande * 0.9));
    ctx.font = `bold ${grande}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#0d1014';
    ctx.fillText(titolo, cx + 1, cy + 1);
    ctx.fillStyle = tavolozza[i % tavolozza.length];
    ctx.fillText(titolo, cx, cy);
    ctx.font = `bold ${Math.round(grande * 0.55)}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(sotto, cx, cy + Math.round(grande * 1.05));
  }

  function cancello(r, i, n, verso, tavolozza) {
    const { cx, cy } = centro(r);
    const t = verso < 0 ? 1 - i / n : (i + 1) / n;
    const ry = (r.h / 2) * Math.min(1, 0.3 + t), rx = Math.max(2, (r.w / 3) * t);
    anello(cx, cy, rx, ry, tavolozza[i % 4], 2);
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + verso * i * 0.45;
      const s = 0.35 + 0.6 * ((k * 7) % 10) / 10;
      px(cx + Math.cos(a) * rx * s, cy + Math.sin(a) * ry * s, tavolozza[(k + i) % tavolozza.length], 2, 2);
    }
    px(cx - 1, cy - ry * 0.8, tavolozza[4], 2, ry * 1.6);
  }

  return { gioca, imposta, acceso: () => acceso };
})();
