/**
 * Eye on the Sky — Service Worker
 * Proporciona soporte 100% offline para el editor académico y dashboard.
 * Permite que la app abra y funcione incluso si el navegador se cierra,
 * se recarga o se pierde la conexión a internet.
 */

const CACHE_NAME = 'eots-offline-v3.3';

const STATIC_ASSETS = [
  './',
  'index.html',
  'dashboard.html',
  'styles.css',
  'styles.css?v=1.1',
  'styles.css?v=1.2',
  'styles.css?v=1.3',
  'styles.css?v=1.4',
  'styles.css?v=1.5',
  'styles.css?v=1.6',
  'styles.css?v=1.7',
  'styles.css?v=1.8',
  'styles.css?v=1.9',
  'styles.css?v=2.0',
  'editor.js',
  'editor.js?v=1.3',
  'editor.js?v=1.4',
  'editor.js?v=1.5',
  'editor.js?v=1.6',
  'editor.js?v=1.7',
  'editor.js?v=1.8',
  'editor.js?v=1.9',
  'editor.js?v=2.0',
  'dashboard.js',
  'dashboard.js?v=2.0',
  'config.js',
  'cloud.js',
  'cloud.js?v=3.0',
  'cloud.js?v=3.3',
  'config.js?v=3.3',
  'config.js?v=3.0',
  'analytics.js?v=3.0',
  'editor.js?v=3.0',
  'styles.css?v=3.0',
  'captures.js?v=3.0',
  'dashboard.js?v=3.0',
  'dashboard.js?v=3.3',
  'analytics.js',
  'analytics.js?v=2.0',
  'captures.js',
  'captures.js?v=2.0',
  'manifest.json',
  'icon.svg',
  // Sonidos
  'sounds/autosave_peace.mp3',
  'sounds/export_success.mp3',
  'sounds/milestone_words.mp3',
  'sounds/paste_alert.mp3',
  'sounds/session_start.mp3',
  'sounds/session_start1.mp3',
  'sounds/session_start2.mp3',
  'sounds/session_start3.mp3',
  'sounds/session_start4.mp3',
  'sounds/source_captured.mp3',
  // Librerías externas desde CDN
  'https://cdn.quilljs.com/1.3.7/quill.snow.css',
  'https://cdn.quilljs.com/1.3.7/quill.js',
  'https://unpkg.com/docx@8.5.0/build/index.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,600;1,400&display=swap'
];

// Instalación: Precarga tolerante a fallos
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Usamos Promise.allSettled para que un fallo en un recurso externo no impida registrar el resto
      await Promise.allSettled(
        STATIC_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { mode: 'cors' });
            const response = await fetch(req);
            if (response.ok || response.type === 'opaque') {
              return await cache.put(url, response);
            }
          } catch (err) {
            // Intento alternativo en modo no-cors si falló por CORS
            try {
              const fallbackResponse = await fetch(url, { mode: 'no-cors' });
              return await cache.put(url, fallbackResponse);
            } catch (fallbackErr) {
              console.warn('[ServiceWorker] No se pudo precargar recurso:', url);
            }
          }
        })
      );
    })
  );
});

// Activación: Limpieza de cachés antiguas y control inmediato
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Estrategia de Fetch
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo interceptar peticiones GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Evitar interceptar esquemas especiales (extensiones de chrome, data:, blob:)
  if (!url.protocol.startsWith('http')) return;

  // 1. Peticiones de navegación (cuando el usuario recarga la página o abre la app)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          // Si estamos sin conexión (offline), servir desde caché
          const cached = await caches.match(req);
          if (cached) return cached;

          // Si navegaba a una URL relativa de editor o raíz, fallback a index.html
          if (url.pathname.includes('dashboard.html')) {
            return (await caches.match('dashboard.html')) || (await caches.match('./dashboard.html'));
          }
          return (await caches.match('index.html')) || (await caches.match('./index.html')) || (await caches.match('./'));
        })
    );
    return;
  }

  // 2. Scripts y estilos locales de la propia aplicación: Network-First con fallback a caché
  // Esto garantiza que en teléfonos Android y navegadores móviles los cambios se reflejen
  // de inmediato al recargar cuando hay conexión, sin quedar atrapados en un caché obsoleto.
  const isSameOriginCode = (url.origin === self.location.origin) &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'));

  if (isSameOriginCode) {
    // config.js nunca se guarda: siempre la versión vigente del servidor (la URL del curso
    // puede cambiar). El resto se revalida con el servidor saltándose la caché HTTP.
    const isConfig = url.pathname.endsWith('/config.js');
    event.respondWith(
      fetch(req, { cache: isConfig ? 'no-store' : 'no-cache' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || new Response('', { status: 408, statusText: 'Offline and asset not cached' });
        })
    );
    return;
  }

  // 3. Recursos estáticos externos y multimedia (Fuentes, Sonidos, CDNs, Iconos):
  // Estrategia: Cache-First con actualización silenciosa en segundo plano (Stale-While-Revalidate)
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Error de red ignorado: la versión en caché será utilizada
        });

      return cachedResponse || fetchPromise;
    })
  );
});
