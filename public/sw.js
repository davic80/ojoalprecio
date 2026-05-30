/* OjoAlPrecio service worker — shell cache + per-strategy routing.
 *
 * Versioning: the CACHE_VERSION placeholder is replaced at container build
 * time by the deploy SHA (see Dockerfile sed step). Each deploy therefore
 * mints a brand-new cache name; the activate handler deletes any cache
 * whose name doesn't match the current version, so users automatically
 * pick up new CSS/JS without manual cache clears.
 *
 * Strategies:
 *   - cache-first  for static assets under /css, /js, /icons, /splash,
 *     /apple-touch-icon, /manifest.webmanifest. Long-lived, cheap to
 *     refresh in the background.
 *   - network-first for HTML navigation: tries network so prices stay
 *     fresh; falls back to last cached copy when offline.
 *   - pass-through (no caching) for /admin, /auth, /search, /events,
 *     /sitemap.xml, /robots.txt, non-GET requests, and anything outside
 *     this origin.
 */

const CACHE_VERSION = '__APP_COMMIT__';
const CACHE_NAME    = `oap-shell-${CACHE_VERSION}`;

// Files pre-cached on install so the standalone PWA opens instantly the
// first time a user launches from the home screen. Keep this list tiny;
// fetch handler will lazily cache the rest on demand.
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/apple-touch-icon.png',
];

const STATIC_PREFIXES = ['/css/', '/js/', '/icons/', '/splash/'];
const NEVER_CACHE_PREFIXES = ['/admin/', '/auth/', '/account', '/events/', '/api/'];
const NEVER_CACHE_PATHS = ['/sitemap.xml', '/robots.txt', '/sw.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Wipe any cache that isn't the current versioned one. Without this every
  // deploy would accumulate old caches and eventually blow past quota.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n.startsWith('oap-shell-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Hard skip: anything in the never-cache list (admin, auth, dynamic
  // endpoints, the worker itself). Browser handles directly.
  if (NEVER_CACHE_PATHS.includes(url.pathname)) return;
  if (NEVER_CACHE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  // Static assets: cache-first. Background-refresh updates the cached copy
  // for the NEXT load so the user always reads from disk instantly.
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p)) || url.pathname === '/apple-touch-icon.png' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Navigations + everything else GET: network-first so prices stay fresh,
  // fall back to cache when offline.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh in background so the next visit gets the latest version
    // without blocking this response.
    revalidate(cache, req);
    return cached;
  }
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res.ok && req.method === 'GET') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-resort fallback: serve the cached PWA home so the user sees
    // SOMETHING instead of the browser offline page. Same for /ofertas.
    const home = await cache.match('/m') || await cache.match('/ofertas');
    if (home) return home;
    throw _;
  }
}

function revalidate(cache, req) {
  fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  }).catch(() => {});
}
