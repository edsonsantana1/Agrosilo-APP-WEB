const CACHE_NAME = 'agrosilo-pwa-v2';
const urlsToCache = [
  '/',
  '/index.html',
  '/pages/dashboard.html',
  '/css/login.css',
  '/css/dashboard.css',
  '/css/style.css',
  '/js/login.js',
  '/js/dashboard.js',
  '/js/config.js',
  '/js/utils.js',
  '/js/auth.js',
  '/images/logo copy.png',
  '/images/icons/icon-72x72.png',
  '/images/icons/icon-120x120.png',
  '/images/icons/icon-144x144.png',
  '/images/icons/icon-152x152.png',
  '/images/icons/icon-180x180.png',
  '/images/icons/icon-512x512.png',
  '/images/icons/icon-1024x1024.png',
  '/manifest.json'
];

// Instalação do Service Worker: armazena os arquivos estáticos no cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Ativação do Service Worker: limpa caches antigos
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Interceptação de requisições: estratégia Cache-first
self.addEventListener('fetch', event => {
  // Para requisições de API (dados), a estratégia deve ser Network-first ou apenas Network-only.
  // Requisições para a API (ex: /api/) não serão cacheadas.
  if (event.request.url.includes('/api/')) {
    return fetch(event.request);
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Retorna o recurso do cache se encontrado
        if (response) {
          return response;
        }
        // Se não estiver no cache, faz a requisição à rede
        return fetch(event.request).then(
          response => {
            // Verifica se recebemos uma resposta válida
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clona a resposta. Uma resposta é um stream e só pode ser consumida uma vez.
            // Precisamos de uma cópia para o cache e outra para o navegador.
            const responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });

            return response;
          }
        );
      })
      .catch(() => {
        // Se a requisição falhar (offline) e não houver cache,
        // podemos retornar uma página offline genérica se tivéssemos uma.
        // Para o login e dashboard, o cache-first deve garantir o acesso offline.
        console.log('Fetch failed, returning from cache or failing.');
      })
  );
});
