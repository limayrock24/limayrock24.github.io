// Service worker mínimo del catálogo — su sola presencia (con un manejador de
// "fetch") es lo que Chrome/Android exige para ofrecer "Instalar app". Fuerza
// a ignorar cualquier caché del navegador en cada pedido, para que el
// catálogo (precios, stock, combos) esté siempre actualizado.
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(nombres){
      return Promise.all(nombres.map(function(n){ return caches.delete(n); }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(function(){
      return fetch(event.request);
    })
  );
});
