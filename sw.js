/* Service Worker — cache do app shell + recepção de CSV compartilhado. */
const CACHE = 'projeto-corte-v47';
const SHARE_CACHE = 'projeto-corte-share';
const FONT_CACHE = 'projeto-corte-fonts'; // ícones do Google (persiste entre versões)
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
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

  // Ícones (Material Symbols) do CDN do Google → cache próprio, cache-first,
  // que NÃO é apagado no activate. Garante ícones offline mesmo após um bump
  // de versão (o app shell troca de cache, mas a fonte permanece).
  if (FONT_HOSTS.includes(url.host)) {
    e.respondWith(caches.open(FONT_CACHE).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && (res.status === 200 || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })));
    return;
  }

  // App shell: cache-first PURO. A atualização é ATÔMICA por versão — o install
  // troca o cache inteiro de uma vez (addAll do CACHE novo) e o activate apaga o
  // antigo. NÃO regravamos arquivos avulsos no cache em runtime: isso misturava
  // versões (ex.: index.html novo + app.js antigo), e o JS antigo quebrava ao
  // referenciar elementos já removidos do HTML. Cada versão do SW serve apenas
  // o conjunto coerente da sua própria versão.
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
