// Il service worker del prototipo: tiene in cache la pagina perché si apra anche
// senza rete. Prima la rete e poi la cache, e non il contrario: il prototipo cambia
// spesso, e con la cache per prima un aggiornamento arriverebbe solo al secondo avvio.
// I dati non passano di qui: stanno in localStorage, e la sincronizzazione con
// OneDrive va verso altri domini, che questo service worker lascia stare.

const CACHE = 'laser-v21';
const FILE = ['./', 'index.html', 'effetti.js', 'pc.js', 'ore.js', 'manifest.webmanifest', 'icona-rd-180.png', 'icona-rd-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(chiavi => Promise.all(chiavi.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;

  // «no-cache» chiede sempre al server se il file è cambiato: senza, il browser
  // potrebbe rispondere con la sua copia dei 10 minuti di GitHub Pages.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(risposta => {
        const copia = risposta.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return risposta;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
