'use strict';

// ════════════════════════════════════════════════ il server interno
//
// Serve App gestione R&D dentro la rete aziendale, con i dati in una cartella di questo
// server invece che su OneDrive: chi apre l'indirizzo vede e modifica gli stessi laser
// e gli stessi PC, senza accesso Microsoft. Le ore non ci sono: sono personali e stanno
// con l'app del PC su OneDrive.
//
// Solo Node.js (18 o più recente), nessuna libreria da installare:
//
//   node server/server.js
//
// Impostazioni, tutte facoltative, da variabili d'ambiente:
//   PORTA      la porta (8080)
//   DATI       la cartella dei dati (server/dati, accanto a questo file)
//   PASSWORD   se c'è, il browser la chiede (utente qualsiasi) prima di aprire l'app
//   COPIE      quante copie di sicurezza tenere per ogni file (50)
//
// L'API è quella che l'app usa per OneDrive, ridotta all'osso:
//   GET  api/file?percorso=…   il file, con l'ETag; 404 se non c'è
//   PUT  api/file?percorso=…   lo scrive; con If-Match solo se è ancora quello letto,
//                              con If-None-Match: * solo se non c'è ancora; se no 412
// Ogni scrittura passa da un file temporaneo e poi si rinomina, così un file non resta
// mai scritto a metà; la versione di prima va in DATI/.copie.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RADICE = path.resolve(__dirname, '..');
const PORTA = Number(process.env.PORTA || process.env.PORT || 8080);
const DATI = path.resolve(process.env.DATI || path.join(__dirname, 'dati'));
const COPIE = Math.max(0, Number(process.env.COPIE || 50));
const PASSWORD = process.env.PASSWORD || '';
const MASSIMO = 10 * 1024 * 1024;

// Solo i file dell'app si servono: niente elenchi di cartelle, niente sorgenti del server.
const FILE_APP = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/effetti.js': 'effetti.js',
  '/pc.js': 'pc.js',
  '/ore.js': 'ore.js',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/icona-rd-180.png': 'icona-rd-180.png',
  '/icona-rd-512.png': 'icona-rd-512.png'
};
const TIPI = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

const etag = buf => `"${crypto.createHash('sha1').update(buf).digest('hex')}"`;

function rispondi(res, codice, corpo = '', intestazioni = {}) {
  const testo = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(codice, { 'Cache-Control': 'no-store', ...intestazioni });
  res.end(testo);
}

/** Il percorso di un file di dati, solo dentro DATI e solo .json; null se non va bene. */
function fileDati(percorso) {
  if (typeof percorso !== 'string' || !percorso || percorso.length > 300) return null;
  if (!/^[\p{L}\p{N} _.&()+-]+(\/[\p{L}\p{N} _.&()+-]+)*\.json$/u.test(percorso)) return null;
  if (percorso.split('/').some(p => p === '.' || p === '..' || p.startsWith('.'))) return null;
  const pieno = path.resolve(DATI, percorso);
  return pieno.startsWith(DATI + path.sep) ? pieno : null;
}

function leggiCorpo(req) {
  return new Promise((ok, no) => {
    const pezzi = [];
    let n = 0;
    req.on('data', p => {
      n += p.length;
      if (n > MASSIMO) { no(Object.assign(new Error('troppo grande'), { codice: 413 })); req.destroy(); }
      else pezzi.push(p);
    });
    req.on('end', () => ok(Buffer.concat(pezzi)));
    req.on('error', no);
  });
}

// Le scritture sullo stesso file passano una alla volta: il controllo dell'ETag e la
// scrittura non devono mescolarsi fra due richieste.
const code = new Map();
function inFila(chiave, lavoro) {
  const prima = code.get(chiave) || Promise.resolve();
  const dopo = prima.then(lavoro, lavoro);
  code.set(chiave, dopo.catch(() => {}));
  return dopo;
}

async function tieniCopia(pieno, attuale) {
  if (!COPIE || !attuale) return;
  const relativo = path.relative(DATI, pieno);
  const cartella = path.join(DATI, '.copie', path.dirname(relativo));
  await fsp.mkdir(cartella, { recursive: true });
  const base = path.basename(relativo, '.json');
  const quando = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(cartella, `${base}.${quando}.json`), attuale);
  const vecchie = (await fsp.readdir(cartella)).filter(f => f.startsWith(base + '.') && f.endsWith('.json')).sort();
  for (const f of vecchie.slice(0, Math.max(0, vecchie.length - COPIE))) await fsp.unlink(path.join(cartella, f)).catch(() => {});
}

async function api(req, res, url) {
  const pieno = fileDati(url.searchParams.get('percorso'));
  if (!pieno) return rispondi(res, 400, { errore: 'percorso non valido' });

  if (req.method === 'GET') {
    try {
      const buf = await fsp.readFile(pieno);
      return rispondi(res, 200, buf, { 'Content-Type': TIPI['.json'], ETag: etag(buf) });
    } catch (e) {
      if (e.code === 'ENOENT') return rispondi(res, 404, { errore: 'non c\'è' });
      throw e;
    }
  }

  if (req.method === 'PUT') {
    const corpo = await leggiCorpo(req);
    try { JSON.parse(corpo.toString('utf8')); } catch (_) {
      return rispondi(res, 400, { errore: 'non è JSON' });
    }
    return inFila(pieno, async () => {
      let attuale = null;
      try { attuale = await fsp.readFile(pieno); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const seCorrisponde = req.headers['if-match'];
      const seNonCe = req.headers['if-none-match'];
      if (seCorrisponde && (!attuale || etag(attuale) !== seCorrisponde)) return rispondi(res, 412, { errore: 'cambiato nel frattempo' });
      if (seNonCe === '*' && attuale) return rispondi(res, 412, { errore: 'c\'è già' });

      await fsp.mkdir(path.dirname(pieno), { recursive: true });
      const temporaneo = `${pieno}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(temporaneo, corpo);
      await tieniCopia(pieno, attuale);
      await fsp.rename(temporaneo, pieno);
      return rispondi(res, 200, { ok: true }, { 'Content-Type': TIPI['.json'], ETag: etag(corpo) });
    });
  }

  return rispondi(res, 405, { errore: 'metodo non ammesso' }, { Allow: 'GET, PUT' });
}

// La pagina dice all'app che è sul server interno: niente OneDrive, dati qui.
let pagina = null;
async function paginaPrincipale() {
  if (!pagina || process.env.SVILUPPO) {
    const html = await fsp.readFile(path.join(RADICE, 'index.html'), 'utf8');
    pagina = Buffer.from(html.replace('<!--RD_SERVER-->', '<script>window.RD_SERVER = true;</script>'));
  }
  return pagina;
}

async function statico(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return rispondi(res, 405, '', { Allow: 'GET' });
  const nome = FILE_APP[url.pathname];
  if (!nome) return rispondi(res, 404, 'non trovato', { 'Content-Type': 'text/plain; charset=utf-8' });
  const buf = nome === 'index.html' ? await paginaPrincipale() : await fsp.readFile(path.join(RADICE, nome));
  const intestazioni = { 'Content-Type': TIPI[path.extname(nome)] || 'application/octet-stream', ETag: etag(buf) };
  if (req.headers['if-none-match'] === intestazioni.ETag) return rispondi(res, 304, '', intestazioni);
  // «no-cache»: il browser chiede sempre se è cambiato, così un aggiornamento arriva subito.
  res.writeHead(200, { ...intestazioni, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function autorizzato(req) {
  if (!PASSWORD) return true;
  const [tipo, valore] = String(req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !valore) return false;
  const data = Buffer.from(valore, 'base64').toString('utf8');
  const fornita = Buffer.from(data.slice(data.indexOf(':') + 1));
  const attesa = Buffer.from(PASSWORD);
  return fornita.length === attesa.length && crypto.timingSafeEqual(fornita, attesa);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!autorizzato(req)) {
      return rispondi(res, 401, 'Serve la password.', {
        'WWW-Authenticate': 'Basic realm="App gestione R&D", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8'
      });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/file') return await api(req, res, url);
    return await statico(req, res, url);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e);
    if (!res.headersSent) rispondi(res, e.codice || 500, { errore: e.codice ? e.message : 'errore del server' });
    else res.end();
  }
});

fs.mkdirSync(DATI, { recursive: true });
server.listen(PORTA, () => {
  console.log(`App gestione R&D sul server interno: http://localhost:${PORTA}/`);
  console.log(`Dati in ${DATI}${PASSWORD ? ' · con password' : ' · senza password'}`);
});
