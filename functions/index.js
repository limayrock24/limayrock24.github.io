/**
 * NOTIFICACIONES PUSH — Limay Rock
 *
 * Esta es la pieza que corre EN LA NUBE (no en el celular). Vigila Firestore
 * y, cuando pasa algo que importa, manda la notificación al dispositivo que
 * corresponda — aunque la app esté cerrada.
 *
 * A quién le llega qué:
 *   - Pedidos de delivery  → a los repartidores Y al dueño (con la prioridad
 *     activada, primero solo a los repartidores con prioridad)
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
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

// Región de Firestore del proyecto — tiene que coincidir o la función no se
// entera de los cambios.
const REGION = 'southamerica-east1';

// Clave de la cuenta de Mercado Pago de Limay 1, guardada como secreto en la
// nube (ver la sección MERCADO PAGO más abajo).
const { defineSecret } = require('firebase-functions/params');
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');

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
// Con la prioridad activada (config/deliveryActivo.prioridad), el pedido les
// llega primero solo a los repartidores con prioridad que estén disponibles.
// Se marca en el pedido (p.prioridad) a quiénes y hasta cuándo; la app de
// delivery se lo oculta a los demás mientras tanto. Después, cada minuto,
// liberarPrioridadVencida avisa al resto: si alguien lo tomó, igual les llega
// el aviso normal (y al entrar ven "ya fue tomado"); si nadie lo tomó, queda
// para todos.
function textoPedido(p) {
  const items = (p.items || []).length;
  return `${p.nombre || 'Cliente'} · ${pesos(p.total)} · ${items} producto${items === 1 ? '' : 's'}` +
    (p.direccion ? `\n📍 ${p.direccion}` : '');
}

// Tokens de los repartidores disponibles (destino 'repartidor'), filtrando por nombre.
async function tokensRepartidores(filtro) {
  const snap = await db.collection('fcmTokens').where('destino', '==', 'repartidor').get();
  const tokens = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (d.token && filtro(d.quien) && tokens.indexOf(d.token) === -1) tokens.push(d.token);
  });
  return tokens;
}

// Repartidores con prioridad que pueden tomar el pedido ahora: disponibles,
// con acceso a pedidos y sin llegar al límite de pedidos a la vez.
async function prioritariosDisponibles(cfg) {
  const lista = Array.isArray(cfg.prioridad && cfg.prioridad.reps) ? cfg.prioridad.reps : [];
  if (!lista.length) return [];
  const max = (cfg.maxPedidosRep === undefined || cfg.maxPedidosRep === null || cfg.maxPedidosRep === '') ? 2 : Number(cfg.maxPedidosRep);
  const emps = await db.collection('empleados').get();
  const disp = [];
  for (const doc of emps.docs) {
    const e = doc.data();
    if (!e || lista.indexOf(e.nombre) === -1) continue;
    if (!e.accesoDelivery || !e.disponibleDelivery || e.sinPedidos) continue;
    if (max > 0) {
      const suyos = await db.collection('pedidosWeb').where('repartidor', '==', e.nombre).get();
      const enCurso = suyos.docs.filter(d => {
        const x = d.data();
        return !x.anulado && x.estadoDelivery !== 'entregado' && x.estado !== 'resuelto';
      }).length;
      if (enCurso >= max) continue;
    }
    disp.push(e.nombre);
  }
  return disp;
}

exports.avisoPedidoNuevo = onDocumentCreated(
  { document: 'pedidosWeb/{id}', region: REGION },
  async (event) => {
    const p = event.data && event.data.data();
    if (!p) return;
    const cuerpo = textoPedido(p);

    const cfgDoc = await db.collection('config').doc('deliveryActivo').get();
    const cfg = cfgDoc.exists ? cfgDoc.data() : {};
    const pr = cfg.prioridad || {};
    const reps = (pr.activa && !p.repartidor) ? await prioritariosDisponibles(cfg) : [];

    if (reps.length) {
      const minutos = [2, 3, 5].indexOf(Number(pr.minutos)) >= 0 ? Number(pr.minutos) : 3;
      await event.data.ref.update({
        prioridad: { estado: 'reservado', reps, hasta: Date.now() + minutos * 60000, desde: Date.now() }
      });
      console.log(`Pedido ${event.params.id}: prioridad para ${reps.join(', ')} (${minutos} min)`);
      const tokens = await tokensRepartidores(q => reps.indexOf(q) !== -1);
      if (tokens.length) await enviarATokens(tokens, '🛵 Pedido nuevo', cuerpo, { tag: 'pedido', url: '/delivery/' });
    } else {
      // Sin prioridad (apagada o ningún prioritario disponible): a todos, como siempre.
      if (pr.activa) await event.data.ref.update({ prioridad: { estado: 'libre' } });
      await notificar('repartidor', '🛵 Pedido nuevo', cuerpo, { tag: 'pedido', url: '/delivery/' });
    }
    await notificar('dueno', '🛵 Pedido nuevo', cuerpo, { tag: 'pedido', url: '/admin/' });
  }
);

// ── PRIORIDAD: AVISO AL RESTO ──────────────────────────────────────────────
// Cada minuto revisa los pedidos reservados. Si un prioritario ya lo tomó, o
// si se terminó el tiempo, les manda el aviso de pedido nuevo a los demás
// repartidores disponibles (a los prioritarios ya les llegó). Se marca dentro
// de una transacción para que cada pedido se avise una sola vez.
exports.liberarPrioridadVencida = onSchedule(
  { schedule: 'every 1 minutes', region: REGION, timeZone: 'America/Argentina/Buenos_Aires' },
  async () => {
    const snap = await db.collection('pedidosWeb').where('prioridad.estado', '==', 'reservado').get();
    for (const doc of snap.docs) {
      const res = await db.runTransaction(async (tx) => {
        const fresco = await tx.get(doc.ref);
        if (!fresco.exists) return null;
        const p = fresco.data();
        const pr = p.prioridad || {};
        if (pr.estado !== 'reservado') return null;
        const vencido = Date.now() >= Number(pr.hasta || 0);
        if (!p.repartidor && !vencido) return null;
        const estado = p.repartidor ? 'tomado' : 'liberado';
        tx.update(doc.ref, { 'prioridad.estado': estado, 'prioridad.avisadoResto': Date.now() });
        return { p, estado };
      });
      if (!res) continue;
      const { p, estado } = res;
      const reps = Array.isArray(p.prioridad && p.prioridad.reps) ? p.prioridad.reps : [];
      if (p.anulado || p.estado === 'resuelto') continue;
      console.log(`Pedido ${doc.id}: ${estado} — aviso al resto de los repartidores`);
      const tokens = await tokensRepartidores(q => reps.indexOf(q) === -1);
      if (tokens.length) await enviarATokens(tokens, '🛵 Pedido nuevo', textoPedido(p), { tag: 'pedido', url: '/delivery/' });
    }
  }
);

// ── EGRESO / PAGO A PROVEEDOR ──────────────────────────────────────────────
// Limay Rock 2 guarda lo suyo en colecciones con "l2_" adelante: los avisos de
// allá llevan "[LR2]" en el título y abren el admin de Limay 2.
const LR1 = { col: '', etq: '', url: '/admin/' };
const LR2 = { col: 'l2_', etq: '[LR2] ', url: '/admin/?suc=2' };

function avisoEgreso(L) {
  return async (event) => {
    const e = event.data && event.data.data();
    if (!e) return;
    const cuerpo = `${e.concepto || e.proveedor || 'Egreso'} · ${pesos(e.monto)}` +
      (e.medio ? ` (${e.medio})` : '') +
      (e.responsable ? `\nCargado por ${e.responsable}` : '');
    await notificar('dueno', L.etq + '💸 Egreso registrado', cuerpo, { tag: L.col + 'egreso', url: L.url });
  };
}
exports.avisoEgreso = onDocumentCreated({ document: 'egresos/{id}', region: REGION }, avisoEgreso(LR1));
exports.avisoEgresoL2 = onDocumentCreated({ document: 'l2_egresos/{id}', region: REGION }, avisoEgreso(LR2));

// ── MOVIMIENTOS DE STOCK Y CATÁLOGO ────────────────────────────────────────
// Los ingresos de mercadería, correcciones de stock y bajas se registran todos
// en "movimientos", así que se filtran por tipo para no avisar de las ventas
// (que serían cientos por noche).
function avisoMovimientoStock(L) {
  return async (event) => {
    const m = event.data && event.data.data();
    if (!m) return;

    const tiposAvisar = {
      'ingreso': { titulo: '📥 Ingreso de mercadería', tag: 'stock' },
      'ajuste-stock': { titulo: '📋 Corrección de stock', tag: 'stock' },
      'baja-stock': { titulo: '🗑️ Baja de stock', tag: 'stock' },
      'traspaso': { titulo: '🔁 Traspaso entre locales', tag: 'traspaso' }
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
    await notificar('dueno', L.etq + cfg.titulo, cuerpo, { tag: L.col + cfg.tag, url: L.url });
  };
}
exports.avisoMovimientoStock = onDocumentCreated({ document: 'movimientos/{id}', region: REGION }, avisoMovimientoStock(LR1));
exports.avisoMovimientoStockL2 = onDocumentCreated({ document: 'l2_movimientos/{id}', region: REGION }, avisoMovimientoStock(LR2));

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
    // Cambios en bloque (precios sugeridos, precios de noche automáticos): no
    // se manda un aviso por cada producto.
    if (ahora.cambioMasivo && ahora.cambioMasivo !== antes.cambioMasivo) return;

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
function avisoTurnoAbierto(L) {
  return async (event) => {
    const s = event.data && event.data.data();
    if (!s) return;
    const hora = s.turnoInicio
      ? new Date(s.turnoInicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' })
      : '—';
    // Con dos cajas en el local, se aclara en cuál abrió.
    const caja = Number(s.caja) === 2 ? 'Caja 2 · ' : (Number(s.caja) === 1 ? 'Caja 1 · ' : '');
    const cuerpo = `${caja}${s.nombre || '—'} · ${s.turno || ''} · ${pesos(s.efectivoInicial)} en caja`;
    await notificar('dueno', L.etq + `🟢 Turno abierto — ${hora}`, cuerpo, { tag: L.col + 'turno', url: L.url });
  };
}
exports.avisoTurnoAbierto = onDocumentCreated({ document: 'sesionesActivas/{id}', region: REGION }, avisoTurnoAbierto(LR1));
exports.avisoTurnoAbiertoL2 = onDocumentCreated({ document: 'l2_sesionesActivas/{id}', region: REGION }, avisoTurnoAbierto(LR2));

// ── TURNO CERRADO ────────────────────────────────────────────────────────────
// cierres: se crea un documento nuevo por cada cierre (id = fecha), así que
// esto no se dispara de nuevo si después corregís el cierre con "Corregir
// cierre" — esa es una actualización del mismo documento, no uno nuevo.
function avisoTurnoCerrado(L) {
  return async (event) => {
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

    const cajaC = Number(c.caja) === 2 ? 'Caja 2 · ' : (Number(c.caja) === 1 ? 'Caja 1 · ' : '');
    const lineas = [`${cajaC}${c.empleado || '—'} · ${c.turno || ''}${duracion(c.durMinutos)}`, estado];
    // Con cuánto quedó la caja (lo que contó el empleado) y con cuánto había abierto.
    const aq = c.arqueo || {};
    if (!c.automatico && aq.contado !== undefined && aq.contado !== null) {
      lineas.push(`💵 Cerró con ${pesos(Number(aq.contado) || 0)} en caja` +
        (aq.efectivoInicial !== undefined && aq.efectivoInicial !== null ? ` (abrió con ${pesos(Number(aq.efectivoInicial) || 0)})` : ''));
    }
    try { lineas.push(...(await resumenDelTurno(c, L))); }
    catch (e) { console.error('No se pudo armar el resumen del turno', e); }
    // Cierre de Mercado Pago hecho solo: se guarda en el cierre y va en el aviso.
    if (!L.col && !c.automatico) {
      try { const linMP = await cierreMPAutomatico(event.data.ref, c); if (linMP) lineas.push(...linMP); }
      catch (e) { console.error('No se pudo hacer el cierre de Mercado Pago', e); lineas.push('📲 MP: no se pudo revisar (revisalo desde el admin)'); }
    }
    await notificar('dueno', L.etq + `🔴 Turno cerrado — ${hora}`, lineas.join('\n'), { tag: L.col + 'turno', url: L.url });
  };
}
exports.avisoTurnoCerrado = onDocumentCreated({ document: 'cierres/{fecha}', region: REGION, secrets: [MP_ACCESS_TOKEN], timeoutSeconds: 120 }, avisoTurnoCerrado(LR1));
exports.avisoTurnoCerradoL2 = onDocumentCreated({ document: 'l2_cierres/{fecha}', region: REGION }, avisoTurnoCerrado(LR2));

function duracion(min) {
  const m = Number(min) || 0;
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  return ' · ' + (h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
}

// Resumen corto del turno para el aviso de cierre: lo vendido, cómo se cobró,
// los pedidos web que entraron y lo que salió de la caja. Todo sale del mismo
// documento del cierre, salvo los pedidos web (se buscan por la hora).
async function resumenDelTurno(c, L) {
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
  // El delivery es solo de Limay 1.
  if (ini && fin && fin > ini && !(L && L.col)) {
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
  const titulo = (typeof m.titulo === 'string' && m.titulo.trim()) ? m.titulo.trim().slice(0, 60) : '📣 Mensaje del local';
  await enviarATokens(tokens, titulo, cuerpo, { tag: 'mensaje', url: '/delivery/' });
}

// ── INGRESO DE REPARTIDORES (PIN verificado en la nube) ────────────────────
// La app de delivery ya no baja la lista de empleados con los PIN: manda el
// PIN acá, se verifica contra la base y, si está bien, se le da a ESE celular
// un permiso a nombre de ese repartidor (un "token" con su nombre y el del
// celular). Las reglas de la base revisan en cada pedido de datos que el
// repartidor siga existiendo y con acceso, y que el celular no esté dado de
// baja: si se lo borra o se da de baja el celular, pierde el acceso al
// instante. 5 PIN mal seguidos en un celular → 30 segundos de espera.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getAuth } = require('firebase-admin/auth');

const INTENTOS_MAX = 5;
const ESPERA_MS = 30 * 1000;

function idSeguroDoc(s) { return String(s || '').replace(/\//g, '-').slice(0, 120); }

// Lo que la app de delivery puede ver de cada repartidor (sin PIN).
function datosPublicosRepartidor(e) {
  return {
    nombre: e.nombre,
    accesoDelivery: !!e.accesoDelivery,
    disponibleDelivery: !!e.disponibleDelivery,
    sinPedidos: !!e.sinPedidos,
    rol: e.rol || '',
    activo: e.activo !== false
  };
}

// Copia sin PIN de los repartidores (repartidoresPub), al día con empleados.
async function sincronizarEspejoRepartidores() {
  const [emps, pub] = await Promise.all([db.collection('empleados').get(), db.collection('repartidoresPub').get()]);
  const quedan = {};
  const lote = db.batch();
  let cambios = 0;
  emps.forEach(doc => {
    const e = doc.data();
    if (!e || !e.accesoDelivery) return;
    quedan[doc.id] = true;
    const nuevo = datosPublicosRepartidor(e);
    const viejo = pub.docs.find(d => d.id === doc.id);
    if (!viejo || JSON.stringify(viejo.data()) !== JSON.stringify(nuevo)) { lote.set(db.collection('repartidoresPub').doc(doc.id), nuevo); cambios++; }
  });
  pub.forEach(d => { if (!quedan[d.id]) { lote.delete(d.ref); cambios++; } });
  if (cambios) await lote.commit();
}

exports.accesoRepartidor = onCall({ region: REGION }, async (req) => {
  const auth = req.auth;
  const tk = (auth && auth.token) || {};
  // Solo un celular habilitado: identificado con la cuenta de delivery, o que
  // ya tiene el permiso de equipo que da esta misma función.
  const esDelivery = tk.email === 'delivery@limayrock.app';
  if (!auth || (!esDelivery && !tk.disp)) throw new HttpsError('permission-denied', 'Este celular no está habilitado');
  const disp = idSeguroDoc(tk.disp || (req.data && req.data.disp));
  if (!disp) throw new HttpsError('invalid-argument', 'Falta el identificador del celular');
  const refDisp = db.collection('dispositivos').doc(disp);
  const d = await refDisp.get();
  if (d.exists && d.data().baja) throw new HttpsError('permission-denied', 'Este celular fue dado de baja. Hablá con el administrador.');
  if (!d.exists) await refDisp.set({ panel: 'delivery', cuenta: 'delivery@limayrock.app', creado: new Date().toISOString() }, { merge: true });

  const uid = 'disp_' + disp;
  const accion = (req.data && req.data.accion) || 'entrar';
  if (accion === 'salir') {
    // Queda solo el permiso del celular (sin repartidor adentro).
    return { token: await getAuth().createCustomToken(uid, { disp }) };
  }

  // Límite de intentos por celular.
  const refInt = db.collection('intentosPin').doc(disp);
  const ahora = Date.now();
  const int = (await refInt.get()).data() || {};
  if (int.bloqueadoHasta && int.bloqueadoHasta > ahora) {
    return { ok: false, motivo: 'bloqueado', espera: Math.ceil((int.bloqueadoHasta - ahora) / 1000) };
  }
  const pin = String((req.data && req.data.pin) || '');
  if (!/^\d{4}$/.test(pin)) throw new HttpsError('invalid-argument', 'PIN inválido');
  const emps = await db.collection('empleados').get();
  let emp = null, idEmp = null;
  emps.forEach(doc => {
    const e = doc.data();
    if (!emp && e && String(e.pin) === pin && e.activo !== false && (e.accesoDelivery || e.rol === 'admin')) { emp = e; idEmp = doc.id; }
  });
  if (!emp) {
    const fallos = (int.fallos || 0) + 1;
    if (fallos >= INTENTOS_MAX) {
      await refInt.set({ fallos: 0, bloqueadoHasta: ahora + ESPERA_MS, ultimo: new Date().toISOString() });
      return { ok: false, motivo: 'bloqueado', espera: ESPERA_MS / 1000 };
    }
    await refInt.set({ fallos, bloqueadoHasta: 0, ultimo: new Date().toISOString() });
    return { ok: false, motivo: 'pin', quedan: INTENTOS_MAX - fallos };
  }
  await refInt.set({ fallos: 0, bloqueadoHasta: 0, ultimo: new Date().toISOString() });
  await refDisp.set({ quien: idEmp }, { merge: true });
  try { await sincronizarEspejoRepartidores(); } catch (e) { console.warn('espejo repartidores', e.message); }
  const token = await getAuth().createCustomToken(uid, { disp, rep: idEmp });
  return { ok: true, token, emp: datosPublicosRepartidor(emp) };
});

// Cada cambio en empleados actualiza la copia sin PIN. Si se borra un
// repartidor, sus celulares quedan dados de baja.
exports.espejoRepartidores = onDocumentWritten(
  { document: 'empleados/{id}', region: REGION },
  async (event) => {
    const id = event.params.id;
    const despues = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    const antes = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const ref = db.collection('repartidoresPub').doc(id);
    if (despues && despues.accesoDelivery) {
      const nuevo = datosPublicosRepartidor(despues);
      const actual = await ref.get();
      if (!actual.exists || JSON.stringify(actual.data()) !== JSON.stringify(nuevo)) await ref.set(nuevo);
    } else {
      await ref.delete().catch(() => {});
    }
    // Sacarle el acceso ya lo frena (lo revisan las reglas); borrarlo además
    // da de baja sus celulares.
    const seFue = antes && antes.accesoDelivery && !despues;
    if (seFue) {
      const celus = await db.collection('dispositivos').where('quien', '==', id).get();
      for (const c of celus.docs) {
        await c.ref.set({ baja: true, bajaEn: new Date().toISOString(), bajaMotivo: 'repartidor borrado' }, { merge: true });
      }
      if (celus.size) console.log(`${id}: ${celus.size} celular(es) dados de baja`);
    }
  }
);

// ── PRODUCTOS SINCRONIZADOS ENTRE LIMAY ROCK 1 Y 2 ─────────────────────────
// Un producto que está en los dos locales queda igual en los dos: si se cambia
// en uno (precio, costo, código, categoría, foto, margen…), se copia al otro.
// No se crea en el otro local si no estaba (eso se hace con "Pasar a Limay 2")
// y no se borra. El stock es de cada local (va aparte, en inventario). Si en
// cualquiera de los dos está marcado "No sincronizar", no se copia.
const NO_SINCRONIZAR = ['sinSincronizar'];
function datosASincronizar(p) {
  const o = {};
  Object.keys(p || {}).sort().forEach(k => { if (NO_SINCRONIZAR.indexOf(k) === -1) o[k] = p[k]; });
  return o;
}
async function sincronizarProductoEntreLocales(event, destino) {
  const despues = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!despues || despues.sinSincronizar) return;
  // Solo se copian CAMBIOS de un producto que ya existía. Un producto que
  // recién aparece en un local (pasado desde el otro, creado ahí, o cargado
  // por error en bloque) nunca pisa al del otro local.
  const antes = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  if (!antes) return;
  const ref = db.collection(destino).doc(event.params.id);
  const otro = await ref.get();
  if (!otro.exists) return;
  const o = otro.data();
  if (o.sinSincronizar) return;
  const nuevo = datosASincronizar(despues);
  if (JSON.stringify(nuevo) === JSON.stringify(datosASincronizar(o))) return; // ya está igual: corta el ida y vuelta
  const borrar = {};
  Object.keys(o).forEach(k => { if (NO_SINCRONIZAR.indexOf(k) === -1 && !(k in nuevo)) borrar[k] = FieldValue.delete(); });
  await ref.set(Object.assign({}, nuevo, borrar), { merge: true });
  console.log(`Producto ${event.params.id} copiado a ${destino}`);
}
exports.sincronizarProductoL1aL2 = onDocumentWritten(
  { document: 'productos/{id}', region: REGION },
  (event) => sincronizarProductoEntreLocales(event, 'l2_productos')
);
exports.sincronizarProductoL2aL1 = onDocumentWritten(
  { document: 'l2_productos/{id}', region: REGION },
  (event) => sincronizarProductoEntreLocales(event, 'productos')
);

// ── MERCADO PAGO: PRUEBA DE CONEXIÓN (solo lectura) ─────────────────────────
// Primer paso para que el sistema confirme solo que cada transferencia llegó:
// trae los cobros que entraron a la cuenta de Mercado Pago en los últimos días
// (monto, hora y tipo; sin datos de los clientes), para ver si las
// transferencias al alias aparecen. La clave de la cuenta se guarda como
// secreto en la nube (MP_ACCESS_TOKEN): nunca está en el código ni la ve nadie.
// Solo la puede usar el admin.

exports.mpPruebaMovimientos = onCall({ region: REGION, secrets: [MP_ACCESS_TOKEN] }, async (req) => {
  const email = req.auth && req.auth.token && req.auth.token.email;
  if (email !== 'admin@limayrock.app') throw new HttpsError('permission-denied', 'Solo desde el admin');
  const dias = Math.min(Math.max(parseInt(req.data && req.data.dias, 10) || 2, 1), 7);
  const url = 'https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=100' +
    '&range=date_created&begin_date=NOW-' + dias + 'DAYS&end_date=NOW';
  let r;
  try { r = await fetch(url, { headers: { Authorization: 'Bearer ' + String(MP_ACCESS_TOKEN.value() || '').trim() } }); }
  catch (e) { throw new HttpsError('unavailable', 'No se pudo conectar con Mercado Pago'); }
  if (!r.ok) throw new HttpsError('unavailable', 'Mercado Pago respondió ' + r.status + (r.status === 401 ? ' (la clave no es válida)' : ''));
  const j = await r.json();
  const yo = await mpCuentaPropia();
  return {
    total: (j.paging && j.paging.total) || 0,
    cuentaIdentificada: !!yo,
    movimientos: (j.results || []).map(p => ({
      sentido: mpSentido(p, yo),
      // Para revisar el criterio: si cobra / paga la propia cuenta, otra, o no figura.
      cobra: !mpCobra(p) ? '—' : (mpCobra(p) === yo ? 'cuenta' : 'otro'),
      paga: !mpPaga(p) ? '—' : (mpPaga(p) === yo ? 'cuenta' : 'otro'),
      fecha: p.date_approved || p.date_created,
      monto: p.transaction_amount,
      neto: p.transaction_details ? p.transaction_details.net_received_amount : null,
      estado: p.status,
      tipo: p.payment_type_id,
      medio: p.payment_method_id,
      operacion: p.operation_type,
      origen: p.point_of_interaction ? [p.point_of_interaction.type, p.point_of_interaction.sub_type].filter(Boolean).join(' / ') : ''
    }))
  };
});

// ── MERCADO PAGO: CONFIRMACIÓN AUTOMÁTICA DE COBROS ─────────────────────────
// Dos usos, siempre de solo lectura sobre la cuenta (no mueve plata):
//  1) En la caja, al confirmar una venta por transferencia, la caja pregunta
//     cada pocos segundos si ya entró un pago de ese monto (mpEsperarPago).
//  2) En el cierre de Mercado Pago, el admin trae todos los cobros del turno
//     para emparejarlos con las ventas (mpCobrosRango).
// Cada pago de Mercado Pago se puede usar para UNA sola venta: el "reclamo"
// se anota en mpCobros/{id del pago} dentro de una transacción, así dos cajas
// (o los dos locales) que esperan el mismo monto nunca se quedan con el mismo.
// Solo se guarda monto, hora y tipo: nunca datos de los clientes.

function mpClave() { return String(MP_ACCESS_TOKEN.value() || '').trim(); }

async function mpGet(path) {
  let r;
  try { r = await fetch('https://api.mercadopago.com' + path, { headers: { Authorization: 'Bearer ' + mpClave() } }); }
  catch (e) { throw new HttpsError('unavailable', 'No se pudo conectar con Mercado Pago'); }
  if (!r.ok) {
    const err = new HttpsError('unavailable', 'Mercado Pago respondió ' + r.status + (r.status === 401 ? ' (la clave no es válida)' : ''));
    err.mpStatus = r.status;
    throw err;
  }
  return r.json();
}

// Número de cuenta propio, para quedarse solo con lo que ENTRA (si algún día se
// paga algo desde la cuenta, ese pago no tiene que confundirse con un cobro).
// Si /users/me no responde, el número de cuenta es el último tramo de la clave
// de producción (APP_USR-...-<cuenta>).
let _mpCuentaId = null;
async function mpCuentaPropia() {
  if (_mpCuentaId) return _mpCuentaId;
  try { const u = await mpGet('/users/me'); _mpCuentaId = u && u.id ? String(u.id) : null; } catch (e) { _mpCuentaId = null; }
  if (!_mpCuentaId) { const m = /-(\d+)$/.exec(mpClave()); if (m) _mpCuentaId = m[1]; }
  return _mpCuentaId;
}
// Un pago ENTRA si la cuenta es la que cobra; SALE si cobra otro (por ejemplo,
// un pago con QR en la verdulería). Ojo: en las transferencias que llegan desde
// otro banco (account_fund) Mercado Pago pone a la propia cuenta como "pagador",
// así que lo que manda es quién cobra, no quién paga.
function mpCobra(p) { return String(p.collector_id || (p.collector && p.collector.id) || ''); }
function mpPaga(p) { return String((p.payer && p.payer.id) || ''); }
function mpSentido(p, yo) {
  const cobra = mpCobra(p), paga = mpPaga(p);
  if (!yo) return '?';
  if (cobra === yo) return 'entra';
  if (cobra) return 'sale';
  if (p.operation_type === 'account_fund') return 'entra';
  return paga === yo ? 'sale' : 'entra';
}

// Las tarjetas (Point, QR pagado con tarjeta) se cobran como Débito en la
// caja, no como transferencia: no se usan para emparejar.
const MP_TIPOS_TARJETA = ['credit_card', 'debit_card', 'prepaid_card'];

function mpResumirPago(p) {
  return {
    id: String(p.id),
    fecha: new Date(p.date_approved || p.date_created).getTime(),
    monto: Number(p.transaction_amount) || 0,
    tipo: p.payment_type_id || '',
    medio: p.payment_method_id || '',
    operacion: p.operation_type || '',
    tarjeta: MP_TIPOS_TARJETA.indexOf(p.payment_type_id) !== -1
  };
}

// Solo lo que entró y está aprobado. Sin saber la cuenta no se empareja nada:
// un pago hecho desde la cuenta podría confundirse con un cobro.
async function mpPagosAprobados(results) {
  const yo = await mpCuentaPropia();
  if (!yo) throw new HttpsError('failed-precondition', 'No se pudo identificar la cuenta de Mercado Pago');
  return (results || []).filter(p => p.status === 'approved' && mpSentido(p, yo) === 'entra').map(mpResumirPago);
}

function mpCuentaQuePuede(req, cuentas) {
  const email = String((req.auth && req.auth.token && req.auth.token.email) || '').toLowerCase();
  if (cuentas.indexOf(email) === -1) throw new HttpsError('permission-denied', 'Esta cuenta no puede consultar Mercado Pago');
  // Limay 2 cobra en otra cuenta de Mercado Pago (la de su titular): hasta que
  // esté configurada no se busca nada, para no confirmar una venta de Limay 2
  // con plata que entró a la cuenta de Limay 1.
  if (Number(req.data && req.data.local) === 2) throw new HttpsError('failed-precondition', 'Limay 2 todavía no tiene su cuenta de Mercado Pago conectada');
}

// La caja pregunta: ¿entró un pago de $monto en los últimos minutos que nadie
// haya usado? Si sí, lo reclama para esta venta (ref) y lo devuelve.
exports.mpEsperarPago = onCall({ region: REGION, secrets: [MP_ACCESS_TOKEN] }, async (req) => {
  mpCuentaQuePuede(req, ['local@limayrock.app', 'admin@limayrock.app']);
  const d = req.data || {};
  const monto = Math.round((Number(d.monto) || 0) * 100) / 100;
  const ref = String(d.ref || '').slice(0, 80);
  if (!(monto > 0) || !ref) throw new HttpsError('invalid-argument', 'Falta el monto o la venta');
  // Se aceptan pagos de hasta 15 minutos antes (el cliente a veces transfiere
  // antes de que se termine de cargar el carrito).
  const desde = Math.max(Number(d.desde) || 0, Date.now() - 15 * 60000);
  // Los 50 cobros más nuevos alcanzan de sobra para los últimos 15 minutos.
  const j = await mpGet('/v1/payments/search?sort=date_created&criteria=desc&limit=50&range=date_created&begin_date=NOW-1DAYS&end_date=NOW');
  const candidatos = (await mpPagosAprobados(j.results))
    .filter(p => !p.tarjeta && Math.abs(p.monto - monto) < 0.01 && p.fecha >= desde)
    .sort((a, b) => a.fecha - b.fecha);
  // Desde el carrito solo se mira (sin reservar): ¿hay uno libre de ese monto?
  if (d.soloMirar) {
    if (!candidatos.length) return { ok: false };
    const snaps = await db.getAll(...candidatos.map(p => db.collection('mpCobros').doc(p.id)));
    for (let k = 0; k < candidatos.length; k++) {
      if (!(snaps[k].exists && snaps[k].data().usadoPor)) return { ok: true, id: candidatos[k].id, monto: candidatos[k].monto, fecha: candidatos[k].fecha, soloMirar: true };
    }
    return { ok: false };
  }
  for (const p of candidatos) {
    const doc = db.collection('mpCobros').doc(p.id);
    const mio = await db.runTransaction(async (t) => {
      const s = await t.get(doc);
      const u = s.exists ? s.data().usadoPor : null;
      if (u && u.ref !== ref) return false;
      t.set(doc, {
        monto: p.monto, fecha: p.fecha, tipo: p.tipo, medio: p.medio,
        usadoPor: { ref: ref, local: Number(d.local) === 2 ? 2 : 1, caja: Number(d.caja) || 1, en: Date.now() }
      }, { merge: true });
      return true;
    });
    if (mio) return { ok: true, id: p.id, monto: p.monto, fecha: p.fecha };
  }
  return { ok: false };
});

// Si la venta no se confirmó (tocaron "Volver"), el pago queda libre para otra.
exports.mpLiberarPago = onCall({ region: REGION }, async (req) => {
  mpCuentaQuePuede(req, ['local@limayrock.app', 'admin@limayrock.app']);
  const d = req.data || {};
  const id = String(d.id || ''), ref = String(d.ref || '');
  if (!id || !ref) return { ok: false };
  const doc = db.collection('mpCobros').doc(id);
  return db.runTransaction(async (t) => {
    const s = await t.get(doc);
    if (!s.exists || !s.data().usadoPor || s.data().usadoPor.ref !== ref) return { ok: false };
    t.update(doc, { usadoPor: FieldValue.delete() });
    return { ok: true };
  });
});

// Todos los cobros que entraron entre dos horas (paginado), con la marca de
// si alguna caja o pedido ya los usó.
async function mpCobrosEntre(desde, hasta) {
  const LIM = 100, MAX_PAG = 40;
  const traer = async (rango) => {
    let todos = [];
    for (let pag = 0; pag < MAX_PAG; pag++) {
      const j = await mpGet('/v1/payments/search?sort=date_created&criteria=desc&limit=' + LIM + '&offset=' + (pag * LIM) + '&range=date_created&' + rango);
      const res = j.results || [];
      todos = todos.concat(res);
      if (res.length < LIM) break;
      // Ya pasamos el comienzo del rango (vienen del más nuevo al más viejo).
      const ult = res[res.length - 1];
      if (new Date(ult.date_created).getTime() < desde - 3600000) break;
    }
    return todos;
  };
  let crudos;
  try {
    crudos = await traer('begin_date=' + encodeURIComponent(new Date(desde - 3600000).toISOString()) +
      '&end_date=' + encodeURIComponent(new Date(hasta + 3600000).toISOString()));
  } catch (e) {
    // Si Mercado Pago no acepta las fechas exactas, se pide por días y se filtra acá.
    if (e.mpStatus !== 400) throw e;
    const dias = Math.min(Math.ceil((Date.now() - desde) / 86400000) + 1, 30);
    crudos = await traer('begin_date=NOW-' + dias + 'DAYS&end_date=NOW');
  }
  const vistos = {};
  const pagos = (await mpPagosAprobados(crudos))
    .filter(p => p.fecha >= desde && p.fecha <= hasta && !vistos[p.id] && (vistos[p.id] = true));
  // Marcas de uso (qué caja / qué venta se quedó con cada pago).
  for (let i = 0; i < pagos.length; i += 100) {
    const lote = pagos.slice(i, i + 100);
    const snaps = await db.getAll(...lote.map(p => db.collection('mpCobros').doc(p.id)));
    snaps.forEach((s, k) => { const u = s.exists ? s.data().usadoPor : null; lote[k].usadoPor = u ? { ref: u.ref, local: u.local || 1 } : null; });
  }
  return pagos;
}

// Todos los cobros entre dos horas (el turno completo, sin el tope de 100),
// con la marca de si alguna caja ya los usó para una venta.
exports.mpCobrosRango = onCall({ region: REGION, secrets: [MP_ACCESS_TOKEN], timeoutSeconds: 120 }, async (req) => {
  mpCuentaQuePuede(req, ['admin@limayrock.app']);
  const d = req.data || {};
  const desde = Number(d.desde) || 0, hasta = Number(d.hasta) || Date.now();
  if (!(desde > 0) || hasta <= desde) throw new HttpsError('invalid-argument', 'Rango de horas inválido');
  if (hasta - desde > 3 * 86400000) throw new HttpsError('invalid-argument', 'El rango no puede pasar de 3 días');
  const pagos = await mpCobrosEntre(desde, hasta);
  return { cobros: pagos.sort((a, b) => a.fecha - b.fecha) };
});

// ── DELIVERY: COBRO AUTOMÁTICO DE PEDIDOS POR TRANSFERENCIA ─────────────────
// Un pedido del catálogo que eligió transferencia y ya fue confirmado por el
// local (el cliente ve el alias y el monto en el seguimiento) se cobra solo
// cuando entra el pago. La caja o el Puesto que cobra los delivery pregunta
// por cada pedido pendiente; acá, en una sola transacción, se reclama el pago
// y se anota en el pedido (mpPago) qué equipo registra la venta, así dos
// equipos nunca cobran el mismo pedido dos veces.
exports.mpCobrarPedido = onCall({ region: REGION, secrets: [MP_ACCESS_TOKEN] }, async (req) => {
  mpCuentaQuePuede(req, ['local@limayrock.app', 'admin@limayrock.app']);
  const d = req.data || {};
  const pid = String(d.pedidoId || ''), disp = String(d.disp || '').slice(0, 40);
  if (!/^\d+$/.test(pid) || !disp) throw new HttpsError('invalid-argument', 'Falta el pedido o el equipo');
  const pedRef = db.collection('pedidosWeb').doc(pid);
  const ped = await pedRef.get();
  if (!ped.exists) return { ok: false, motivo: 'no-existe' };
  const p = ped.data();
  if (p.pagoConfirmado || p.anulado) return { ok: false, motivo: 'cerrado' };
  if (p.medioPago !== 'Transferencia' || !(p.avisos && p.avisos.confirmado)) return { ok: false, motivo: 'no-corresponde' };
  const ref = 'pedido-' + pid;
  // Ya se encontró el pago antes: lo registra el mismo equipo, o cualquiera si
  // el que lo tomó no lo registró en 3 minutos (se cerró, se cortó internet).
  const yaTomado = async () => db.runTransaction(async (t) => {
    const s2 = await t.get(pedRef);
    const m = s2.exists ? s2.data().mpPago : null;
    if (!m) return null;
    if (s2.data().pagoConfirmado) return { ok: false, motivo: 'cerrado' };
    const libre = m.disp === disp || (Date.now() - (Number(m.en) || 0)) > 180000;
    if (libre && m.disp !== disp) t.update(pedRef, { 'mpPago.disp': disp, 'mpPago.en': Date.now() });
    return { ok: true, ganador: libre, pago: { id: m.id, fecha: m.fecha, monto: m.monto, ref: ref } };
  });
  const previo = await yaTomado();
  if (previo) return previo;
  const monto = Math.round((Number(p.total) || 0) * 100) / 100;
  if (!(monto > 0)) return { ok: false, motivo: 'sin-monto' };
  // Desde un rato antes de que el local confirmara el pedido.
  const desde = new Date(p.avisos.confirmado.ts).getTime() - 10 * 60000;
  const j = await mpGet('/v1/payments/search?sort=date_created&criteria=desc&limit=100&range=date_created&begin_date=NOW-1DAYS&end_date=NOW');
  const candidatos = (await mpPagosAprobados(j.results))
    .filter(x => !x.tarjeta && Math.abs(x.monto - monto) < 0.01 && x.fecha >= desde)
    .sort((a, b) => a.fecha - b.fecha);
  for (const x of candidatos) {
    const cobRef = db.collection('mpCobros').doc(x.id);
    const r = await db.runTransaction(async (t) => {
      const [sc, sp] = await Promise.all([t.get(cobRef), t.get(pedRef)]);
      if (!sp.exists || sp.data().pagoConfirmado) return { ok: false, motivo: 'cerrado' };
      if (sp.data().mpPago) return 'reintentar';
      const u = sc.exists ? sc.data().usadoPor : null;
      if (u && u.ref !== ref) return null;
      const pago = { id: x.id, fecha: x.fecha, monto: x.monto };
      t.set(cobRef, { monto: x.monto, fecha: x.fecha, tipo: x.tipo, medio: x.medio,
        usadoPor: { ref: ref, local: 1, caja: 0, pedido: pid, en: Date.now() } }, { merge: true });
      t.update(pedRef, { mpPago: Object.assign({ disp: disp, en: Date.now() }, pago) });
      return { ok: true, ganador: true, pago: Object.assign({ ref: ref }, pago) };
    });
    if (r === 'reintentar') return (await yaTomado()) || { ok: false, motivo: 'reintentar' };
    if (r) return r;
  }
  return { ok: false, motivo: 'sin-pago' };
});

// ── DELIVERY: AVISO A LOS REPARTIDORES CUANDO EL PEDIDO QUEDA COBRADO ───────
// Pensado para cuando el local está movido y el pedido se cobra solo por
// Mercado Pago: el repartidor se entera enseguida y va yendo al local. Si ya
// lo tomó alguien, le llega a ese; si no, a los repartidores disponibles.
exports.avisoPedidoCobrado = onDocumentUpdated(
  { document: 'pedidosWeb/{id}', region: REGION },
  async (event) => {
    const antes = event.data.before.data() || {}, despues = event.data.after.data() || {};
    if (antes.pagoConfirmado || !despues.pagoConfirmado || despues.anulado || despues.estado === 'resuelto') return;
    const nombre = despues.nombre || 'un cliente';
    if (despues.repartidor) {
      const tokens = await tokensRepartidores(n => n === despues.repartidor);
      if (tokens.length) await enviarATokens(tokens, '✅ Pedido pagado', 'El pedido de ' + nombre + ' ya está pagado: pasá por el local a retirarlo.', { tag: 'pedido-' + event.params.id, url: '/delivery/' });
    } else {
      const emps = await db.collection('empleados').get();
      const disponibles = emps.docs.map(d => d.data())
        .filter(e => e && e.accesoDelivery && e.disponibleDelivery && !e.sinPedidos).map(e => e.nombre);
      const tokens = await tokensRepartidores(n => disponibles.indexOf(n) !== -1);
      if (tokens.length) await enviarATokens(tokens, '✅ Pedido pagado', 'El pedido de ' + nombre + ' ya está pagado y nadie lo tomó: tomalo y pasá por el local.', { tag: 'pedido-' + event.params.id, url: '/delivery/' });
    }
  }
);

// ── CIERRE DE MERCADO PAGO AUTOMÁTICO AL CERRAR EL TURNO ────────────────────
// Lo mismo que hace el admin al tocar "📲 MP sin revisar", pero solo, apenas
// el empleado cierra la caja: busca en Mercado Pago cada venta por
// transferencia del turno (monto y hora, o el pago que la caja ya confirmó)
// y guarda el resultado en el cierre. Lo que no encuentra queda "a revisar"
// (nunca se da por faltante solo: puede llegar tarde o venir en dos partes).
// Devuelve las líneas para el aviso del turno cerrado.
async function cierreMPAutomatico(refCierre, c) {
  const ini = Date.parse(c.horaInicio), fin = Date.parse(c.horaFin);
  if (!ini || !fin || fin <= ini) return null;
  const caja = Number(c.caja) === 2 ? 2 : 1;
  const snapV = await db.collection('ventas').where('id', '>=', ini - 60000).where('id', '<=', fin).get();
  const ventas = [];
  snapV.forEach(d => {
    const v = d.data();
    if (!v || v.anulada || v.fiadoCarga) return;
    const fv = Date.parse(v.fecha); if (!(fv >= ini - 60000 && fv <= fin)) return;
    const monto = v.medio === 'Transferencia' ? (Number(v.total) || 0) : (v.medio === 'Mixto' && v.mixto ? (Number(v.mixto.transferencia) || 0) : 0);
    if (!(monto > 0)) return;
    ventas.push({ id: String(v.id), fecha: fv, monto, caja: Number(v.caja) === 2 ? 2 : 1,
      montoConEnvio: (v.medio === 'Transferencia' && Number(v.delivery) > 0) ? monto + Number(v.delivery) : 0,
      mpPago: v.mpPago || null });
  });
  ventas.sort((a, b) => a.fecha - b.fecha);
  const delTurno = ventas.filter(v => v.caja === caja && v.fecha >= ini);
  if (!delTurno.length) return null;
  const cobros = await mpCobrosEntre(ini - 15 * 60000, fin + 20 * 60000);
  // Pagos ya usados en otros cierres de los últimos días.
  const usado = {};
  const snapC = await db.collection('cierres').where('horaFin', '>=', new Date(ini - 2 * 86400000).toISOString()).get();
  snapC.forEach(d => { if (d.id === refCierre.id) return; const m = d.data().mp; ((m && m.items) || []).forEach(it => { if (it.mpId) usado[it.mpId] = true; }); });
  const refsDeAca = {};
  ventas.forEach(v => { if (v.mpPago && v.mpPago.ref) refsDeAca[v.mpPago.ref] = true; });
  cobros.forEach(p => {
    // Reclamados por Limay 2 o por una venta que no está en este horario: no se tocan.
    if (p.usadoPor && ((p.usadoPor.local || 1) !== 1 || !refsDeAca[p.usadoPor.ref])) usado[p.id] = true;
  });
  const porId = {}; cobros.forEach(p => { porId[p.id] = p; });
  const asignado = {};
  ventas.forEach(v => { if (v.mpPago && v.mpPago.id && !usado[v.mpPago.id]) asignado[v.mpPago.id] = v.id; });
  ventas.forEach(v => {
    if (v.mpPago && v.mpPago.id) return;
    let mejor = null, dtMejor = Infinity;
    cobros.forEach(p => {
      if (p.tarjeta || usado[p.id] || asignado[p.id] || p.usadoPor) return;
      if (Math.abs(p.monto - v.monto) >= 0.01 && !(v.montoConEnvio && Math.abs(p.monto - v.montoConEnvio) < 0.01)) return;
      const dt = p.fecha - v.fecha;
      if (dt < -15 * 60000 || dt > 20 * 60000) return;
      if (Math.abs(dt) < dtMejor) { dtMejor = Math.abs(dt); mejor = p; }
    });
    if (mejor) asignado[mejor.id] = v.id;
  });
  const porVenta = {}; Object.keys(asignado).forEach(pid => { porVenta[asignado[pid]] = pid; });
  let esperado = 0, recibido = 0, pendientes = 0, montoPend = 0;
  const items = delTurno.map(v => {
    const pid = porVenta[v.id];
    esperado += v.monto;
    if (!pid) { pendientes++; montoPend += v.monto; return { id: v.id, monto: v.monto, estado: 'pend', recibido: null, origen: 'auto', mpId: null, mpHora: null }; }
    recibido += v.monto;
    const p = porId[pid];
    return { id: v.id, monto: v.monto, estado: 'ok', recibido: v.monto, origen: 'auto', mpId: pid, mpHora: p ? p.fecha : (v.mpPago && v.mpPago.fecha) || null };
  });
  const sinCargar = cobros.filter(p => !p.tarjeta && !usado[p.id] && !asignado[p.id] && !p.usadoPor && p.fecha >= ini && p.fecha <= fin);
  await refCierre.update({ mp: {
    esperado, recibido, diferencia: 0, pendientes, items,
    revisadoPor: 'Sistema (automático)', revisadoEn: new Date().toISOString(), faltanteSaldado: false,
    automatico: true, sinCargar: sinCargar.map(p => ({ fecha: p.fecha, monto: p.monto }))
  } });
  const out = [];
  if (!pendientes) out.push(`📲 MP ✅ llegó todo (${pesos(recibido)} en ${items.length} transferencia${items.length === 1 ? '' : 's'})`);
  else out.push(`📲 MP: ${items.length - pendientes} de ${items.length} confirmadas · revisar ${pendientes} (${pesos(montoPend)})`);
  if (sinCargar.length) out.push(`💡 ${sinCargar.length} cobro${sinCargar.length === 1 ? '' : 's'} en MP sin venta cargada (${pesos(sinCargar.reduce((t, p) => t + p.monto, 0))})`);
  return out;
}

// ── EGRESOS PAGADOS POR MERCADO PAGO ────────────────────────────────────────
// Busca un pago que SALIÓ de la cuenta (QR o link: verdulería, pollería...)
// del monto exacto del egreso, hasta 24 horas antes de cargarlo, y lo reserva
// para ese egreso. Las transferencias a un CBU/alias no figuran en esta lista
// de Mercado Pago (para esas van a hacer falta los reportes de movimientos).
exports.mpBuscarEgreso = onCall({ region: REGION, secrets: [MP_ACCESS_TOKEN] }, async (req) => {
  mpCuentaQuePuede(req, ['local@limayrock.app', 'admin@limayrock.app']);
  const d = req.data || {};
  const monto = Math.round((Number(d.monto) || 0) * 100) / 100;
  const idEg = String(d.egresoId || '').replace(/\D/g, '');
  const ts = Number(d.ts) || Date.now();
  if (!(monto > 0) || !idEg) throw new HttpsError('invalid-argument', 'Falta el monto o el egreso');
  const ref = 'egreso-' + idEg;
  const yo = await mpCuentaPropia();
  if (!yo) throw new HttpsError('failed-precondition', 'No se pudo identificar la cuenta de Mercado Pago');
  const desde = ts - 24 * 3600000, hasta = ts + 30 * 60000;
  let crudos = [];
  for (let pag = 0; pag < 5; pag++) {
    const j = await mpGet('/v1/payments/search?sort=date_created&criteria=desc&limit=100&offset=' + (pag * 100) + '&range=date_created&begin_date=NOW-3DAYS&end_date=NOW');
    const res = j.results || [];
    crudos = crudos.concat(res);
    if (res.length < 100 || new Date(res[res.length - 1].date_created).getTime() < desde) break;
  }
  const candidatos = crudos.filter(p => p.status === 'approved' && mpSentido(p, yo) === 'sale').map(mpResumirPago)
    .filter(p => Math.abs(p.monto - monto) < 0.01 && p.fecha >= desde && p.fecha <= hasta)
    .sort((a, b) => Math.abs(a.fecha - ts) - Math.abs(b.fecha - ts));
  for (const p of candidatos) {
    const doc = db.collection('mpCobros').doc(p.id);
    const mio = await db.runTransaction(async (t) => {
      const s2 = await t.get(doc);
      const u = s2.exists ? s2.data().usadoPor : null;
      if (u && u.ref !== ref) return false;
      t.set(doc, { monto: p.monto, fecha: p.fecha, tipo: p.tipo, medio: p.medio, sale: true,
        usadoPor: { ref: ref, local: 1, egreso: idEg, en: Date.now() } }, { merge: true });
      return true;
    });
    if (mio) return { ok: true, id: p.id, monto: p.monto, fecha: p.fecha };
  }
  return { ok: false };
});
