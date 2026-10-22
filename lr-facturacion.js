// ══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN ELECTRÓNICA (ARCA) — lo que se ve en el punto de venta y admin
//
// Esta página NO habla con ARCA: solo marca la venta con "facturaPedido" y
// muestra lo que va respondiendo el servidor (functions/), que es el único
// que tiene el certificado. Los comprobantes viven en la colección
// "facturas" (solo lectura para los equipos).
//
// Se factura lo que entra a Mercado Pago: transferencias y Point (débito).
// En un pago mixto, solo esa parte. Todo sale como "Venta de mercadería".
// Mientras config/facturacion.activa no esté prendido, no aparece nada.
// ══════════════════════════════════════════════════════════════════════════
(function(){
  var CFG = {};               // config/facturacion
  var ESTADO = {};            // facturacionEstado/general (vencimiento del certificado, etc.)
  var LIBS = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'
  };
  var EMISOR_FIJO = { fantasia: 'LIMAY ROCK MINIMARKET 24HS', titular: 'MONSALVE MARTIN EZEQUIEL', cuit: '20-43339489-6', domicilio: 'Pascual Puente 774 - Senillosa, Neuquén', condicion: 'Responsable Monotributo' };
  var COND_IVA_TXT = { 1: 'IVA Responsable Inscripto', 4: 'IVA Sujeto Exento', 5: 'Consumidor Final', 6: 'Responsable Monotributo' };

  function db(){ return window.__lrDB; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function plata(n){ return '$ ' + Number(n||0).toLocaleString('es-AR', {minimumFractionDigits: 0, maximumFractionDigits: 2}); }
  function plata2(n){ return '$ ' + Number(n||0).toLocaleString('es-AR', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function fechaCbteTxt(f){ return f ? f.slice(6,8)+'/'+f.slice(4,6)+'/'+f.slice(0,4) : ''; }
  function docTxt(r){
    if(!r) return '';
    if(r.docTipo === 80){ var c = String(r.docNro); return 'CUIT '+c.slice(0,2)+'-'+c.slice(2,10)+'-'+c.slice(10); }
    if(r.docTipo === 96) return 'DNI '+Number(r.docNro).toLocaleString('es-AR');
    return '';
  }
  function horaTxt(iso){ try{ var d=new Date(iso); return d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
  function toast(msg, err){ if(typeof showToast === 'function') showToast(msg, err); }

  // Lo que entró a Mercado Pago (misma cuenta que hace el servidor).
  function montoMP(medio, mixto, total, recargo){
    if(medio === 'Transferencia' || medio === 'Débito') return Math.round((Number(total)||0)*100)/100;
    if(medio === 'Mixto' && mixto) return Math.round(((Number(mixto.transferencia)||0) + (Number(mixto.debito)||0) + (Number(recargo)||0))*100)/100;
    return 0;
  }
  // Por ahora la facturación es solo de Limay Rock 1 (Pascual Puente).
  var SUC2 = window.__lrSucursal === 2;
  function activa(){ return !SUC2 && !!CFG.activa; }

  function cargarScript(url){
    return new Promise(function(ok, mal){
      var s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = function(){ mal(new Error('No se pudo cargar '+url)); };
      document.head.appendChild(s);
    });
  }
  var _libs = null;
  function libs(){
    if(!_libs) _libs = Promise.all([
      window.jspdf ? null : cargarScript(LIBS.jspdf),
      window.qrcode ? null : cargarScript(LIBS.qr)
    ]).catch(function(e){ _libs = null; throw e; });
    return _libs;
  }

  // ── ESTILOS ─────────────────────────────────────────────────────────────
  var css = ''+
  '.lrf-aviso{border:1.5px solid var(--green);background:rgba(0,204,68,.08);border-radius:6px;padding:10px 12px;margin:10px 0;font-size:.82rem;color:var(--light)}'+
  '.lrf-aviso .t{font-family:Oswald,sans-serif;color:var(--green);letter-spacing:1px;font-size:.82rem;margin-bottom:3px}'+
  '.lrf-aviso b{color:var(--white)}'+
  '.lrf-link{color:var(--gold);text-decoration:underline;cursor:pointer;font-size:.78rem;display:inline-block;margin-top:4px;background:none;border:none;padding:0;font-family:inherit}'+
  '.lrf-rec{display:none;margin-top:8px;gap:6px;flex-direction:column}'+
  '.lrf-rec.show{display:flex}'+
  '.lrf-in{background:var(--card);border:1.5px solid var(--border);border-radius:4px;padding:8px;color:var(--white);font-size:.85rem;font-family:inherit;width:100%;outline:none}'+
  '.lrf-in:focus{border-color:var(--gold)}'+
  '.lrf-nota{font-size:.7rem;color:var(--gray)}'+
  '.lrf-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:3000;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto}'+
  '.lrf-ov.open{display:flex}'+
  '.lrf-box{background:var(--surface);border:2px solid var(--gold);border-radius:8px;padding:16px;width:100%;max-width:360px;margin:auto}'+
  '.lrf-box h3{font-family:Oswald,sans-serif;letter-spacing:2px;text-transform:uppercase;color:var(--gold);font-size:1rem;margin-bottom:10px}'+
  '.lrf-esp{text-align:center;padding:26px 0;color:var(--light);font-size:.9rem}'+
  '.lrf-spin{width:34px;height:34px;border:3px solid var(--border);border-top-color:var(--gold);border-radius:50%;margin:0 auto 12px;animation:lrfgira 1s linear infinite}'+
  '@keyframes lrfgira{to{transform:rotate(360deg)}}'+
  '.lrf-btn{display:block;width:100%;text-align:center;font-family:Oswald,sans-serif;letter-spacing:2px;text-transform:uppercase;padding:12px;border-radius:6px;font-size:.9rem;margin-top:8px;border:none;cursor:pointer}'+
  '.lrf-wa{background:#25D366;color:#063}.lrf-gr{background:var(--card);border:1.5px solid var(--border);color:var(--light)}.lrf-rojo{background:var(--red);color:#fff}'+
  '.lrf-tk{background:#fff;color:#111;border-radius:6px;padding:14px;font-size:.78rem;line-height:1.35;position:relative;overflow:hidden;font-family:Barlow,Arial,sans-serif}'+
  '.lrf-tk .h{text-align:center;font-weight:700;font-size:.95rem}'+
  '.lrf-tk .c{text-align:center}'+
  '.lrf-tk .letra{display:inline-block;border:2px solid #111;font-weight:700;font-size:1.4rem;width:38px;height:38px;line-height:34px;text-align:center;margin:6px 0}'+
  '.lrf-tk hr{border:none;border-top:1px dashed #999;margin:6px 0}'+
  '.lrf-tk .fila{display:flex;justify-content:space-between;gap:8px}'+
  '.lrf-tk .tot{font-weight:700;font-size:.95rem}'+
  '.lrf-tk .qr{display:flex;gap:10px;align-items:center}'+
  '.lrf-tk .qr canvas{width:84px;height:84px;image-rendering:pixelated;flex-shrink:0}'+
  '.lrf-tk .marca{position:absolute;top:44%;left:-10%;width:120%;text-align:center;transform:rotate(-24deg);font-weight:800;font-size:1.25rem;color:rgba(204,0,0,.22);letter-spacing:2px;pointer-events:none}'+
  '.lrf-err{background:rgba(204,0,0,.1);border:1px solid rgba(204,0,0,.35);border-radius:5px;padding:10px;font-size:.8rem;color:#ff8a8a;margin-bottom:6px}'+
  '.lrf-pend{background:rgba(245,194,0,.08);border:1px solid rgba(245,194,0,.35);border-radius:5px;padding:10px;font-size:.82rem;color:var(--light)}'+
  // Admin
  '.lrf-card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px}'+
  '.lrf-r{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:.85rem;padding:4px 0;color:var(--light)}'+
  '.lrf-r b{color:var(--white);font-family:Oswald,sans-serif;font-weight:600}'+
  '.lrf-bar{height:10px;background:var(--surface);border-radius:5px;overflow:hidden;margin:6px 0}'+
  '.lrf-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--gold))}'+
  '.lrf-bar i.alto{background:linear-gradient(90deg,var(--gold),var(--red))}'+
  '.lrf-chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}'+
  '.lrf-chip{font-family:Oswald,sans-serif;font-size:.72rem;letter-spacing:1px;padding:6px 10px;border:1px solid var(--border);border-radius:4px;color:var(--gray);background:var(--surface);cursor:pointer}'+
  '.lrf-chip.on{border-color:var(--gold);color:var(--gold)}'+
  '.lrf-it{display:grid;grid-template-columns:1fr auto;gap:2px 8px;border-bottom:1px solid var(--border);padding:9px 2px;font-size:.82rem;cursor:pointer}'+
  '.lrf-it:hover{background:rgba(255,255,255,.03)}'+
  '.lrf-it .n{font-family:Oswald,sans-serif;letter-spacing:.5px;color:var(--white)}'+
  '.lrf-it .m{text-align:right;font-family:Oswald,sans-serif;color:var(--white)}'+
  '.lrf-it .s{color:var(--gray);font-size:.72rem;grid-column:1/-1}'+
  '.lrf-tag{font-size:.64rem;padding:1px 6px;border-radius:3px;font-family:Oswald,sans-serif;letter-spacing:.5px;margin-left:4px}'+
  '.lrf-tg{background:rgba(0,204,68,.15);color:var(--green)}.lrf-tn{background:rgba(204,0,0,.18);color:#ff6666}.lrf-ty{background:rgba(245,194,0,.15);color:var(--gold)}.lrf-tx{background:rgba(136,136,136,.18);color:var(--gray)}'+
  '.lrf-sw{display:flex;align-items:center;justify-content:space-between;gap:10px}'+
  '.lrf-sw input{width:20px;height:20px;accent-color:var(--green)}'+
  '.lrf-modo{font-family:Oswald,sans-serif;font-size:.72rem;letter-spacing:1px;padding:3px 8px;border-radius:3px}'+
  '.lrf-modo.simulado{background:rgba(52,152,219,.18);color:var(--blue)}.lrf-modo.homologacion{background:rgba(245,194,0,.15);color:var(--gold)}.lrf-modo.produccion{background:rgba(0,204,68,.15);color:var(--green)}'+
  '.lrf-h4{font-family:Oswald,sans-serif;letter-spacing:2px;text-transform:uppercase;color:var(--gold);font-size:.85rem;margin-bottom:6px}'+
  '.lrf-mini{font-size:.72rem;color:var(--gray)}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── CONFIGURACIÓN EN VIVO ───────────────────────────────────────────────
  function escuchar(){
    if(SUC2) return;
    if(!db()){ setTimeout(escuchar, 300); return; }
    db().collection('config').doc('facturacion').onSnapshot(function(s){
      CFG = s.exists ? (s.data() || {}) : {};
      if(_admin.cont && _admin.cont.isConnected) dibujarAdmin();
    }, function(e){ console.warn('Facturación: no se pudo leer la configuración', e && e.code); });
    db().collection('facturacionEstado').doc('general').onSnapshot(function(s){
      ESTADO = s.exists ? (s.data() || {}) : {};
      if(_admin.cont && _admin.cont.isConnected) dibujarAdmin();
    }, function(){});
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', escuchar); else escuchar();

  // ── 1. AVISO EN "CONFIRMÁ LA VENTA" ─────────────────────────────────────
  // carrito: 1 o 2 (cada uno tiene su propio aviso dentro de la misma hoja).
  function avisoConfirm(medio, mixto, total, recargo){
    var hoja = document.querySelector('#confirmOverlay .confirm-sheet');
    if(!hoja) return;
    var aviso = document.getElementById('lrfAviso');
    var monto = activa() ? montoMP(medio, mixto, total, recargo) : 0;
    if(!(monto > 0)){ if(aviso) aviso.style.display = 'none'; return; }
    if(!aviso){
      aviso = document.createElement('div');
      aviso.id = 'lrfAviso'; aviso.className = 'lrf-aviso';
      var btns = hoja.querySelector('.confirm-btns');
      hoja.insertBefore(aviso, btns);
    }
    aviso.style.display = 'block';
    var parcial = medio === 'Mixto' ? ' (la parte de Mercado Pago)' : '';
    aviso.innerHTML =
      '<div class="t">🧾 SE FACTURA AUTOMÁTICO</div>'+
      'Factura C por <b>'+plata(monto)+'</b>'+parcial+' · <span id="lrfAQuien">Consumidor final</span><br>'+
      '<button type="button" class="lrf-link" onclick="__lrFact._toggleRec()">A nombre de… (DNI / CUIT)</button>'+
      '<div class="lrf-rec" id="lrfRec">'+
        '<input class="lrf-in" id="lrfDoc" inputmode="numeric" placeholder="DNI o CUIT del cliente" oninput="__lrFact._docCambio()">'+
        '<input class="lrf-in" id="lrfNombre" placeholder="Nombre o razón social (opcional)">'+
        '<select class="lrf-in" id="lrfCond" style="display:none">'+
          '<option value="1">IVA Responsable Inscripto</option>'+
          '<option value="6">Monotributista</option>'+
          '<option value="4">IVA Exento</option>'+
          '<option value="5">Consumidor Final</option>'+
        '</select>'+
        '<div class="lrf-nota" id="lrfDocNota">Si lo dejás vacío, sale a Consumidor final.</div>'+
      '</div>';
  }
  function toggleRec(){ var r = document.getElementById('lrfRec'); if(r){ r.classList.toggle('show'); if(r.classList.contains('show')) document.getElementById('lrfDoc').focus(); } }
  function cuitValido(s){
    if(!/^\d{11}$/.test(s)) return false;
    var p=[5,4,3,2,7,6,5,4,3,2], t=0; for(var i=0;i<10;i++) t+=Number(s[i])*p[i];
    var dv = 11 - (t % 11); if(dv===11) dv=0; if(dv===10) dv=9; return dv === Number(s[10]);
  }
  function docCambio(){
    var d = (document.getElementById('lrfDoc').value||'').replace(/\D/g,'');
    var cond = document.getElementById('lrfCond'), nota = document.getElementById('lrfDocNota'), q = document.getElementById('lrfAQuien');
    cond.style.display = d.length === 11 ? 'block' : 'none';
    if(!d){ nota.textContent = 'Si lo dejás vacío, sale a Consumidor final.'; nota.style.color=''; q.textContent='Consumidor final'; return; }
    if(d.length === 11){
      var ok = cuitValido(d);
      nota.textContent = ok ? 'CUIT '+d.slice(0,2)+'-'+d.slice(2,10)+'-'+d.slice(10)+' ✓' : '⚠ Ese CUIT no es válido, revisalo';
      nota.style.color = ok ? 'var(--green)' : 'var(--red)';
      q.textContent = ok ? 'CUIT '+d : 'Consumidor final';
    } else if(d.length >= 7 && d.length <= 8){
      nota.textContent = 'DNI '+Number(d).toLocaleString('es-AR')+' ✓'; nota.style.color='var(--green)'; q.textContent='DNI '+Number(d).toLocaleString('es-AR');
    } else { nota.textContent = 'Un DNI tiene 7 u 8 números; un CUIT, 11'; nota.style.color='var(--gold)'; q.textContent='Consumidor final'; }
  }

  // ── 2. MARCAR LA VENTA ──────────────────────────────────────────────────
  // Se llama justo antes de guardar la venta. Devuelve el pedido de factura
  // (o null si no corresponde) y deja el formulario limpio para la próxima.
  // opc.nombre: a nombre de quién (cobros de fiado o consignación, que no
  // pasan por la hoja de confirmación).
  function pedidoParaVenta(v, opc){
    var rec = { doc: '', nombre: (opc && opc.nombre) || '', condIva: 5 };
    var elDoc = document.getElementById('lrfDoc');
    if(elDoc){
      var d = (elDoc.value||'').replace(/\D/g,'');
      if(d.length === 11 && cuitValido(d)){ rec.doc = d; rec.condIva = Number(document.getElementById('lrfCond').value)||1; }
      else if(d.length >= 7 && d.length <= 8) rec.doc = d;
      rec.nombre = (document.getElementById('lrfNombre').value||'').trim() || rec.nombre;
      var aviso = document.getElementById('lrfAviso'); if(aviso) aviso.remove();
    }
    if(!activa() || !(montoMP(v.medio, v.mixto, v.total, v.recargo) > 0)) return null;
    return { receptor: rec, pedido: new Date().toISOString() };
  }

  // ── 3. COMPROBANTE (después de cobrar, o desde el admin) ────────────────
  var _modal = { unsub: null, timer: null, f: null };
  function overlay(){
    var ov = document.getElementById('lrfModal');
    if(!ov){
      ov = document.createElement('div'); ov.id = 'lrfModal'; ov.className = 'lrf-ov';
      ov.innerHTML = '<div class="lrf-box" id="lrfModalBox"></div>';
      ov.addEventListener('click', function(e){ if(e.target === ov) cerrarModal(); });
      document.body.appendChild(ov);
    }
    return ov;
  }
  function cerrarModal(){
    if(_modal.unsub){ _modal.unsub(); _modal.unsub = null; }
    if(_modal.timer){ clearTimeout(_modal.timer); _modal.timer = null; }
    var ov = document.getElementById('lrfModal'); if(ov) ov.classList.remove('open');
  }
  function verFactura(id, despuesDeVenta){
    if(_modal.unsub) _modal.unsub();
    if(_modal.timer) clearTimeout(_modal.timer);
    var ov = overlay(), box = document.getElementById('lrfModalBox');
    box.innerHTML = '<h3>🧾 Factura</h3><div class="lrf-esp"><div class="lrf-spin"></div>Generando la factura en ARCA…</div>'+
      '<button class="lrf-btn lrf-gr" onclick="__lrFact.cerrar()">Cerrar</button>';
    ov.classList.add('open');
    var demorada = false;
    // Si en 20 segundos no hay respuesta, se avisa que queda pendiente (el
    // servidor la sigue intentando solo; no hace falta hacer nada).
    _modal.timer = setTimeout(function(){ demorada = true; if(!_modal.f || _modal.f.estado === 'pendiente' || _modal.f.estado === 'emitiendo') pintar(_modal.f, true); }, 20000);
    _modal.f = null;
    _modal.unsub = db().collection('facturas').doc(String(id)).onSnapshot(function(s){
      _modal.f = s.exists ? Object.assign({ id: s.id }, s.data()) : null;
      if(_modal.f || demorada) pintar(_modal.f, demorada);
    }, function(e){ box.innerHTML = '<h3>🧾 Factura</h3><div class="lrf-err">No se pudo leer la factura ('+esc(e && e.code)+').</div><button class="lrf-btn lrf-gr" onclick="__lrFact.cerrar()">Cerrar</button>'; });
  }
  function pintar(f, demorada){
    var box = document.getElementById('lrfModalBox'); if(!box) return;
    var titulo = '<h3>🧾 '+(f && f.tipo === 'NC' ? 'Nota de crédito' : 'Factura')+'</h3>';
    var cerrar = '<button class="lrf-btn lrf-gr" onclick="__lrFact.cerrar()">Cerrar</button>';
    if(f && f.estado === 'aprobada'){
      box.innerHTML = titulo + ticketHTML(f) +
        '<button class="lrf-btn lrf-wa" onclick="__lrFact.whatsapp()">📲 Mandar por WhatsApp</button>'+
        '<button class="lrf-btn lrf-gr" onclick="__lrFact.pdf()">⬇ Descargar PDF</button>' + cerrar;
      dibujarQR(box.querySelector('canvas[data-qr]'), f.qrUrl);
      if(_modal.timer){ clearTimeout(_modal.timer); _modal.timer = null; }
      return;
    }
    if(f && f.estado === 'rechazada'){
      box.innerHTML = titulo + '<div class="lrf-err"><b>ARCA no aceptó el comprobante.</b><br>'+esc(f.error || 'Sin detalle')+'</div>'+
        '<div class="lrf-mini">La venta quedó registrada igual. Avisale al encargado: lo ve en Admin → Dinero → Facturas.</div>' + cerrar;
      return;
    }
    if(f && f.estado === 'cancelada'){
      box.innerHTML = titulo + '<div class="lrf-pend">La venta se anuló antes de emitir la factura, así que no se emitió nada.</div>' + cerrar;
      return;
    }
    if(demorada || (f && f.estado === 'pendiente' && f.error)){
      box.innerHTML = titulo + '<div class="lrf-pend">⏳ <b>La factura quedó pendiente.</b><br>ARCA no respondió todavía. El sistema la sigue intentando solo; no hace falta hacer nada.'+
        (f && f.error ? '<div class="lrf-mini" style="margin-top:6px">Detalle: '+esc(f.error)+'</div>' : '')+'</div>' + cerrar;
      return;
    }
  }

  function ticketHTML(f){
    var em = CFG.emisor || {};
    var nc = f.tipo === 'NC';
    var marca = f.modo === 'produccion' ? '' : '<div class="marca">'+(f.modo === 'homologacion' ? 'PRUEBA ARCA · NO VÁLIDO' : 'SIMULADO · NO VÁLIDO')+'</div>';
    var rec = f.receptor || {};
    var recTxt = docTxt(rec);
    return '<div class="lrf-tk">'+marca+
      '<div class="h">'+esc(EMISOR_FIJO.fantasia)+'</div>'+
      '<div class="c">'+esc(em.razonSocial || EMISOR_FIJO.titular)+'<br>'+esc(EMISOR_FIJO.domicilio)+'<br>CUIT '+EMISOR_FIJO.cuit+' · '+EMISOR_FIJO.condicion+
        (em.iibb ? '<br>IIBB: '+esc(em.iibb) : '')+(em.inicio ? ' · Inicio act.: '+esc(em.inicio) : '')+'</div>'+
      '<div class="c"><span class="letra">C</span><br><b>'+(nc ? 'NOTA DE CRÉDITO' : 'FACTURA')+'</b> · Cód. '+(nc ? '013' : '011')+'</div>'+
      '<div class="fila"><span>Pto. Vta: '+String(f.ptoVta).padStart(5,'0')+'</span><span>Nº '+String(f.numero).padStart(8,'0')+'</span></div>'+
      '<div class="fila"><span>Fecha: '+fechaCbteTxt(f.fechaCbte)+'</span><span>'+esc(COND_IVA_TXT[rec.condIva] || 'Consumidor Final')+'</span></div>'+
      (recTxt || rec.nombre ? '<div>Cliente: '+esc(rec.nombre || '')+(rec.nombre && recTxt ? ' · ' : '')+recTxt+'</div>' : '')+
      (nc && f.asociadoTxt ? '<div>Anula Factura C '+esc(f.asociadoTxt)+'</div>' : '')+
      '<hr><div class="fila"><span>Venta de mercadería</span><span>'+plata2(f.importe)+'</span></div><hr>'+
      '<div class="fila tot"><span>TOTAL</span><span>'+plata2(f.importe)+'</span></div><hr>'+
      '<div class="qr"><canvas data-qr width="84" height="84"></canvas>'+
        '<div style="font-size:.7rem">CAE: '+esc(f.cae)+'<br>Vto. CAE: '+fechaCbteTxt(f.caeVto)+'<br><i>Comprobante autorizado por ARCA</i></div></div>'+
    '</div>';
  }

  // QR dibujado a mano sobre un canvas (sirve igual para la pantalla y el PDF).
  function matrizQR(url){
    var q = window.qrcode(0, 'M'); q.addData(url); q.make(); return q;
  }
  function dibujarQR(canvas, url){
    if(!canvas || !url) return;
    libs().then(function(){
      var q = matrizQR(url), n = q.getModuleCount(), t = 4, borde = 2;
      canvas.width = canvas.height = (n + borde*2) * t;
      var c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0,0,canvas.width,canvas.height); c.fillStyle = '#000';
      for(var y=0;y<n;y++) for(var x=0;x<n;x++) if(q.isDark(y,x)) c.fillRect((x+borde)*t,(y+borde)*t,t,t);
    }).catch(function(){ /* sin internet: queda sin QR en pantalla, el PDF lo reintenta */ });
  }

  function armarPDF(f){
    return libs().then(function(){
      var em = CFG.emisor || {};
      var nc = f.tipo === 'NC', rec = f.receptor || {};
      var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [80, 160] });
      var y = 8, cx = 40;
      function linea(t, opc){ opc = opc || {}; doc.setFont('helvetica', opc.b ? 'bold' : 'normal'); doc.setFontSize(opc.s || 8);
        if(opc.der){ doc.text(String(opc.der), 75, y, {align:'right'}); doc.text(String(t), 5, y); }
        else doc.text(String(t), opc.izq ? 5 : cx, y, { align: opc.izq ? 'left' : 'center', maxWidth: 70 });
        y += opc.alto || 4; }
      function corte(){ doc.setLineDashPattern([1,1],0); doc.line(5, y-2, 75, y-2); y += 2; }
      linea(EMISOR_FIJO.fantasia, {b:1, s:10, alto:5});
      linea(em.razonSocial || EMISOR_FIJO.titular);
      linea(EMISOR_FIJO.domicilio);
      linea('CUIT '+EMISOR_FIJO.cuit+' - '+EMISOR_FIJO.condicion);
      if(em.iibb || em.inicio) linea((em.iibb ? 'IIBB: '+em.iibb : '')+(em.iibb && em.inicio ? ' - ' : '')+(em.inicio ? 'Inicio act.: '+em.inicio : ''));
      y += 1; doc.setLineDashPattern([],0); doc.rect(cx-5, y, 10, 10); doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.text('C', cx, y+7.3, {align:'center'}); y += 15;
      linea((nc ? 'NOTA DE CRÉDITO' : 'FACTURA')+' - Cód. '+(nc ? '013' : '011'), {b:1, s:9, alto:5});
      linea('Pto. Vta: '+String(f.ptoVta).padStart(5,'0'), {izq:1, der:'Nº '+String(f.numero).padStart(8,'0')});
      linea('Fecha: '+fechaCbteTxt(f.fechaCbte), {izq:1, der:COND_IVA_TXT[rec.condIva] || 'Consumidor Final'});
      var recTxt = docTxt(rec);
      if(recTxt || rec.nombre) linea('Cliente: '+(rec.nombre||'')+(rec.nombre && recTxt ? ' - ' : '')+recTxt, {izq:1});
      if(nc && f.asociadoTxt) linea('Anula Factura C '+f.asociadoTxt, {izq:1});
      y += 2; corte();
      linea('Venta de mercadería', {izq:1, der:plata2(f.importe)});
      y += 1; corte();
      linea('TOTAL', {izq:1, der:plata2(f.importe), b:1, s:11, alto:6});
      corte();
      var cv = document.createElement('canvas'); dibujarQRsync(cv, f.qrUrl);
      doc.addImage(cv.toDataURL('image/png'), 'PNG', 5, y, 28, 28);
      var yq = y + 6; doc.setFont('helvetica','normal'); doc.setFontSize(8);
      doc.text('CAE: '+f.cae, 36, yq); doc.text('Vto. CAE: '+fechaCbteTxt(f.caeVto), 36, yq+4);
      doc.setFont('helvetica','italic'); doc.text('Comprobante autorizado', 36, yq+9); doc.text('por ARCA', 36, yq+13);
      if(f.modo !== 'produccion'){ doc.setTextColor(204,0,0); doc.setFont('helvetica','bold'); doc.setFontSize(11);
        doc.text(f.modo === 'homologacion' ? 'PRUEBA ARCA - NO VÁLIDO' : 'SIMULADO - NO VÁLIDO', cx, 70, {align:'center', angle: 20}); doc.setTextColor(0,0,0); }
      return doc;
    });
  }
  function dibujarQRsync(canvas, url){
    var q = matrizQR(url), n = q.getModuleCount(), e = 8, b = 2;
    canvas.width = canvas.height = (n + b*2) * e;
    var c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0,0,canvas.width,canvas.height); c.fillStyle = '#000';
    for(var y=0;y<n;y++) for(var x=0;x<n;x++) if(q.isDark(y,x)) c.fillRect((x+b)*e,(y+b)*e,e,e);
  }
  function nombreArchivo(f){ return (f.tipo === 'NC' ? 'NotaCredito_C_' : 'Factura_C_') + (f.numeroTxt || f.id) + '.pdf'; }
  function pdf(){
    var f = _modal.f; if(!f) return;
    armarPDF(f).then(function(doc){ doc.save(nombreArchivo(f)); })
      .catch(function(){ toast('No se pudo armar el PDF (¿hay internet?)', true); });
  }
  function textoWhatsApp(f){
    return 'Limay Rock Minimarket 24hs — '+(f.tipo === 'NC' ? 'Nota de crédito C ' : 'Factura C ')+f.numeroTxt+' por '+plata2(f.importe)+'. ¡Gracias por tu compra! Verificala en ARCA: '+f.qrUrl;
  }
  function whatsapp(){
    var f = _modal.f; if(!f) return;
    armarPDF(f).then(function(doc){
      var archivo = null;
      try{ archivo = new File([doc.output('blob')], nombreArchivo(f), { type: 'application/pdf' }); }catch(e){}
      // En el celu: se comparte el PDF directo (se elige WhatsApp y el contacto).
      if(archivo && navigator.canShare && navigator.canShare({ files: [archivo] })){
        return navigator.share({ files: [archivo], text: textoWhatsApp(f) }).catch(function(){});
      }
      // En la compu: se abre WhatsApp con el texto y el link de ARCA.
      window.open('https://wa.me/?text=' + encodeURIComponent(textoWhatsApp(f)), '_blank');
    }).catch(function(){ window.open('https://wa.me/?text=' + encodeURIComponent(textoWhatsApp(f)), '_blank'); });
  }

  // Después de guardar una venta con pedido de factura.
  function ventaGuardada(v){
    if(!v || !v.facturaPedido) return;
    libs().catch(function(){});
    // Primero se deja ver el "Venta registrada" de siempre.
    setTimeout(function(){ verFactura(v.id, true); }, 1200);
  }

  // ── 4. ADMIN → DINERO → FACTURAS ────────────────────────────────────────
  var _admin = { cont: null, mes: null, filtro: 'todas', lista: [], pend: [], unsub: null, unsubP: null, resumen: {}, unsubR: null, abiertaCfg: false };
  function mesActual(){ var d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function rangoMes(m){ var a = Number(m.slice(0,4)), b = Number(m.slice(5,7)); return [new Date(a, b-1, 1).toISOString(), new Date(a, b, 1).toISOString()]; }

  function renderAdmin(cont){
    if(SUC2){
      cont.innerHTML = '<div class="lrf-card"><div class="lrf-h4">🧾 Facturación electrónica</div><div class="lrf-mini">Por ahora la facturación electrónica está solo en Limay Rock 1.</div></div>';
      return;
    }
    _admin.cont = cont;
    if(!_admin.mes) _admin.mes = mesActual();
    suscribirMes();
    if(!_admin.unsubP) _admin.unsubP = db().collection('facturas').where('estado', 'in', ['pendiente','emitiendo','rechazada']).onSnapshot(function(s){
      _admin.pend = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      dibujarAdmin();
    }, function(e){ console.warn('Facturas pendientes:', e && e.code); });
    if(!_admin.unsubR) _admin.unsubR = db().collection('facturacionEstado').onSnapshot(function(s){
      var r = {}; s.docs.forEach(function(d){ if(d.id.indexOf('mes_') === 0) r[d.id.slice(4)] = d.data(); });
      _admin.resumen = r; dibujarAdmin();
    }, function(){});
    dibujarAdmin();
  }
  function suscribirMes(){
    if(_admin.unsub){ _admin.unsub(); _admin.unsub = null; }
    var r = rangoMes(_admin.mes);
    _admin.lista = null;
    _admin.unsub = db().collection('facturas').where('creada', '>=', r[0]).where('creada', '<', r[1]).orderBy('creada', 'desc').onSnapshot(function(s){
      _admin.lista = s.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
      dibujarAdmin();
    }, function(e){ _admin.lista = []; _admin.error = e && e.code; dibujarAdmin(); });
  }
  // Total de los últimos 12 meses (facturas menos notas de crédito).
  function total12(){
    var t = 0, d = new Date();
    for(var i=0;i<12;i++){
      var k = new Date(d.getFullYear(), d.getMonth()-i, 1);
      var r = _admin.resumen[k.getFullYear()+String(k.getMonth()+1).padStart(2,'0')];
      if(r) t += Number(r.total)||0;
    }
    return t;
  }
  function etiqueta(f){
    if(f.estado === 'aprobada') return f.tipo === 'NC' ? '<span class="lrf-tag lrf-tn">N. CRÉDITO</span>' : (f.ventaAnulada ? '<span class="lrf-tag lrf-tx">ANULADA</span>' : '<span class="lrf-tag lrf-tg">OK</span>');
    if(f.estado === 'rechazada') return '<span class="lrf-tag lrf-tn">RECHAZADA</span>';
    if(f.estado === 'cancelada') return '<span class="lrf-tag lrf-tx">NO EMITIDA</span>';
    return '<span class="lrf-tag lrf-ty">PENDIENTE</span>';
  }
  function itemHTML(f){
    var rec = f.receptor || {};
    var quien = docTxt(rec) || 'Cons. final';
    var nombre = f.estado === 'aprobada' ? (f.tipo === 'NC' ? 'NC C ' : 'FC C ')+f.numeroTxt : 'Venta #'+String(f.ventaId).slice(-6);
    var det = horaTxt(f.creada)+' · '+(f.caja ? 'Caja '+f.caja+' · ' : '')+esc(f.empleado || '')+' · '+quien+
      (f.tipo === 'NC' && f.asociadoTxt ? ' · anula FC '+esc(f.asociadoTxt) : '');
    var extra = '';
    if(f.estado !== 'aprobada' && f.error) extra = '<div class="s" style="color:'+(f.estado==='rechazada'?'#ff8a8a':'var(--gold)')+'">'+esc(f.error)+'</div>';
    if(f.estado === 'pendiente' || f.estado === 'rechazada') extra += '<div class="s"><button class="lrf-chip" style="margin-top:4px" onclick="event.stopPropagation();__lrFact.reintentar(\''+esc(f.id)+'\')">↻ Reintentar ahora</button></div>';
    var monto = (f.tipo === 'NC' ? '−' : '')+plata(f.importe);
    return '<div class="lrf-it" onclick="__lrFact.ver(\''+esc(f.id)+'\')"><div><span class="n">'+nombre+'</span>'+etiqueta(f)+'</div>'+
      '<div class="m"'+(f.tipo==='NC'?' style="color:#ff6666"':'')+'>'+monto+'</div><div class="s">'+det+'</div>'+extra+'</div>';
  }
  function dibujarAdmin(){
    var cont = _admin.cont; if(!cont || !cont.isConnected) return;
    var lista = _admin.lista;
    var modo = ESTADO.modo || (lista && lista[0] && lista[0].modo) || 'simulado';
    var aprob = (lista||[]).filter(function(f){ return f.estado === 'aprobada'; });
    var totalMes = aprob.reduce(function(s,f){ return s + (f.tipo === 'NC' ? -1 : 1) * (Number(f.importe)||0); }, 0);
    var cant = aprob.filter(function(f){ return f.tipo !== 'NC'; }).length;
    var tope = Number(CFG.topeAnual)||0, t12 = total12();
    var pct = tope ? Math.min(100, Math.round(t12 / tope * 100)) : 0;
    var filtro = _admin.filtro;
    var vis = filtro === 'problemas' ? _admin.pend : (lista||[]).filter(function(f){
      if(filtro === 'nc') return f.tipo === 'NC';
      return true;
    });
    var venceTxt = '';
    if(ESTADO.certVence){
      var meses = Math.round((new Date(ESTADO.certVence) - Date.now()) / (30.4*24*3600*1000));
      venceTxt = '<div class="lrf-mini" style="margin-top:6px;color:'+(meses<=1?'var(--red)':'var(--gray)')+'">'+(meses<=1?'⚠ ':'')+'Certificado de ARCA vence el '+new Date(ESTADO.certVence).toLocaleDateString('es-AR')+(meses>0?' (en '+meses+' meses)':'')+'</div>';
    }
    var em = CFG.emisor || {};
    var html =
      '<div class="lrf-card">'+
        '<div class="lrf-sw"><div><div class="lrf-h4" style="margin:0">🧾 Facturación electrónica</div>'+
          '<div class="lrf-mini">Factura C automática de lo cobrado por Mercado Pago</div></div>'+
          '<input type="checkbox" '+(CFG.activa?'checked':'')+' onchange="__lrFact.activar(this.checked)" title="Prender / apagar"></div>'+
        '<div class="lrf-r" style="margin-top:6px"><span>Estado</span><span>'+(CFG.activa?'<b style="color:var(--green)">PRENDIDA</b>':'<b style="color:var(--gray)">APAGADA</b>')+' &nbsp;<span class="lrf-modo '+esc(modo)+'">'+(modo==='produccion'?'ARCA REAL':modo==='homologacion'?'ARCA PRUEBAS':'SIMULADO')+'</span></span></div>'+
        (modo !== 'produccion' ? '<div class="lrf-mini">'+(modo==='homologacion'?'Conectado al ambiente de pruebas de ARCA: los comprobantes no valen.':'Todavía no está conectado a ARCA: los comprobantes son de prueba y no valen.')+'</div>' : '')+
        venceTxt+
      '</div>'+
      '<div class="lrf-card">'+
        '<div class="lrf-r"><span>Mes</span><input type="month" class="lrf-in" style="width:auto;padding:5px 8px" value="'+_admin.mes+'" onchange="__lrFact.mes(this.value)"></div>'+
        '<div class="lrf-r"><span>Facturado en el mes</span><b>'+plata(totalMes)+'</b></div>'+
        '<div class="lrf-r"><span>Facturas</span><b>'+cant+'</b></div>'+
        (_admin.pend.length ? '<div class="lrf-r"><span>Pendientes o con problemas</span><b style="color:var(--gold)">'+_admin.pend.length+'</b></div>' : '')+
        '<div class="lrf-r" style="margin-top:6px"><span>Últimos 12 meses'+(tope?' vs tope de tu categoría':'')+'</span><b>'+plata(t12)+(tope?' · '+pct+'%':'')+'</b></div>'+
        (tope ? '<div class="lrf-bar"><i class="'+(pct>=80?'alto':'')+'" style="width:'+pct+'%"></i></div>' :
          '<div class="lrf-mini">Cargá el tope anual de tu categoría del monotributo en "Datos de la factura" para ver cuánto te falta.</div>')+
      '</div>'+
      '<div class="lrf-chips">'+
        '<button class="lrf-chip '+(filtro==='todas'?'on':'')+'" onclick="__lrFact.filtro(\'todas\')">Todas</button>'+
        '<button class="lrf-chip '+(filtro==='problemas'?'on':'')+'" onclick="__lrFact.filtro(\'problemas\')">⏳ Pendientes / rechazadas'+(_admin.pend.length?' ('+_admin.pend.length+')':'')+'</button>'+
        '<button class="lrf-chip '+(filtro==='nc'?'on':'')+'" onclick="__lrFact.filtro(\'nc\')">Notas de crédito</button>'+
      '</div>'+
      '<div>'+(lista === null && filtro !== 'problemas' ? '<div class="lrf-mini" style="padding:14px 0">Cargando…</div>' :
        (vis.length ? vis.map(itemHTML).join('') : '<div class="lrf-mini" style="padding:14px 0">'+(filtro==='problemas'?'No hay facturas pendientes ni rechazadas. 👌':'No hay comprobantes en este mes.')+'</div>'))+'</div>'+
      '<button class="lrf-btn lrf-gr" onclick="__lrFact.exportar()">⬇ Exportar el mes para la contadora</button>'+
      '<div class="lrf-card" style="margin-top:12px">'+
        '<div class="lrf-sw" style="cursor:pointer" onclick="__lrFact.toggleCfg()"><div class="lrf-h4" style="margin:0">⚙ Datos de la factura</div><span class="lrf-mini">'+(_admin.abiertaCfg?'▲':'▼')+'</span></div>'+
        (_admin.abiertaCfg ?
          '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">'+
          '<div class="lrf-mini">Lo que va impreso en cada comprobante. Los datos fijos (CUIT, domicilio, monotributo) ya están.</div>'+
          '<label class="lrf-mini">Nombre y apellido (titular)</label><input class="lrf-in" id="lrfCfgRazon" value="'+esc(em.razonSocial||'')+'" placeholder="'+EMISOR_FIJO.titular+'">'+
          '<label class="lrf-mini">Ingresos Brutos Neuquén (número)</label><input class="lrf-in" id="lrfCfgIibb" value="'+esc(em.iibb||'')+'">'+
          '<label class="lrf-mini">Inicio de actividades</label><input class="lrf-in" id="lrfCfgInicio" value="'+esc(em.inicio||'')+'" placeholder="dd/mm/aaaa">'+
          '<label class="lrf-mini">Tope anual de tu categoría del monotributo ($)</label><input class="lrf-in" id="lrfCfgTope" inputmode="numeric" value="'+(CFG.topeAnual||'')+'" placeholder="Te lo pasa la contadora">'+
          '<button class="lrf-btn lrf-rojo" onclick="__lrFact.guardarCfg()">Guardar</button></div>' : '')+
      '</div>';
    cont.innerHTML = html;
  }
  function guardarConfig(datos){
    return db().collection('config').doc('facturacion').set(datos, { merge: true });
  }
  function activar(on){
    var p = on ? (typeof askConfirm === 'function' ? askConfirm('¿Prendés la facturación automática? Desde ahora, cada cobro por Mercado Pago va a generar una Factura C.') : Promise.resolve(true)) : Promise.resolve(true);
    p.then(function(ok){
      if(!ok){ dibujarAdmin(); return; }
      guardarConfig({ activa: !!on, cambiada: new Date().toISOString() }).then(function(){ toast(on ? 'Facturación prendida' : 'Facturación apagada'); })
        .catch(function(){ toast('No se pudo guardar', true); dibujarAdmin(); });
    });
  }
  function guardarCfg(){
    var tope = Number((document.getElementById('lrfCfgTope').value||'').replace(/\D/g,''))||0;
    guardarConfig({
      emisor: { razonSocial: document.getElementById('lrfCfgRazon').value.trim(), iibb: document.getElementById('lrfCfgIibb').value.trim(), inicio: document.getElementById('lrfCfgInicio').value.trim() },
      topeAnual: tope
    }).then(function(){ _admin.abiertaCfg = false; toast('Datos guardados'); dibujarAdmin(); }).catch(function(){ toast('No se pudo guardar', true); });
  }
  function reintentar(id){
    db().collection('facturacionSolicitudes').add({ accion: 'reintentar', facturaId: String(id), pedido: new Date().toISOString(), por: window.__lrUsuario || null })
      .then(function(){ toast('Reintentando…'); }).catch(function(){ toast('No se pudo pedir el reintento', true); });
  }
  function exportar(){
    var lista = (_admin.lista||[]);
    if(!lista.length){ toast('No hay comprobantes en este mes', true); return; }
    var filas = [['Fecha','Tipo','Punto de venta','Número','CAE','Vto CAE','Receptor','Documento','Importe','Estado','Venta','Caja','Empleado','Medio']];
    lista.slice().reverse().forEach(function(f){
      var rec = f.receptor || {};
      filas.push([fechaCbteTxt(f.fechaCbte) || horaTxt(f.creada), f.tipo === 'NC' ? 'Nota de crédito C' : 'Factura C', f.ptoVta, f.numero || '', f.cae || '', fechaCbteTxt(f.caeVto),
        COND_IVA_TXT[rec.condIva] || '', rec.docTipo === 99 ? '' : (rec.docNro || ''), String((f.tipo === 'NC' ? -1 : 1) * (Number(f.importe)||0)).replace('.', ','), f.estado, f.ventaId, f.caja || '', f.empleado || '', f.medio || '']);
    });
    var csv = '﻿' + filas.map(function(r){ return r.map(function(c){ c = String(c == null ? '' : c); return /[;"\n]/.test(c) ? '"'+c.replace(/"/g,'""')+'"' : c; }).join(';'); }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'Facturas_LimayRock_' + _admin.mes + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  window.__lrFact = {
    montoMP: montoMP,
    activa: activa,
    avisoConfirm: avisoConfirm,
    pedidoParaVenta: pedidoParaVenta,
    ventaGuardada: ventaGuardada,
    ver: function(id){ verFactura(id, false); },
    cerrar: cerrarModal,
    pdf: pdf,
    whatsapp: whatsapp,
    renderAdmin: renderAdmin,
    activar: activar,
    reintentar: reintentar,
    exportar: exportar,
    guardarCfg: guardarCfg,
    toggleCfg: function(){ _admin.abiertaCfg = !_admin.abiertaCfg; dibujarAdmin(); },
    mes: function(m){ if(m){ _admin.mes = m; suscribirMes(); dibujarAdmin(); } },
    filtro: function(f){ _admin.filtro = f; dibujarAdmin(); },
    _toggleRec: toggleRec,
    _docCambio: docCambio
  };
})();
