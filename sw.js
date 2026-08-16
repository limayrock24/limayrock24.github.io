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

// ── NOTIFICACIONES ──────────────────────────────────────────────────────────
// Este service worker y firebase-messaging-sw.js compiten por el mismo alcance
// (la raíz del sitio). Cuando gana este, la notificación llegaba pero no la
// mostraba nadie, y Chrome ponía el aviso genérico "Este sitio se actualizó en
// segundo plano" — sin título, sin contenido y con el botón de anular
// suscripción. Por eso hay que manejar el push acá también.
self.addEventListener('push', function(event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch(e) { d = {}; }
  // Las notificaciones se mandan como "data" desde la Cloud Function
  var info = d.data || d;
  var titulo = info.titulo || 'Limay Rock';
  var opciones = {
    body: info.cuerpo || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: info.tag || 'limayrock',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: info.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var destino = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(lista) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf(destino) !== -1 && 'focus' in lista[i]) {
          return lista[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(destino);
    })
  );
});
