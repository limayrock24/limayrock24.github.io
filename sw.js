// Service worker mínimo — su sola presencia (con un manejador de "fetch")
// es lo que Chrome/Android exige para ofrecer "Instalar app". IMPORTANTE:
// fuerza a ignorar cualquier caché del navegador en cada pedido, porque el
// sistema depende de que los datos y el código estén siempre actualizados
// — una versión vieja cacheada puede hacer que los cambios "no se guarden"
// aunque en realidad el problema sea que ni siquiera se está corriendo el
// código nuevo.
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(function(){
      return fetch(event.request);
    })
  );
});
