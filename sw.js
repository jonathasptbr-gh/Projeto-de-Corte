/* Service Worker — cache do app shell + recepção de CSV compartilhado. */
const CACHE = 'projeto-corte-v21';
const SHARE_CACHE = 'projeto-corte-share';
const SHARE_KEY = 'shared-csv';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/csv.js',
  './js/optimizer.js',
  './js/render.js',
  './js/budget.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Guarda o texto do CSV compartilhado (+ nome do arquivo) para a página ler.
async function stashShared(text, name) {
  const c = await caches.open(SHARE_CACHE);
  await c.put(SHARE_KEY, new Response(text, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'X-File-Name': encodeURIComponent(name || '') }
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Recepção de arquivo compartilhado (Web Share Target) — chega via POST.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('file') || form.get('files');
        if (file && typeof file.text === 'function') {
          const text = await file.text();
          if (text && text.trim()) await stashShared(text, file.name || '');
        }
      } catch (err) { /* ignora */ }
      // volta para o app, sinalizando que há um CSV pendente
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  e.respondWith(
    caches.match(req).then(cached => {
      const fetched = fetch(req).then(res => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
