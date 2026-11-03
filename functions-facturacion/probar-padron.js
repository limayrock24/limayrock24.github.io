// ══════════════════════════════════════════════════════════════════════════
// PRUEBA DE LA CONSULTA DE CUIT EN EL PADRÓN DE ARCA (a mano, desde Cloud Shell)
// No toca la base: hace login y consulta un CUIT. Solo lectura.
// Uso: node probar-padron.js <homologacion|produccion> <CUIT>
// El certificado y la llave llegan por ARCA_CERT y ARCA_KEY (de Secret Manager).
// ══════════════════════════════════════════════════════════════════════════
'use strict';
const arca = require('./arca');
const modo = process.argv[2] || 'homologacion';
const cuit = String(process.argv[3] || '20433394896').replace(/\D/g, '');
(async () => {
  const cert = process.env.ARCA_CERT, clave = process.env.ARCA_KEY;
  if (!cert || !clave) throw new Error('Faltan ARCA_CERT o ARCA_KEY');
  console.log('1) Login en ARCA (' + modo + ') para ' + arca.SERVICIO_PADRON + '...');
  const ta = await arca.login(modo, cert, clave, arca.SERVICIO_PADRON);
  console.log('   OK');
  console.log('2) Consultando el CUIT ' + cuit + '...');
  const r = await arca.consultarPadron(modo, { token: ta.token, sign: ta.sign, cuit: process.env.ARCA_CUIT || '20433394896' }, cuit);
  console.log('   ' + JSON.stringify(r));
  if (r.encontrado) console.log('\n>> TODO OK: la consulta del padrón funciona.');
})().catch((e) => { console.error('\n>> ERROR: ' + e.message); process.exitCode = 1; });
