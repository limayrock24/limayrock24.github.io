// ══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN — lógica de negocio (qué se factura, numeración, reintentos)
//
// Cada comprobante es un documento en "facturas":
//   facturas/<idVenta>      → la Factura C de esa venta
//   facturas/<idVenta>_NC   → la Nota de Crédito C si después se anuló
// Estados: pendiente → emitiendo → aprobada | rechazada | cancelada
//
// Los puestos de venta solo pueden LEER "facturas": las escribe únicamente
// este código (ver firestore.rules).
// ══════════════════════════════════════════════════════════════════════════
'use strict';

const { CBTE, DOC, COND_IVA, ErrorArca, urlQR } = require('./arca');

const DIAS_MAX_ATRASO = 3;      // una venta más vieja que esto no se factura sola
const MAX_INTENTOS = 30;        // reintentos automáticos antes de pedir ayuda
const LOCK_MS = 60 * 1000;

// Lo que entró a Mercado Pago en una venta (transferencia + Point). Incluye
// los cobros de fiados y consignaciones; NO la carga de un fiado (ahí no
// entra plata: se factura recién cuando lo pagan).
function montoMercadoPago(v) {
  if (!v || v.fiadoCarga) return 0;
  let m = 0;
  if (v.medio === 'Transferencia' || v.medio === 'Débito') m = Number(v.total) || 0;
  else if (v.medio === 'Mixto' && v.mixto) {
    // El Point cobra la parte de débito más su recargo.
    m = (Number(v.mixto.transferencia) || 0) + (Number(v.mixto.debito) || 0) + (Number(v.recargo) || 0);
  }
  return Math.round(m * 100) / 100;
}

function cuitValido(c) {
  const s = String(c || '').replace(/\D/g, '');
  if (s.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(s[i]) * pesos[i];
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(s[10]);
}

// A quién va la factura. Sin datos: consumidor final sin identificar.
function armarReceptor(pedido) {
  const r = (pedido && pedido.receptor) || {};
  const doc = String(r.doc || '').replace(/\D/g, '');
  const nombre = String(r.nombre || '').trim().slice(0, 80) || null;
  if (doc.length === 11) {
    if (!cuitValido(doc)) return { error: 'El CUIT ' + doc + ' no es válido' };
    const cond = [COND_IVA.RESPONSABLE_INSCRIPTO, COND_IVA.EXENTO, COND_IVA.CONSUMIDOR_FINAL, COND_IVA.MONOTRIBUTO].indexOf(Number(r.condIva)) !== -1
      ? Number(r.condIva) : COND_IVA.RESPONSABLE_INSCRIPTO;
    return { docTipo: DOC.CUIT, docNro: doc, condIva: cond, nombre };
  }
  if (doc.length >= 7 && doc.length <= 8) return { docTipo: DOC.DNI, docNro: doc, condIva: COND_IVA.CONSUMIDOR_FINAL, nombre };
  // Sin documento: el nombre (si hay, ej. el cliente de un fiado) solo va impreso.
  return { docTipo: DOC.SIN_IDENTIFICAR, docNro: '0', condIva: COND_IVA.CONSUMIDOR_FINAL, nombre };
}

// Fecha de hoy en Argentina, como la pide ARCA (aaaammdd).
function fechaArgentina(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  return p.replace(/-/g, '');
}

function numeroTxt(ptoVta, numero) {
  return String(ptoVta).padStart(5, '0') + '-' + String(numero).padStart(8, '0');
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function crearFacturacion(ctx) {
  // ctx: { db, FieldValue, cliente, cuit, ptoVta, log }
  const db = ctx.db;
  const log = ctx.log || console;
  const facturas = db.collection('facturas');

  // ── Pedido nuevo a partir de una venta recién guardada ──────────────────
  async function crearDesdeVenta(ventaId, v, ahora) {
    const t = ahora || new Date();
    if (!v || !v.facturaPedido || v.anulada) return { omitida: 'sin pedido de factura' };
    const edad = t - new Date(v.fecha);
    if (!(edad < DIAS_MAX_ATRASO * 24 * 3600 * 1000)) return { omitida: 'venta vieja' };
    const monto = montoMercadoPago(v);
    if (!(monto > 0)) return { omitida: 'sin monto de Mercado Pago' };
    const receptor = armarReceptor(v.facturaPedido);
    const base = {
      ventaId: String(ventaId), tipo: 'FC', cbteTipo: CBTE.FACTURA_C,
      ptoVta: ctx.ptoVta, cuitEmisor: ctx.cuit, modo: ctx.cliente.modo,
      importe: monto, totalVenta: Number(v.total) || 0, medio: v.medio || '',
      caja: v.caja || null, empleado: v.empleado || null, turno: v.turno || null,
      fechaVenta: v.fecha, creada: t.toISOString(), intentos: 0
    };
    let doc;
    if (receptor.error) doc = Object.assign(base, { estado: 'rechazada', receptor: null, errores: [{ codigo: 'LR', mensaje: receptor.error }] });
    else doc = Object.assign(base, { estado: 'pendiente', receptor });
    try {
      await facturas.doc(String(ventaId)).create(doc);
    } catch (e) {
      if (e && (e.code === 6 || /already exists/i.test(e.message))) return { omitida: 'ya existía' };
      throw e;
    }
    return { creada: String(ventaId), estado: doc.estado };
  }

  // ── Turno exclusivo para pedir números a ARCA ───────────────────────────
  // ARCA exige números correlativos: si dos cajas piden a la vez, las dos
  // leerían el mismo "último número". Este turno hace que vayan de a una.
  async function tomarTurno(clave, duenio) {
    const ref = db.collection('arcaPrivado').doc('turno_' + clave);
    for (let i = 0; i < 25; i++) {
      const ok = await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const d = s.exists ? s.data() : null;
        if (d && d.hasta > Date.now() && d.duenio !== duenio) return false;
        tx.set(ref, { duenio, hasta: Date.now() + LOCK_MS });
        return true;
      });
      if (ok) return async () => {
        await db.runTransaction(async (tx) => {
          const s = await tx.get(ref);
          if (s.exists && s.data().duenio === duenio) tx.delete(ref);
        });
      };
      await esperar(1000);
    }
    return null;
  }

  // Reserva la factura para procesarla (nadie más la toca mientras tanto).
  async function reservar(ref) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const f = s.data();
      const trabada = f.estado === 'emitiendo' && f.reservadaHasta > Date.now();
      if (f.estado !== 'pendiente' && !(f.estado === 'emitiendo' && !trabada)) return null;
      tx.update(ref, { estado: 'emitiendo', reservadaHasta: Date.now() + 2 * LOCK_MS, intentos: (f.intentos || 0) + 1 });
      return f;
    });
  }

  async function aprobar(ref, f, r, fechaCbte) {
    const datos = {
      estado: 'aprobada', numero: r.numero, numeroTxt: numeroTxt(f.ptoVta, r.numero),
      cae: r.cae, caeVto: r.caeVto, fechaCbte, emitida: new Date().toISOString(),
      observaciones: r.observaciones || [], error: null, errores: [], numeroIntentado: null,
      qrUrl: urlQR({ fecha: fechaCbte, cuit: f.cuitEmisor, ptoVta: f.ptoVta, cbteTipo: f.cbteTipo, numero: r.numero, importe: f.importe, docTipo: f.receptor.docTipo, docNro: f.receptor.docNro, cae: r.cae })
    };
    // Resumen por mes (para el total de 12 meses del admin sin leer todo).
    const signo = f.tipo === 'NC' ? -1 : 1;
    const lote = db.batch();
    lote.update(ref, datos);
    lote.set(db.collection('facturacionEstado').doc('mes_' + fechaCbte.slice(0, 6)), {
      total: ctx.FieldValue.increment(signo * f.importe),
      cantidad: ctx.FieldValue.increment(f.tipo === 'NC' ? 0 : 1),
      notasCredito: ctx.FieldValue.increment(f.tipo === 'NC' ? 1 : 0)
    }, { merge: true });
    lote.set(db.collection('facturacionEstado').doc('general'), { modo: f.modo, ultimaFactura: datos.emitida }, { merge: true });
    await lote.commit();
    return Object.assign({}, f, datos);
  }

  // ── Emitir (o reintentar) un comprobante ────────────────────────────────
  async function procesar(facturaId) {
    const ref = facturas.doc(String(facturaId));
    const f = await reservar(ref);
    if (!f) return { estado: 'sin cambios' };
    const liberar = await tomarTurno(f.ptoVta + '_' + f.cbteTipo, String(facturaId));
    if (!liberar) {
      await ref.update({ estado: 'pendiente', error: 'Otra factura se estaba emitiendo; se reintenta sola' });
      return { estado: 'pendiente' };
    }
    try {
      // Si un intento anterior se cortó después de pedir el CAE, primero se
      // averigua si ARCA llegó a autorizarlo, para no facturar dos veces.
      if (f.numeroIntentado) {
        const previo = await ctx.cliente.consultar(f.ptoVta, f.cbteTipo, f.numeroIntentado);
        if (previo && Math.abs(previo.importe - f.importe) < 0.01 && String(previo.docNro) === String(f.receptor.docNro)) {
          const fecha = f.fechaIntentada || fechaArgentina();
          const ok = await aprobar(ref, f, { numero: f.numeroIntentado, cae: previo.cae, caeVto: previo.caeVto }, fecha);
          await despuesDeAprobar(ok);
          return { estado: 'aprobada', recuperada: true };
        }
      }
      // Venta anulada antes de llegar a emitir: no se emite nada.
      const actual = (await ref.get()).data();
      if (actual.ventaAnulada) {
        await ref.update({ estado: 'cancelada', error: null, numeroIntentado: null });
        return { estado: 'cancelada' };
      }
      const ultimo = await ctx.cliente.ultimoAutorizado(f.ptoVta, f.cbteTipo);
      const numero = ultimo + 1;
      const fechaCbte = fechaArgentina();
      await ref.update({ numeroIntentado: numero, fechaIntentada: fechaCbte });
      const r = await ctx.cliente.solicitarCAE({
        ptoVta: f.ptoVta, cbteTipo: f.cbteTipo, numero, fecha: fechaCbte, importe: f.importe,
        docTipo: f.receptor.docTipo, docNro: f.receptor.docNro, condIva: f.receptor.condIva,
        asociado: f.asociado || null
      });
      if (r.aprobado) {
        const ok = await aprobar(ref, f, r, fechaCbte);
        await despuesDeAprobar(ok);
        return { estado: 'aprobada', numero: r.numero };
      }
      await ref.update({ estado: 'rechazada', errores: r.errores, error: (r.errores || []).map((e) => e.mensaje).join(' / '), numeroIntentado: null });
      return { estado: 'rechazada', errores: r.errores };
    } catch (e) {
      log.error('Error emitiendo ' + facturaId, e);
      const intentos = (f.intentos || 0) + 1;
      await ref.update({
        estado: intentos >= MAX_INTENTOS ? 'rechazada' : 'pendiente',
        error: (e && e.message) || String(e),
        errores: (e && e.errores) || []
      });
      return { estado: 'pendiente', error: e && e.message };
    } finally {
      await liberar();
    }
  }

  // Si la venta se anuló mientras la factura se estaba emitiendo, en cuanto
  // queda aprobada se hace la nota de crédito.
  async function despuesDeAprobar(f) {
    const s = await facturas.doc(String(f.ventaId)).get();
    if (f.tipo === 'FC' && s.exists && s.data().ventaAnulada) await crearNotaCredito(f.ventaId);
  }

  async function crearNotaCredito(ventaId) {
    const fRef = facturas.doc(String(ventaId));
    const ncRef = facturas.doc(String(ventaId) + '_NC');
    const res = await db.runTransaction(async (tx) => {
      const s = await tx.get(fRef);
      if (!s.exists) return 'sin factura';
      const f = s.data();
      if (f.estado === 'aprobada') {
        const nc = await tx.get(ncRef);
        if (nc.exists) return 'ya tenía nota de crédito';
        tx.set(ncRef, {
          ventaId: String(ventaId), tipo: 'NC', cbteTipo: CBTE.NOTA_CREDITO_C,
          ptoVta: f.ptoVta, cuitEmisor: f.cuitEmisor, modo: f.modo,
          importe: f.importe, totalVenta: f.totalVenta, medio: f.medio, receptor: f.receptor,
          caja: f.caja, empleado: f.empleado, turno: f.turno, fechaVenta: f.fechaVenta,
          asociado: { tipo: f.cbteTipo, ptoVta: f.ptoVta, numero: f.numero, cuit: f.cuitEmisor, fecha: f.fechaCbte },
          asociadoTxt: f.numeroTxt, creada: new Date().toISOString(), estado: 'pendiente', intentos: 0
        });
        tx.update(fRef, { ventaAnulada: true, notaCredito: String(ventaId) + '_NC' });
        return 'nc';
      }
      // Todavía no se emitió: se cancela, salvo que un intento haya quedado
      // en el aire (ahí se decide en el próximo intento, ver procesar).
      if (f.estado === 'pendiente' && !f.numeroIntentado) { tx.update(fRef, { estado: 'cancelada', ventaAnulada: true }); return 'cancelada'; }
      if (f.estado === 'rechazada') { tx.update(fRef, { ventaAnulada: true }); return 'rechazada'; }
      tx.update(fRef, { ventaAnulada: true });
      return 'marcada';
    });
    if (res === 'nc') return procesar(String(ventaId) + '_NC');
    return { estado: res };
  }

  // Pedido de reintento hecho desde el panel admin.
  async function reintentar(facturaId) {
    const ref = facturas.doc(String(facturaId));
    const ok = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return false;
      const f = s.data();
      if (f.estado !== 'pendiente' && f.estado !== 'rechazada') return false;
      if (f.estado === 'rechazada' && f.receptor == null) return false;
      tx.update(ref, { estado: 'pendiente', intentos: 0, error: null });
      return true;
    });
    return ok ? procesar(facturaId) : { estado: 'sin cambios' };
  }

  async function procesarPendientes() {
    const q = await facturas.where('estado', 'in', ['pendiente', 'emitiendo']).limit(20).get();
    const res = [];
    for (const d of q.docs) res.push(await procesar(d.id));
    return res;
  }

  return { crearDesdeVenta, procesar, crearNotaCredito, reintentar, procesarPendientes };
}

module.exports = { crearFacturacion, montoMercadoPago, armarReceptor, cuitValido, fechaArgentina, numeroTxt, ErrorArca };
