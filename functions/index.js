/**
 * NOTIFICACIONES PUSH — Limay Rock
 *
 * Esta es la pieza que corre EN LA NUBE (no en el celular). Vigila Firestore
 * y, cuando pasa algo que importa, manda la notificación al dispositivo que
 * corresponda — aunque la app esté cerrada.
 *
 * A quién le llega qué:
 *   - Pedidos de delivery  → a los repartidores Y al dueño
 *   - Egresos / pagos      → solo al dueño
 *   - Ingresos de mercadería → solo al dueño
 *   - Precios modificados  → solo al dueño
 *   - Productos nuevos     → solo al dueño
 *   - Mensajes del local a los repartidores → a los repartidores elegidos
 *     (estén disponibles o no)
 *
 * Los "tokens" (la dirección de cada celular) se guardan en la colección
 * fcmTokens desde la propia app cuando el usuario acepta recibir avisos.
 *
 * Copia de referencia del código publicado en Google Cloud (Cloud Run
 * functions, región southamerica-east1). Cada función se publica por separado
 * desde esta misma carpeta (ver functions/README.md).
 */

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

// Región de Firestore del proyecto — tiene que coincidir o la función no se
// entera de los cambios.
const REGION = 'southamerica-east1';

/**
 * Manda una notificación a todos los dispositivos de un tipo de destinatario.
 * @param {string} destino  'dueno' o 'repartidor'
 */
async function notificar(destino, titulo, cuerpo, opciones = {}) {
  const snap = await db.collection('fcmTokens').where('destino', '==', destino).get();
  if (snap.empty) {
    console.log(`Sin dispositivos registrados para "${destino}" — no se manda nada`);
    return;
  }

  const tokens = [];
  snap.forEach(doc => {
    const t = doc.data().token;
    if (t) tokens.push(t);
  });
  if (!tokens.length) return;

  await enviarATokens(tokens, titulo, cuerpo, opciones);
}

/**
 * Manda la notificación a una lista de dispositivos (tokens) y limpia los que
 * ya no existen.
 */
async function enviarATokens(tokens, titulo, cuerpo, opciones = {}) {
  // Se manda como "data" (no como "notification") para que el service worker
  // arme el aviso él mismo. Así se ve igual en todos los dispositivos y se
  // puede controlar el ícono, la vibración y a dónde lleva al tocarlo.
  const mensaje = {
    data: {
      titulo: String(titulo),
      cuerpo: String(cuerpo),
      tag: String(opciones.tag || 'limayrock'),
      url: String(opciones.url || '/')
    },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { 'content-available': 1, sound: 'default' } }
    },
    tokens: tokens
  };

  const res = await getMessaging().sendEachForMulticast(mensaje);
  console.log(`"${titulo}" → ${res.successCount}/${tokens.length} entregadas`);

  // Limpieza: si un dispositivo ya no existe (app desinstalada, token vencido),
  // se borra su registro para no seguir intentando por siempre.
  const aBorrar = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const cod = r.error && r.error.code;
      if (cod === 'messaging/registration-token-not-registered' ||
          cod === 'messaging/invalid-registration-token') {
        aBorrar.push(tokens[i]);
      }
    }
  });
  for (const tk of aBorrar) {
    const viejos = await db.collection('fcmTokens').where('token', '==', tk).get();
    viejos.forEach(d => d.ref.delete());
  }
}

function pesos(n) {
  const num = Number(n) || 0;
  return '$' + num.toLocaleString('es-AR');
}

// ── PEDIDO NUEVO DE DELIVERY ───────────────────────────────────────────────
exports.avisoPedidoNuevo = onDocumentCreated(
  { document: 'pedidosWeb/{id}', region: REGION },
  async (event) => {
    const p = event.data && event.data.data();
    if (!p) return;
    const items = (p.items || []).length;
    const cuerpo = `${p.nombre || 'Cliente'} · ${pesos(p.total)} · ${items} producto${items === 1 ? '' : 's'}` +
      (p.direccion ? `\n📍 ${p.direccion}` : '');

    await notificar('repartidor', '🛵 Pedido nuevo', cuerpo, { tag: 'pedido', url: '/delivery/' });
    await notificar('dueno', '🛵 Pedido nuevo', cuerpo, { tag: 'pedido', url: '/admin/' });
  }
);

// ── EGRESO / PAGO A PROVEEDOR ──────────────────────────────────────────────
exports.avisoEgreso = onDocumentCreated(
  { document: 'egresos/{id}', region: REGION },
  async (event) => {
    const e = event.data && event.data.data();
    if (!e) return;
    const cuerpo = `${e.concepto || e.proveedor || 'Egreso'} · ${pesos(e.monto)}` +
      (e.medio ? ` (${e.medio})` : '') +
      (e.responsable ? `\nCargado por ${e.responsable}` : '');
    await notificar('dueno', '💸 Egreso registrado', cuerpo, { tag: 'egreso', url: '/admin/' });
  }
);

// ── MOVIMIENTOS DE STOCK Y CATÁLOGO ────────────────────────────────────────
// Los ingresos de mercadería, correcciones de stock y bajas se registran todos
// en "movimientos", así que se filtran por tipo para no avisar de las ventas
// (que serían cientos por noche).
exports.avisoMovimientoStock = onDocumentCreated(
  { document: 'movimientos/{id}', region: REGION },
  async (event) => {
    const m = event.data && event.data.data();
    if (!m) return;

    const tiposAvisar = {
      'ingreso': { titulo: '📥 Ingreso de mercadería', tag: 'stock' },
      'ajuste-stock': { titulo: '📋 Corrección de stock', tag: 'stock' },
      'baja-stock': { titulo: '🗑️ Baja de stock', tag: 'stock' }
    };
    const cfg = tiposAvisar[m.tipo];
    if (!cfg) return; // ventas, consumos, fiados, etc: no se avisan

    let cuerpo;
    if (Array.isArray(m.items) && m.items.length) {
      // Recepción de mercadería: un solo movimiento con la lista de productos.
      const MAX = 8;
      const lineas = m.items.slice(0, MAX).map(it => {
        const q = Number(it.qty != null ? it.qty : it.cantidad) || 0;
        return `• ${it.nombre || it.name || '—'} ×${q}` + (it.stock != null ? ` (queda ${it.stock})` : '');
      });
      if (m.items.length > MAX) lineas.push(`… y ${m.items.length - MAX} producto${m.items.length - MAX === 1 ? '' : 's'} más`);
      const unidades = m.items.reduce((t, it) => t + (Number(it.qty != null ? it.qty : it.cantidad) || 0), 0);
      cuerpo = `${m.extra || m.resumen || 'Mercadería'} · ${m.items.length} producto${m.items.length === 1 ? '' : 's'}, ${unidades} u.` +
        (Number(m.total) > 0 ? ` · costo ${pesos(m.total)}` : '') +
        '\n' + lineas.join('\n') +
        (m.responsable ? `\nPor ${m.responsable}` : '');
    } else {
      const cant = Number(m.cantidad) || 0;
      cuerpo = `${m.producto || m.resumen || '—'} · ${cant > 0 ? '+' : ''}${cant} u.` +
        (m.stockAntes != null ? ` (${m.stockAntes} → ${m.stockDespues})` : '') +
        (m.responsable ? `\nPor ${m.responsable}` : '');
    }
    await notificar('dueno', cfg.titulo, cuerpo, { tag: cfg.tag, url: '/admin/' });
  }
);

// ── PRODUCTO NUEVO EN EL CATÁLOGO ──────────────────────────────────────────
exports.avisoProductoNuevo = onDocumentCreated(
  { document: 'productos/{id}', region: REGION },
  async (event) => {
    const p = event.data && event.data.data();
    if (!p) return;
    const cuerpo = `${p.name || '—'}` +
      (p.cat ? ` · ${p.cat}` : '') +
      (p.pventa ? ` · ${pesos(p.pventa)}` : '');
    await notificar('dueno', '🆕 Producto nuevo', cuerpo, { tag: 'catalogo', url: '/admin/' });
  }
);

// ── CAMBIO DE PRECIO ───────────────────────────────────────────────────────
// Solo avisa si cambió el precio de venta o el nocturno. Si se editó otra cosa
// (categoría, código, margen), no molesta.
exports.avisoCambioPrecio = onDocumentUpdated(
  { document: 'productos/{id}', region: REGION },
  async (event) => {
    const antes = event.data && event.data.before.data();
    const ahora = event.data && event.data.after.data();
    if (!antes || !ahora) return;

    const cambios = [];
    if (Number(antes.pventa || 0) !== Number(ahora.pventa || 0)) {
      cambios.push(`Venta: ${pesos(antes.pventa)} → ${pesos(ahora.pventa)}`);
    }
    if (Number(antes.pnoc || 0) !== Number(ahora.pnoc || 0)) {
      cambios.push(`Nocturno: ${pesos(antes.pnoc)} → ${pesos(ahora.pnoc)}`);
    }
    if (!cambios.length) return;

    await notificar('dueno', '💲 Precio modificado',
      `${ahora.name || '—'}\n${cambios.join('\n')}`,
      { tag: 'precio', url: '/admin/' });
  }
);


// ── TURNO ABIERTO ───────────────────────────────────────────────────────────
// sesionesActivas: un documento por empleado, se crea cuando abre turno y se
// borra cuando lo cierra — así, la próxima vez que abra, vuelve a ser un
// documento "nuevo" y este aviso se dispara de nuevo correctamente.
exports.avisoTurnoAbierto = onDocumentCreated(
  { document: 'sesionesActivas/{id}', region: REGION },
  async (event) => {
    const s = event.data && event.data.data();
    if (!s) return;
    const hora = s.turnoInicio
      ? new Date(s.turnoInicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' })
      : '—';
    const cuerpo = `${s.nombre || '—'} · ${s.turno || ''} · ${pesos(s.efectivoInicial)} en caja`;
    await notificar('dueno', `🟢 Turno abierto — ${hora}`, cuerpo, { tag: 'turno', url: '/admin/' });
  }
);

// ── TURNO CERRADO ────────────────────────────────────────────────────────────
// cierres: se crea un documento nuevo por cada cierre (id = fecha), así que
// esto no se dispara de nuevo si después corregís el cierre con "Corregir
// cierre" — esa es una actualización del mismo documento, no uno nuevo.
exports.avisoTurnoCerrado = onDocumentCreated(
  { document: 'cierres/{fecha}', region: REGION },
  async (event) => {
    const c = event.data && event.data.data();
    if (!c) return;
    const hora = c.horaFin
      ? new Date(c.horaFin).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' })
      : '—';

    let estado;
    if (c.automatico) {
      estado = `⚠️ Cierre automático${c.motivoAutomatico ? ' — ' + c.motivoAutomatico : ''}`;
    } else {
      const arqueo = c.arqueo || {};
      const dif = Number(arqueo.diferencia || 0);
      if (dif === 0) estado = '✅ Caja exacta';
      else if (dif < 0) estado = `🔴 Faltan ${pesos(Math.abs(dif))}`;
      else estado = `🟡 Sobran ${pesos(dif)}`;
    }

    const lineas = [`${c.empleado || '—'} · ${c.turno || ''}${duracion(c.durMinutos)}`, estado];
    try { lineas.push(...(await resumenDelTurno(c))); }
    catch (e) { console.error('No se pudo armar el resumen del turno', e); }
    await notificar('dueno', `🔴 Turno cerrado — ${hora}`, lineas.join('\n'), { tag: 'turno', url: '/admin/' });
  }
);

function duracion(min) {
  const m = Number(min) || 0;
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  return ' · ' + (h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
}

// Resumen corto del turno para el aviso de cierre: lo vendido, cómo se cobró,
// los pedidos web que entraron y lo que salió de la caja. Todo sale del mismo
// documento del cierre, salvo los pedidos web (se buscan por la hora).
async function resumenDelTurno(c) {
  const out = [];
  const ventas = Array.isArray(c.ventas) ? c.ventas : [];
  const total = Number(c.total) || 0;
  const cant = Number(c.cantVentas) || ventas.length;
  if (cant) out.push(`💰 Vendió ${pesos(total)} en ${cant} venta${cant === 1 ? '' : 's'} (prom. ${pesos(Math.round(total / cant))})`);
  else out.push('💰 Sin ventas en el turno');

  const porMedio = {};
  ventas.forEach(v => { const m = v.medio || 'Otro'; porMedio[m] = (porMedio[m] || 0) + (Number(v.total) || 0); });
  const iconos = { Efectivo: '💵', 'Débito': '💳', 'Crédito': '💳', Transferencia: '📲', MercadoPago: '📲', Mixto: '🔀' };
  const medios = Object.keys(porMedio).sort((a, b) => porMedio[b] - porMedio[a])
    .map(m => `${iconos[m] || '•'} ${m === 'Transferencia' ? 'Transf.' : m} ${pesos(porMedio[m])}`);
  if (medios.length) out.push(medios.join(' · '));

  const ini = Date.parse(c.horaInicio), fin = Date.parse(c.horaFin);
  if (ini && fin && fin > ini) {
    const snap = await db.collection('pedidosWeb').where('id', '>=', ini).where('id', '<=', fin).get();
    let n = 0, suma = 0;
    snap.forEach(d => { const p = d.data(); if (p.anulado) return; n++; suma += Number(p.total) || 0; });
    if (n) out.push(`🛵 ${n} pedido${n === 1 ? '' : 's'} web (${pesos(suma)})`);
  }

  const a = c.arqueo || {};
  const sal = [];
  if (Number(a.egresosEfectivo) > 0) sal.push(`Egresos ${pesos(a.egresosEfectivo)}`);
  if (Number(a.retirosCaja) > 0) sal.push(`Retiros ${pesos(a.retirosCaja)}`);
  if (sal.length) out.push('🧾 ' + sal.join(' · '));
  return out;
}

// ── MENSAJE DEL LOCAL A LOS REPARTIDORES ───────────────────────────────────
// Se manda desde Admin → Mensajes. Le llega a cada repartidor elegido en todos
// sus celulares registrados, esté DISPONIBLE o no (por eso no se filtra por
// destino 'repartidor'). Solo se saltean los celulares bloqueados.
//
// El aviso de "documento creado" se usa solo para despertar la función: se
// buscan los mensajes de los últimos minutos que todavía no se avisaron y se
// marcan (pushEnviado) dentro de una transacción, así cada uno se manda una
// sola vez aunque la función se despierte dos veces. No depende del formato en
// que llega el evento (publicada con gcloud llega sin los datos del documento).
exports.avisoMensajeRepartidor = onDocumentCreated(
  { document: 'avisosDelivery/{id}', region: REGION },
  async () => {
    const desde = Date.now() - 15 * 60 * 1000;
    const snap = await db.collection('avisosDelivery').where('ts', '>=', desde).get();
    const pendientes = snap.docs.filter(d => !d.data().pushEnviado);
    console.log(`Mensajes a repartidores sin avisar: ${pendientes.length}`);

    for (const doc of pendientes) {
      const tomado = await db.runTransaction(async (tx) => {
        const fresco = await tx.get(doc.ref);
        if (!fresco.exists || fresco.data().pushEnviado) return null;
        tx.update(doc.ref, { pushEnviado: new Date().toISOString() });
        return fresco.data();
      });
      if (!tomado || !tomado.texto) continue;
      await avisarMensaje(doc.id, tomado);
    }
  }
);

async function avisarMensaje(id, m) {
  const para = Array.isArray(m.para) ? m.para.filter(n => typeof n === 'string' && n) : [];
  if (!para.length) return;

  const tokens = [];
  // "in" acepta hasta 30 nombres por consulta.
  for (let i = 0; i < para.length; i += 30) {
    const snap = await db.collection('fcmTokens').where('quien', 'in', para.slice(i, i + 30)).get();
    snap.forEach(doc => {
      const d = doc.data();
      if (d.token && d.destino !== 'repartidor-bloqueado' && d.destino !== 'dueno' && tokens.indexOf(d.token) === -1) {
        tokens.push(d.token);
      }
    });
  }
  console.log(`Mensaje ${id} para ${para.join(', ')}: ${tokens.length} celular(es)`);
  if (!tokens.length) return;
  const cuerpo = String(m.texto).slice(0, 400);
  await enviarATokens(tokens, '📣 Mensaje del local', cuerpo, { tag: 'mensaje', url: '/delivery/' });
}
