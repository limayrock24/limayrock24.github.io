// Service worker mínimo — su sola presencia (con un manejador de "fetch")
// es lo que Chrome/Android exige para ofrecer "Instalar app". No cachea
// nada de forma agresiva a propósito: el sistema depende de datos siempre
// frescos de Firebase, así que cada pedido va directo a la red.
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
