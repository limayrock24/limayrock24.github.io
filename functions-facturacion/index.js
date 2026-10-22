// ══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN ELECTRÓNICA — funciones de Firebase de Limay Rock
//
// Facturación electrónica con ARCA. Corre en los servidores de Google, no en
// la página: así el certificado y la clave privada nunca llegan al público.
//
//   ventas/{id} nueva con pedido de factura  → emite la Factura C
//   ventas/{id} anulada                      → emite la Nota de Crédito C
//   facturacionSolicitudes/{id}              → pedidos del admin (reintentar)
//   cada 10 minutos                          → reintenta las pendientes
//
// Va aparte de las notificaciones (carpeta functions/), como otro "codebase":
// publicar una no toca la otra.
//
// Configuración (archivo functions-facturacion/.env, no tiene nada secreto):
//   ARCA_MODO     simulado | homologacion | produccion
//   ARCA_CUIT     CUIT del emisor, sin guiones
//   ARCA_PTO_VTA  número de punto de venta "Web Services"
// Secretos (se cargan en Google Secret Manager, NUNCA en el repositorio):
//   ARCA_CERT             certificado de PRUEBAS (WSASS), formato PEM
//   ARCA_CERT_PRODUCCION  certificado REAL (Administración de Certificados Digitales)
//   ARCA_KEY              clave privada (la misma para los dos)
// ══════════════════════════════════════════════════════════════════════════
'use strict';

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString, defineSecret } = require('firebase-functions/params');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');

const arca = require('./arca');
const { crearSimulador } = require('./simulador');
const { crearFacturacion } = require('./facturacion');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: 'southamerica-east1', maxInstances: 2 });

const ARCA_MODO = defineString('ARCA_MODO', { default: 'simulado' });
const ARCA_CUIT = defineString('ARCA_CUIT', { default: '20433394896' });
const ARCA_PTO_VTA = defineString('ARCA_PTO_VTA', { default: '2' });
const ARCA_CERT = defineSecret('ARCA_CERT');
const ARCA_CERT_PRODUCCION = defineSecret('ARCA_CERT_PRODUCCION');
const ARCA_KEY = defineSecret('ARCA_KEY');

// En modo simulado no hacen falta el certificado ni la clave (todavía no
// existen). Al pasar a homologación o producción se agregan los secretos.
const modoReal = () => ['homologacion', 'produccion'].indexOf(ARCA_MODO.value()) !== -1;
const OPCIONES = { secrets: process.env.ARCA_CON_SECRETOS === 'si' ? [ARCA_CERT, ARCA_CERT_PRODUCCION, ARCA_KEY] : [] };

async function leerConfig() {
  const s = await db.collection('config').doc('facturacion').get();
  return s.exists ? s.data() : {};
}

// Token de ARCA: vale unas 12 horas, así que se guarda y se reusa (ARCA
// rechaza pedir uno nuevo mientras el anterior siga vigente).
async function credenciales() {
  const modo = ARCA_MODO.value();
  const ref = db.collection('arcaPrivado').doc('ta_' + modo);
  const s = await ref.get();
  if (s.exists && new Date(s.data().vence) - Date.now() > 10 * 60 * 1000) {
    return { token: s.data().token, sign: s.data().sign, cuit: ARCA_CUIT.value() };
  }
  // Cada ambiente de ARCA tiene su propio certificado (la llave es la misma).
  const cert = modo === 'produccion' ? ARCA_CERT_PRODUCCION.value() : ARCA_CERT.value();
  const clave = ARCA_KEY.value();
  if (!cert || !clave) throw new arca.ErrorArca('Falta cargar el certificado de ARCA', { reintentable: true });
  const ta = await arca.login(modo, cert, clave);
  await ref.set(ta);
  await db.collection('facturacionEstado').doc('general').set({
    modo, certVence: arca.venceCertificado(cert), ultimoLogin: new Date().toISOString()
  }, { merge: true });
  return { token: ta.token, sign: ta.sign, cuit: ARCA_CUIT.value() };
}

function servicio() {
  const cliente = modoReal()
    ? arca.crearClienteReal(ARCA_MODO.value(), ARCA_CUIT.value(), credenciales)
    : crearSimulador(db, { leerConfig });
  return crearFacturacion({ db, FieldValue: admin.firestore.FieldValue, cliente, cuit: ARCA_CUIT.value(), ptoVta: Number(ARCA_PTO_VTA.value()), log: logger });
}

// Lo que hace cada disparador, aparte, para poder probarlo igual en la compu.
const manejadores = {
  async ventaNueva(ventaId, v) {
    if (!v || !v.facturaPedido) return;
    const cfg = await leerConfig();
    if (!cfg.activa) { logger.info('Facturación apagada; venta ' + ventaId + ' sin factura'); return; }
    const fx = servicio();
    const r = await fx.crearDesdeVenta(ventaId, v);
    logger.info('Venta ' + ventaId, r);
    if (r.creada && r.estado === 'pendiente') await fx.procesar(r.creada);
  },
  async ventaCambiada(ventaId, antes, despues) {
    if ((antes && antes.anulada) || !(despues && despues.anulada)) return;
    const f = await db.collection('facturas').doc(String(ventaId)).get();
    if (!f.exists) return;
    const r = await servicio().crearNotaCredito(ventaId);
    logger.info('Anulación de venta ' + ventaId, r);
  },
  async solicitud(s) {
    if (s && s.accion === 'reintentar' && s.facturaId) {
      const r = await servicio().reintentar(String(s.facturaId));
      logger.info('Reintento de ' + s.facturaId, r);
    }
  },
  async pendientes() {
    const cfg = await leerConfig();
    if (!cfg.activa) return;
    const r = await servicio().procesarPendientes();
    if (r.length) logger.info('Pendientes reintentadas', r);
  }
};
exports._manejadores = manejadores;

exports.facturarVenta = onDocumentCreated(Object.assign({ document: 'ventas/{ventaId}' }, OPCIONES), (event) =>
  manejadores.ventaNueva(event.params.ventaId, event.data && event.data.data()));

exports.anularFactura = onDocumentUpdated(Object.assign({ document: 'ventas/{ventaId}' }, OPCIONES), (event) =>
  manejadores.ventaCambiada(event.params.ventaId, event.data.before.data(), event.data.after.data()));

exports.solicitudFacturacion = onDocumentCreated(Object.assign({ document: 'facturacionSolicitudes/{id}' }, OPCIONES), async (event) => {
  try { await manejadores.solicitud(event.data && event.data.data()); } finally { await event.data.ref.delete(); }
});

exports.reintentarPendientes = onSchedule(Object.assign({ schedule: 'every 10 minutes', timeZone: 'America/Argentina/Buenos_Aires' }, OPCIONES), () => manejadores.pendientes());
