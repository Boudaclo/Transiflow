import type { Plugin } from 'vite';
import { APP_NAME, APP_TAGLINE } from '../src/config';

/**
 * Génère `sw.js` à la construction : pré-cache TOUS les fichiers produits (dont les morceaux chargés à la demande
 * de chaque espace), pour que l'application démarre et que /billetterie et /controle s'ouvrent sans réseau,
 * même si l'espace n'a jamais été visité en ligne. La version change à chaque build : l'ancien cache est purgé.
 */
export function pwaPlugin(): Plugin {
  return {
    name: 'transport-pwa',
    // Le nom du produit vient de src/config.ts : titre de page et manifeste en sont déduits.
    transformIndexHtml: (html) => html.replace(/<title>.*?<\/title>/, `<title>${APP_NAME}</title>`),
    generateBundle(_opts, bundle) {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify({
        name: APP_NAME, short_name: APP_NAME, description: APP_TAGLINE, lang: 'fr', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
        background_color: '#0e1d3a', theme_color: '#0e1d3a',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
      }, null, 2) });
      const files = Object.keys(bundle).filter((f) => f !== 'sw.js' && !f.endsWith('.map'));
      const extra = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
      const urls = [...new Set([...extra, ...files.map((f) => `/${f}`)])];
      const version = Date.now().toString(36);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(version, urls) });
    },
  };
}

export function serviceWorkerSource(version: string, urls: string[]): string {
  return `/* Généré par scripts/pwa-plugin.ts : ne pas modifier à la main. */
const CACHE = 'tf-shell-${version}';
const SHELL = ${JSON.stringify(urls)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tf-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // L'API n'est jamais mise en cache ici : les données hors ligne vivent dans IndexedDB (billetterie, contrôle).
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Application monopage : toute navigation retombe sur l'index pré-caché quand le réseau manque.
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
`;
}
