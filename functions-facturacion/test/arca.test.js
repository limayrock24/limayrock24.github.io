'use strict';
// Pruebas sin conexión: armado y lectura de los mensajes de ARCA, cálculo de
// montos y receptor. Se corren con: npm test (dentro de functions/).
const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const arca = require('../arca');
const { antesDelInicio, montoMercadoPago, armarReceptor, cuitValido, fechaArgentina, numeroTxt } = require('../facturacion');

test('monto de Mercado Pago según el medio de pago', () => {
  assert.strictEqual(montoMercadoPago({ medio: 'Efectivo', total: 5000 }), 0);
  assert.strictEqual(montoMercadoPago({ medio: 'Transferencia', total: 5000 }), 5000);
  assert.strictEqual(montoMercadoPago({ medio: 'Débito', total: 7700, recargo: 700 }), 7700);
  assert.strictEqual(montoMercadoPago({ medio: 'Mixto', total: 10100, recargo: 100, mixto: { efectivo: 4000, transferencia: 5000, debito: 1000 } }), 6100);
  assert.strictEqual(montoMercadoPago({ medio: 'Transferencia', total: 5000, fiadoCarga: true }), 0);
  // Cobro de un fiado o de una consignación por transferencia: se factura.
  assert.strictEqual(montoMercadoPago({ medio: 'Transferencia', total: 8000, esFiado: true }), 8000);
  assert.strictEqual(montoMercadoPago({ medio: 'Débito', total: 3300, recargo: 300, esConsignacion: true }), 3300);
  assert.strictEqual(montoMercadoPago({ medio: 'Cobro fiado', total: 8000, esFiado: true }), 0);
});

test('receptor: consumidor final, DNI y CUIT', () => {
  assert.deepStrictEqual(armarReceptor(null), { docTipo: 99, docNro: '0', condIva: 5, nombre: null });
  assert.strictEqual(armarReceptor({ receptor: { nombre: 'Juan' } }).nombre, 'Juan');
  assert.strictEqual(armarReceptor({ receptor: { doc: '30.123.456' } }).docTipo, 96);
  const c = armarReceptor({ receptor: { doc: '20-43339489-6', condIva: 6 } });
  assert.strictEqual(c.docTipo, 80); assert.strictEqual(c.condIva, 6);
  assert.ok(armarReceptor({ receptor: { doc: '20433394890' } }).error);
  assert.ok(cuitValido('20433394896'));
  assert.ok(!cuitValido('20433394891'));
});

test('fecha y número de comprobante', () => {
  // 02:00 UTC del 21 es todavía 20 en Argentina
  assert.strictEqual(fechaArgentina(new Date('2026-10-21T02:00:00Z')), '20261020');
  assert.strictEqual(numeroTxt(2, 123), '00002-00000123');
});

test('pedido de CAE con los campos en el orden de ARCA', () => {
  const x = arca.armarPedidoCAE({ token: 'T', sign: 'S', cuit: '20433394896' },
    { ptoVta: 2, cbteTipo: 13, numero: 5, fecha: '20261020', importe: 5000, docTipo: 99, docNro: '0', condIva: 5,
      asociado: { tipo: 11, ptoVta: 2, numero: 123, cuit: '20433394896', fecha: '20261020' } });
  const orden = ['Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch', 'ImpTotal', 'ImpTotConc', 'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA', 'MonId', 'MonCotiz', 'CondicionIVAReceptorId', 'CbtesAsoc'];
  let pos = -1;
  orden.forEach((t) => { const p = x.indexOf('<ar:' + t + '>'); assert.ok(p > pos, t + ' fuera de orden'); pos = p; });
  assert.ok(x.includes('<ar:ImpTotal>5000.00</ar:ImpTotal>'));
  assert.ok(x.includes('<ar:CbteTipo>13</ar:CbteTipo>'));
});

test('lee una respuesta aprobada y una rechazada', () => {
  const ok = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult>' +
    '<FeCabResp><Cuit>20433394896</Cuit><PtoVta>2</PtoVta><CbteTipo>11</CbteTipo><Resultado>A</Resultado></FeCabResp>' +
    '<FeDetResp><FECAEDetResponse><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>124</CbteDesde><CbteHasta>124</CbteHasta><Resultado>A</Resultado><CAE>76423501238877</CAE><CAEFchVto>20261030</CAEFchVto></FECAEDetResponse></FeDetResp>' +
    '</FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>';
  assert.deepStrictEqual(arca.leerRespuestaCAE(ok), { aprobado: true, cae: '76423501238877', caeVto: '20261030', numero: 124, observaciones: [] });
  const mal = ok.replace(/<Resultado>A<\/Resultado><CAE>.*<\/CAEFchVto>/, '<Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>Falta identificar al receptor</Msg></Obs></Observaciones>').replace('<Resultado>A</Resultado></FeCabResp>', '<Resultado>R</Resultado></FeCabResp>');
  const r = arca.leerRespuestaCAE(mal);
  assert.strictEqual(r.aprobado, false);
  assert.strictEqual(r.errores[0].codigo, '10015');
});

test('lee el token del login de ARCA', () => {
  const ta = '<?xml version="1.0" encoding="UTF-8"?><loginTicketResponse version="1.0"><header><source>CN=wsaa</source><destination>SERIALNUMBER=CUIT 20433394896</destination><uniqueId>1</uniqueId><generationTime>2026-10-20T10:00:00.000-03:00</generationTime><expirationTime>2026-10-20T22:00:00.000-03:00</expirationTime></header><credentials><token>TOK</token><sign>SIG</sign></credentials></loginTicketResponse>';
  const xml = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>' + arca.escaparXml(ta) + '</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>';
  assert.deepStrictEqual(arca.leerRespuestaLogin(xml), { token: 'TOK', sign: 'SIG', vence: '2026-10-21T01:00:00.000Z' });
});

test('firma el pedido de login con un certificado de prueba', () => {
  // Certificado inventado, generado en el momento (no es de ARCA).
  const claves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = claves.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'prueba' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(claves.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const cms = arca.firmarTRA(arca.armarTRA('wsfe'), certPem, forge.pki.privateKeyToPem(claves.privateKey));
  // Se verifica la firma con OpenSSL, igual que hace ARCA del otro lado.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-'));
  fs.writeFileSync(path.join(dir, 'cms.der'), Buffer.from(cms, 'base64'));
  const salida = execFileSync('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER', '-in', path.join(dir, 'cms.der')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  fs.rmSync(dir, { recursive: true });
  assert.ok(salida.includes('<service>wsfe</service>'));
  assert.ok(arca.venceCertificado(certPem) > new Date().toISOString());
});

test('link del QR con los datos que pide ARCA', () => {
  const u = arca.urlQR({ fecha: '20261020', cuit: '20433394896', ptoVta: 2, cbteTipo: 11, numero: 123, importe: 5000, docTipo: 99, docNro: '0', cae: '76423501238877' });
  assert.ok(u.startsWith('https://www.afip.gob.ar/fe/qr/?p='));
  const d = JSON.parse(Buffer.from(u.split('p=')[1], 'base64').toString());
  assert.strictEqual(d.fecha, '2026-10-20'); assert.strictEqual(d.nroCmp, 123); assert.strictEqual(d.tipoCodAut, 'E');
});

test('fecha de inicio: no factura antes de las 00:00 (Argentina) de ese día', () => {
  const cfg = { desde: '2026-11-01' };
  assert.strictEqual(antesDelInicio(cfg, '2026-11-01T02:59:00Z'), true);   // 31/10 23:59 en Argentina
  assert.strictEqual(antesDelInicio(cfg, '2026-11-01T03:00:00Z'), false);  // 01/11 00:00 en Argentina
  assert.strictEqual(antesDelInicio({}, '2026-10-01T12:00:00Z'), false);   // sin fecha: factura siempre
});
