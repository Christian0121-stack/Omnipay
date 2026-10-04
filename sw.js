var VERSION = 'omnipay-v1';

var SHELL = [
  './',
  'index.html',
  'styles.css',
  'script.js',
  'manifest.webmanifest',
  'OMNIPAYLOGO.ico',
  'OMNIPAY%20LOGO%204.png',
  'OMNIPAY%20LOGO%205.png'
];

var CDN = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/stellar-sdk/10.4.1/stellar-sdk.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

var CDN_HOSTS = [
  'www.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

var LIVE_PATHS = /^\/(api|webhook|dev|health)(\/|$)/;

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(VERSION);
    await Promise.all(SHELL.map(function (url) {
      return cache.add(url).catch(function () {});
    }));
    await Promise.all(CDN.map(async function (url) {
      try {
        var res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

async function navigationResponse(request) {
  var cache = await caches.open(VERSION);
  try {
    var res = await withTimeout(fetch(request), 4000);
    if (res && res.ok) cache.put('index.html', res.clone());
    return res;
  } catch (e) {
    return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  var cache = await caches.open(VERSION);
  var hit = await cache.match(request);
  var network = fetch(request).then(function (res) {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(function () { return null; });
  return hit || (await network) || Response.error();
}

async function cacheFirst(request) {
  var cache = await caches.open(VERSION);
  var hit = await cache.match(request);
  if (hit) return hit;
  try {
    var res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (LIVE_PATHS.test(url.pathname)) return;
    if (request.mode === 'navigate') {
      event.respondWith(navigationResponse(request));
      return;
    }
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(request));
  }
});