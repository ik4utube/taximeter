const CACHE = 'taximeter-v13';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png',
  ...Array.from({ length: 12 }, (_, i) => `img/horse-${String(i + 1).padStart(2, '0')}.png`)];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// network-first: 온라인이면 항상 최신 파일, 오프라인이면 캐시로 실행
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 같은 출처 파일은 브라우저 HTTP 캐시(GitHub Pages 10분)를 건너뛰고 서버에 변경 여부를 확인
  const sameOrigin = new URL(e.request.url).origin === location.origin;
  const req = sameOrigin ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(
    req
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
