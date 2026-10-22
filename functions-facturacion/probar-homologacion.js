// ══════════════════════════════════════════════════════════════════════════
// PRUEBA CONTRA EL AMBIENTE DE PRUEBAS DE ARCA (homologación)
//
// Se corre a mano desde Google Cloud Shell. No publica nada ni toca la base:
// solo hace login en ARCA, pregunta el último número y pide UNA factura de
// prueba de $1 (en homologación los comprobantes no valen).
//
// El certificado y la llave llegan por variables de entorno (ARCA_CERT,
// ARCA_KEY), leídas en el momento desde Secret Manager; no se guardan.
// Uso: node probar-homologacion.js [puntoDeVenta]
// ══════════════════════════════════════════════════════════════════════════
'use strict';

const arca = require('./arca');

const CUIT = process.env.ARCA_CUIT || '20433394896';
const PTO_VTA = Number(process.argv[2] || process.env.ARCA_PTO_VTA || 2);

function fechaHoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '');
}

(async () => {
  const cert = process.env.ARCA_CERT;
  const clave = process.env.ARCA_KEY;
  if (!cert || !clave) throw new Error('Faltan ARCA_CERT o ARCA_KEY');
  console.log('1) Certificado vence: ' + arca.venceCertificado(cert));

  console.log('2) Login en ARCA (homologación)...');
  const ta = await arca.login('homologacion', cert, clave);
  console.log('   OK, token válido hasta ' + ta.vence);
  const cred = { token: ta.token, sign: ta.sign, cuit: CUIT };
  const cliente = arca.crearClienteReal('homologacion', CUIT, async () => cred);

  console.log('3) Último número de Factura C en el punto de venta ' + PTO_VTA + '...');
  const ultimo = await cliente.ultimoAutorizado(PTO_VTA, arca.CBTE.FACTURA_C);
  console.log('   Último: ' + ultimo);

  console.log('4) Pidiendo una Factura C de prueba por $1...');
  const r = await cliente.solicitarCAE({
    ptoVta: PTO_VTA, cbteTipo: arca.CBTE.FACTURA_C, numero: ultimo + 1, fecha: fechaHoy(), importe: 1,
    docTipo: arca.DOC.SIN_IDENTIFICAR, docNro: '0', condIva: arca.COND_IVA.CONSUMIDOR_FINAL
  });
  if (r.aprobado) {
    console.log('   APROBADA ✓  Nº ' + r.numero + '  CAE ' + r.cae + '  (vence ' + r.caeVto + ')');
    if (r.observaciones.length) console.log('   Observaciones: ' + JSON.stringify(r.observaciones));
    console.log('\n>> TODO OK: el sistema ya sabe facturar con ARCA (ambiente de pruebas).');
  } else {
    console.log('   RECHAZADA: ' + JSON.stringify(r.errores, null, 1));
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('\n>> ERROR: ' + e.message);
  if (e.errores && e.errores.length) console.error(JSON.stringify(e.errores, null, 1));
  process.exitCode = 1;
});
