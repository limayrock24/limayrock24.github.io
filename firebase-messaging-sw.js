// Service worker de notificaciones — es lo que permite que llegue un aviso
// AUNQUE la app esté cerrada. El navegador lo mantiene registrado en segundo
// plano y lo despierta cuando Firebase le manda algo.
//
// IMPORTANTE: este archivo tiene que vivir en la raíz del sitio
// (limayrock24.github.io/firebase-messaging-sw.js), no dentro de una carpeta,
// porque un service worker solo puede controlar su propia carpeta y las de
// abajo. Desde la raíz cubre /, /admin/, /delivery/ y /catalogo/.

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCuzBomW56nvwUO10WMldYRfkLGwdQmSyM",
  authDomain: "limay-rock-852cb.firebaseapp.com",
  projectId: "limay-rock-852cb",
  storageBucket: "limay-rock-852cb.firebasestorage.app",
  messagingSenderId: "391677998496",
  appId: "1:391677998496:web:e1b0550cf114a2fc39a0c5"
});

var messaging = firebase.messaging();

// Aviso que llega con la app CERRADA o en segundo plano
messaging.onBackgroundMessage(function(payload) {
  var d = payload.data || {};
  var titulo = d.titulo || 'Limay Rock';
  var opciones = {
    body: d.cuerpo || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'limayrock',       // agrupa avisos del mismo tipo
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || '/' }
  };
  return self.registration.showNotification(titulo, opciones);
});

// Al tocar la notificación, abrir la pantalla que corresponde (o enfocar la
// que ya esté abierta, en vez de abrir otra pestaña de más)
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
