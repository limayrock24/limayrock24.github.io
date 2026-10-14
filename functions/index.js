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

    const cant = Number(m.cantidad) || 0;
    const cuerpo = `${m.producto || '—'} · ${cant > 0 ? '+' : ''}${cant} u.` +
      (m.stockAntes != null ? ` (${m.stockAntes} → ${m.stockDespues})` : '') +
      (m.responsable ? `\nPor ${m.responsable}` : '');
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
      ? new Date(s.turnoInicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
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
      ? new Date(c.horaFin).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
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

    const cuerpo = `${c.empleado || '—'} · ${c.turno || ''}\n${estado}`;
    await notificar('dueno', `🔴 Turno cerrado — ${hora}`, cuerpo, { tag: 'turno', url: '/admin/' });
  }
);

// ── MENSAJE DEL LOCAL A LOS REPARTIDORES ───────────────────────────────────
// Se manda desde Admin → Mensajes. Le llega a cada repartidor elegido en todos
// sus celulares registrados, esté DISPONIBLE o no (por eso no se filtra por
// destino 'repartidor'). Solo se saltean los celulares bloqueados.
exports.avisoMensajeRepartidor = onDocumentCreated(
  { document: 'avisosDelivery/{id}', region: REGION },
  async (event) => {
    // Se lee el mensaje directo de la base por su id: no depende del formato
    // en que llega el evento (según cómo se publicó la función, puede venir
    // sin los datos del documento).
    const id = (event.params && event.params.id) ||
      String(event.document || event.subject || '').split('/').pop();
    let m = null;
    try { m = event.data && typeof event.data.data === 'function' ? event.data.data() : null; } catch (e) { m = null; }
    if ((!m || !m.texto) && id) {
      const doc = await db.collection('avisosDelivery').doc(id).get();
      m = doc.exists ? doc.data() : null;
    }
    console.log(`Mensaje a repartidores, id ${id}: ${m ? 'leído' : 'no encontrado'}`);
    if (!m || !m.texto) return;
    const para = Array.isArray(m.para) ? m.para.filter(n => typeof n === 'string' && n) : [];
    console.log(`Para: ${para.join(', ') || '(nadie)'}`);
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
    if (!tokens.length) {
      console.log(`Mensaje a ${para.join(', ')}: ningún celular registrado`);
      return;
    }
    const cuerpo = String(m.texto).slice(0, 400);
    await enviarATokens(tokens, '📣 Mensaje del local', cuerpo, { tag: 'mensaje', url: '/delivery/' });
  }
);
