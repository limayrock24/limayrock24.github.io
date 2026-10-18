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
