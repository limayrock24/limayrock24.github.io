// ══════════════════════════════════════════════════════════════════════════
// IDENTIFICACIÓN DEL EQUIPO (seguridad, etapa 1)
//
// Cada panel (venta, admin, delivery) se identifica contra Firebase con una
// cuenta: local@, admin@ o delivery@limayrock.app. La cuenta queda recordada
// en el equipo, así que se pone una sola vez. Los empleados siguen entrando
// con su PIN como siempre: esto es del EQUIPO, no de la persona.
//
// Etapa 1 (esta): NO bloquea nada. Si el equipo no está identificado, el
// sistema funciona igual que antes y muestra un aviso chico para hacerlo.
// Cada equipo deja registrado en "dispositivos" si ya está identificado, para
// poder verificar que estén TODOS antes de cerrar la base (etapa 2).
//
// Importante: las escuchas de la nube (onSnapshot) se arrancan recién cuando
// se sabe si el equipo está identificado — así, cuando la base se cierre,
// ninguna arranca sin la identificación y queda rechazada.
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var CUENTA_SUGERIDA = { venta: 'local@limayrock.app', admin: 'admin@limayrock.app', delivery: 'delivery@limayrock.app' };
  var NOMBRE_PANEL = { venta: 'Panel de venta', admin: 'Panel admin', delivery: 'Panel de delivery' };

  function leer(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function guardar(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

  // Identificador propio de este equipo (no de la persona), para el registro.
  function idDispositivo(){
    var id = leer('lr_dispositivo_id');
    if(!id){
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      guardar('lr_dispositivo_id', id);
    }
    return id;
  }

  window.__lrIniciarIdentificacion = function(panel){
    window.__lrPanel = panel;
    window.__lrUsuario = null;
    if(typeof firebase === 'undefined' || !firebase.auth || !firebase.firestore){
      // Si la librería no cargó, el sistema sigue como antes (etapa 1).
      console.warn('Identificación no disponible: falta la librería de Firebase Auth');
      return;
    }
    var auth = firebase.auth();
    window.__lrAuth = auth;

    // ── Diferir las escuchas hasta saber si el equipo está identificado ──
    var listo = false, pendientes = [];
    function arrancarPendientes(){
      if(listo) return;
      listo = true;
      pendientes.splice(0).forEach(function(f){ try{ f(); }catch(e){ console.error('Error al arrancar una escucha', e); } });
    }
    function diferir(proto){
      if(!proto || !proto.onSnapshot || proto.__lrDiferido) return;
      var original = proto.onSnapshot;
      proto.onSnapshot = function(){
        var self = this, args = arguments;
        if(listo) return original.apply(self, args);
        var desuscribir = null, cancelado = false;
        pendientes.push(function(){ if(!cancelado) desuscribir = original.apply(self, args); });
        return function(){ cancelado = true; if(desuscribir) desuscribir(); };
      };
      proto.__lrDiferido = true;
    }
    diferir(firebase.firestore.Query.prototype);
    diferir(firebase.firestore.DocumentReference.prototype);
    // Red de seguridad: si la identificación no responde en 8 s, se arranca
    // igual (en esta etapa la base todavía está abierta).
    setTimeout(arrancarPendientes, 8000);

    auth.onAuthStateChanged(function(user){
      window.__lrUsuario = user ? user.email : null;
      arrancarPendientes();
      pintarAviso();
      registrarDispositivo();
    });

    // Se vuelve a registrar cada 30 minutos, para saber qué equipos siguen en uso.
    setInterval(registrarDispositivo, 30 * 60000);

    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', armarInterfaz);
    else armarInterfaz();
  };

  function registrarDispositivo(){
    try{
      if(!window.__lrDB) return;
      window.__lrDB.collection('dispositivos').doc(idDispositivo()).set({
        panel: window.__lrPanel || '',
        cuenta: window.__lrUsuario || null,
        nombre: leer('lr_dispositivo_nombre') || '',
        ultimaVez: new Date().toISOString(),
        version: String(window.__LR_BUILD || ''),
        navegador: navigator.userAgent.slice(0, 140)
      }, { merge: true }).catch(function(){});
    }catch(e){}
  }

  // ── Interfaz: aviso chico + ventana para identificar ─────────────────────
  function armarInterfaz(){
    if(document.getElementById('lrIdentAviso')) return;
    var aviso = document.createElement('div');
    aviso.id = 'lrIdentAviso';
    aviso.style.cssText = 'display:none;position:fixed;bottom:44px;left:10px;z-index:99997;background:rgba(20,20,20,.9);color:#F4B400;border:1px solid rgba(244,180,0,.5);font-family:system-ui,sans-serif;font-size:.7rem;font-weight:600;padding:6px 12px;border-radius:20px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
    aviso.textContent = '🔒 Equipo sin identificar · tocá acá';
    aviso.onclick = abrirVentana;
    document.body.appendChild(aviso);

    var ov = document.createElement('div');
    ov.id = 'lrIdentOverlay';
    ov.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.85);align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
    ov.innerHTML =
      '<div style="background:#161616;border:1px solid #333;border-radius:12px;padding:20px;width:100%;max-width:360px;color:#eee">'+
        '<div style="font-size:1.05rem;font-weight:700;margin-bottom:4px">🔒 Identificar este equipo</div>'+
        '<div id="lrIdentSub" style="font-size:.76rem;color:#999;margin-bottom:14px"></div>'+
        '<label style="font-size:.7rem;color:#aaa;text-transform:uppercase;letter-spacing:1px">Usuario</label>'+
        '<input id="lrIdentEmail" type="email" autocomplete="username" style="width:100%;box-sizing:border-box;margin:4px 0 10px;background:#0c0c0c;border:1px solid #333;border-radius:6px;padding:10px;color:#fff;font-size:.9rem">'+
        '<label style="font-size:.7rem;color:#aaa;text-transform:uppercase;letter-spacing:1px">Contraseña</label>'+
        '<input id="lrIdentPass" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;margin:4px 0 10px;background:#0c0c0c;border:1px solid #333;border-radius:6px;padding:10px;color:#fff;font-size:.9rem">'+
        '<label style="font-size:.7rem;color:#aaa;text-transform:uppercase;letter-spacing:1px">Nombre de este equipo</label>'+
        '<input id="lrIdentNombre" type="text" placeholder="Ej: Netbook del local, Compu oficina, Mi celu" style="width:100%;box-sizing:border-box;margin:4px 0 12px;background:#0c0c0c;border:1px solid #333;border-radius:6px;padding:10px;color:#fff;font-size:.9rem">'+
        '<div id="lrIdentError" style="display:none;color:#ff6b6b;font-size:.78rem;margin-bottom:10px"></div>'+
        '<button id="lrIdentBtn" type="button" style="width:100%;background:#2ecc71;color:#052e16;border:none;border-radius:6px;padding:12px;font-weight:700;font-size:.9rem;cursor:pointer">Identificar</button>'+
        '<button id="lrIdentCancelar" type="button" style="width:100%;margin-top:8px;background:transparent;color:#999;border:1px solid #333;border-radius:6px;padding:10px;font-size:.82rem;cursor:pointer">Ahora no</button>'+
      '</div>';
    document.body.appendChild(ov);
    document.getElementById('lrIdentBtn').onclick = identificar;
    document.getElementById('lrIdentCancelar').onclick = cerrarVentana;
    document.getElementById('lrIdentPass').addEventListener('keydown', function(e){ if(e.key === 'Enter') identificar(); });
    pintarAviso();
  }

  function pintarAviso(){
    var aviso = document.getElementById('lrIdentAviso');
    if(!aviso) return;
    aviso.style.display = window.__lrUsuario ? 'none' : 'block';
  }

  function abrirVentana(){
    var ov = document.getElementById('lrIdentOverlay');
    if(!ov) return;
    document.getElementById('lrIdentSub').textContent = (NOMBRE_PANEL[window.__lrPanel] || 'Este panel') + ' · se hace una sola vez en este equipo';
    document.getElementById('lrIdentEmail').value = CUENTA_SUGERIDA[window.__lrPanel] || '';
    document.getElementById('lrIdentPass').value = '';
    document.getElementById('lrIdentNombre').value = leer('lr_dispositivo_nombre') || '';
    document.getElementById('lrIdentError').style.display = 'none';
    ov.style.display = 'flex';
    setTimeout(function(){ document.getElementById('lrIdentPass').focus(); }, 50);
  }
  window.__lrAbrirIdentificacion = abrirVentana;

  function cerrarVentana(){
    var ov = document.getElementById('lrIdentOverlay');
    if(ov) ov.style.display = 'none';
  }

  function mostrarError(txt){
    var el = document.getElementById('lrIdentError');
    el.textContent = txt;
    el.style.display = 'block';
  }

  function identificar(){
    var email = document.getElementById('lrIdentEmail').value.trim().toLowerCase();
    var pass = document.getElementById('lrIdentPass').value;
    var nombre = document.getElementById('lrIdentNombre').value.trim();
    if(!email || !pass){ mostrarError('Completá usuario y contraseña.'); return; }
    if(!nombre){ mostrarError('Poné un nombre para este equipo (ej: Netbook del local).'); return; }
    var btn = document.getElementById('lrIdentBtn');
    btn.disabled = true; btn.textContent = 'Identificando…';
    window.__lrAuth.signInWithEmailAndPassword(email, pass).then(function(){
      guardar('lr_dispositivo_nombre', nombre);
      cerrarVentana();
      registrarDispositivo();
      if(typeof showToast === 'function') showToast('🔒 Equipo identificado como ' + email);
    }).catch(function(e){
      var c = e && e.code || '';
      if(c === 'auth/network-request-failed') mostrarError('Sin internet. Probá de nuevo cuando vuelva la conexión.');
      else if(c === 'auth/too-many-requests') mostrarError('Demasiados intentos. Esperá unos minutos y probá de nuevo.');
      else if(c === 'auth/invalid-email') mostrarError('El usuario no es válido. Revisá cómo está escrito.');
      else mostrarError('Usuario o contraseña incorrectos.');
    }).then(function(){
      btn.disabled = false; btn.textContent = 'Identificar';
    });
  }
})();
