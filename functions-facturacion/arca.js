// ══════════════════════════════════════════════════════════════════════════
// CONEXIÓN CON ARCA (ex AFIP) — webservices oficiales WSAA + WSFEv1
//
// WSAA: "login". Con el certificado y la clave privada se firma un pedido
//       y ARCA devuelve un token + firma que valen ~12 horas.
// WSFE: facturación. Con ese token se piden el último número autorizado y
//       el CAE de cada comprobante nuevo.
//
// El certificado y la clave NUNCA están en este código ni en el repositorio:
// llegan como secretos de Google (Secret Manager) en el momento de usarlos.
// ══════════════════════════════════════════════════════════════════════════
'use strict';

const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');
const { XMLParser } = require('fast-xml-parser');

const URLS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  }
};

// Tipos de comprobante de ARCA que usa un monotributista.
const CBTE = { FACTURA_C: 11, NOTA_CREDITO_C: 13 };
// Tipos de documento del receptor.
const DOC = { CUIT: 80, DNI: 96, SIN_IDENTIFICAR: 99 };
// Condición frente al IVA del receptor (RG 5616).
const COND_IVA = { RESPONSABLE_INSCRIPTO: 1, EXENTO: 4, CONSUMIDOR_FINAL: 5, MONOTRIBUTO: 6 };

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

// Los servidores de ARCA todavía usan claves de cifrado viejas que Node
// rechaza por defecto; sin esto la conexión se corta antes de empezar.
const agente = new https.Agent({
  keepAlive: true,
  ciphers: 'DEFAULT@SECLEVEL=0',
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

function postSoap(url, accion, cuerpo, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST', agent: agente,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': accion,
        'Content-Length': Buffer.byteLength(cuerpo)
      },
      timeout: timeoutMs || 20000
    }, (res) => {
      let datos = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { datos += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: datos }));
    });
    req.on('timeout', () => req.destroy(new ErrorArca('ARCA no respondió a tiempo', { reintentable: true })));
    req.on('error', (e) => reject(e instanceof ErrorArca ? e : new ErrorArca('No se pudo conectar con ARCA: ' + e.message, { reintentable: true })));
    req.write(cuerpo);
    req.end();
  });
}

class ErrorArca extends Error {
  constructor(mensaje, opciones) {
    super(mensaje);
    this.reintentable = !!(opciones && opciones.reintentable);
    this.errores = (opciones && opciones.errores) || [];
  }
}

function escaparXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── WSAA ─────────────────────────────────────────────────────────────────
function armarTRA(servicio, ahora) {
  const t = ahora || new Date();
  const desde = new Date(t.getTime() - 10 * 60 * 1000).toISOString();
  const hasta = new Date(t.getTime() + 10 * 60 * 1000).toISOString();
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0"><header>' +
    '<uniqueId>' + Math.floor(t.getTime() / 1000) + '</uniqueId>' +
    '<generationTime>' + desde + '</generationTime>' +
    '<expirationTime>' + hasta + '</expirationTime>' +
    '</header><service>' + servicio + '</service></loginTicketRequest>';
}

// Firma el pedido de login (CMS / PKCS#7 con el contenido adentro).
function firmarTRA(tra, certPem, clavePem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const clave = forge.pki.privateKeyFromPem(clavePem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: clave,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

// Fecha de vencimiento del certificado (para avisar antes de que venza).
function venceCertificado(certPem) {
  return forge.pki.certificateFromPem(certPem).validity.notAfter.toISOString();
}

function leerRespuestaLogin(xml) {
  const sobre = parser.parse(xml);
  const cuerpo = sobre && sobre.Envelope && sobre.Envelope.Body;
  if (cuerpo && cuerpo.Fault) {
    const msg = String(cuerpo.Fault.faultstring || 'Error de ARCA');
    // "alreadyAuthenticated": ya hay un token vigente pedido antes (por
    // ejemplo, desde una prueba a mano). Vence solo en unas horas.
    if (/alreadyAuthenticated|ya posee un TA/i.test(msg)) {
      throw new ErrorArca('ARCA todavía tiene abierta una sesión anterior (vence sola en unas horas); se reintenta solo', { reintentable: true });
    }
    throw new ErrorArca('ARCA rechazó el login: ' + msg, { reintentable: true });
  }
  const ret = cuerpo && cuerpo.loginCmsResponse && cuerpo.loginCmsResponse.loginCmsReturn;
  if (!ret) throw new ErrorArca('Respuesta de login de ARCA no reconocida', { reintentable: true });
  const ta = parser.parse(String(ret)).loginTicketResponse;
  return {
    token: String(ta.credentials.token),
    sign: String(ta.credentials.sign),
    vence: new Date(String(ta.header.expirationTime)).toISOString()
  };
}

async function login(modo, certPem, clavePem) {
  const cms = firmarTRA(armarTRA('wsfe'), certPem, clavePem);
  const sobre = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
    '<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>' + cms + '</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>';
  const r = await postSoap(URLS[modo].wsaa, '""', sobre);
  return leerRespuestaLogin(r.body);
}

// ── WSFE ─────────────────────────────────────────────────────────────────
function auth(cred) {
  return '<ar:Auth><ar:Token>' + cred.token + '</ar:Token><ar:Sign>' + cred.sign + '</ar:Sign><ar:Cuit>' + cred.cuit + '</ar:Cuit></ar:Auth>';
}

function sobreWsfe(metodo, interior) {
  return '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">' +
    '<soapenv:Header/><soapenv:Body><ar:' + metodo + '>' + interior + '</ar:' + metodo + '></soapenv:Body></soapenv:Envelope>';
}

function lista(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

function erroresDe(resultado) {
  return lista(resultado && resultado.Errors && resultado.Errors.Err).map((e) => ({ codigo: String(e.Code), mensaje: String(e.Msg) }));
}

function resultadoDe(xml, metodo) {
  const sobre = parser.parse(xml);
  const cuerpo = sobre && sobre.Envelope && sobre.Envelope.Body;
  if (cuerpo && cuerpo.Fault) throw new ErrorArca('ARCA devolvió un error: ' + cuerpo.Fault.faultstring, { reintentable: true });
  const r = cuerpo && cuerpo[metodo + 'Response'] && cuerpo[metodo + 'Response'][metodo + 'Result'];
  if (!r) throw new ErrorArca('Respuesta de ARCA no reconocida (' + metodo + ')', { reintentable: true });
  return r;
}

function importe(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }

// Arma el pedido de CAE de UN comprobante. El orden de los campos es el
// que exige ARCA (si se cambia, rechaza el pedido).
function armarDetalle(c) {
  let x = '<ar:FECAEDetRequest>' +
    '<ar:Concepto>1</ar:Concepto>' +
    '<ar:DocTipo>' + c.docTipo + '</ar:DocTipo>' +
    '<ar:DocNro>' + c.docNro + '</ar:DocNro>' +
    '<ar:CbteDesde>' + c.numero + '</ar:CbteDesde>' +
    '<ar:CbteHasta>' + c.numero + '</ar:CbteHasta>' +
    '<ar:CbteFch>' + c.fecha + '</ar:CbteFch>' +
    '<ar:ImpTotal>' + importe(c.importe) + '</ar:ImpTotal>' +
    '<ar:ImpTotConc>0.00</ar:ImpTotConc>' +
    '<ar:ImpNeto>' + importe(c.importe) + '</ar:ImpNeto>' +
    '<ar:ImpOpEx>0.00</ar:ImpOpEx>' +
    '<ar:ImpTrib>0.00</ar:ImpTrib>' +
    '<ar:ImpIVA>0.00</ar:ImpIVA>' +
    '<ar:MonId>PES</ar:MonId>' +
    '<ar:MonCotiz>1</ar:MonCotiz>' +
    '<ar:CondicionIVAReceptorId>' + c.condIva + '</ar:CondicionIVAReceptorId>';
  if (c.asociado) {
    x += '<ar:CbtesAsoc><ar:CbteAsoc>' +
      '<ar:Tipo>' + c.asociado.tipo + '</ar:Tipo>' +
      '<ar:PtoVta>' + c.asociado.ptoVta + '</ar:PtoVta>' +
      '<ar:Nro>' + c.asociado.numero + '</ar:Nro>' +
      '<ar:Cuit>' + c.asociado.cuit + '</ar:Cuit>' +
      '<ar:CbteFch>' + c.asociado.fecha + '</ar:CbteFch>' +
      '</ar:CbteAsoc></ar:CbtesAsoc>';
  }
  return x + '</ar:FECAEDetRequest>';
}

function armarPedidoCAE(cred, c) {
  return sobreWsfe('FECAESolicitar', auth(cred) +
    '<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg>' +
    '<ar:PtoVta>' + c.ptoVta + '</ar:PtoVta><ar:CbteTipo>' + c.cbteTipo + '</ar:CbteTipo></ar:FeCabReq>' +
    '<ar:FeDetReq>' + armarDetalle(c) + '</ar:FeDetReq></ar:FeCAEReq>');
}

function leerRespuestaCAE(xml) {
  const r = resultadoDe(xml, 'FECAESolicitar');
  const det = lista(r.FeDetResp && r.FeDetResp.FECAEDetResponse)[0] || {};
  const obs = lista(det.Observaciones && det.Observaciones.Obs).map((o) => ({ codigo: String(o.Code), mensaje: String(o.Msg) }));
  const errores = erroresDe(r);
  const resultado = String(det.Resultado || (r.FeCabResp && r.FeCabResp.Resultado) || 'R');
  if (resultado === 'A') {
    return { aprobado: true, cae: String(det.CAE), caeVto: String(det.CAEFchVto), numero: Number(det.CbteDesde), observaciones: obs };
  }
  return { aprobado: false, errores: errores.concat(obs) };
}

async function ultimoAutorizado(modo, cred, ptoVta, cbteTipo) {
  const sobre = sobreWsfe('FECompUltimoAutorizado', auth(cred) + '<ar:PtoVta>' + ptoVta + '</ar:PtoVta><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo>');
  const resp = await postSoap(URLS[modo].wsfe, 'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado', sobre);
  const r = resultadoDe(resp.body, 'FECompUltimoAutorizado');
  const errores = erroresDe(r);
  if (errores.length) throw new ErrorArca('ARCA: ' + errores.map((e) => e.mensaje).join(' / '), { errores });
  return Number(r.CbteNro || 0);
}

async function solicitarCAE(modo, cred, c) {
  const resp = await postSoap(URLS[modo].wsfe, 'http://ar.gov.afip.dif.FEV1/FECAESolicitar', armarPedidoCAE(cred, c), 30000);
  return leerRespuestaCAE(resp.body);
}

// Consulta un comprobante ya emitido (para recuperarse si se cortó la
// conexión justo después de pedir el CAE y no se supo la respuesta).
async function consultar(modo, cred, ptoVta, cbteTipo, numero) {
  const sobre = sobreWsfe('FECompConsultar', auth(cred) +
    '<ar:FeCompConsReq><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo><ar:CbteNro>' + numero + '</ar:CbteNro><ar:PtoVta>' + ptoVta + '</ar:PtoVta></ar:FeCompConsReq>');
  const resp = await postSoap(URLS[modo].wsfe, 'http://ar.gov.afip.dif.FEV1/FECompConsultar', sobre);
  const r = resultadoDe(resp.body, 'FECompConsultar');
  const g = r.ResultGet;
  if (!g || !g.CodAutorizacion) return null;
  return { cae: String(g.CodAutorizacion), caeVto: String(g.FchVto), importe: Number(g.ImpTotal), docNro: String(g.DocNro), numero: Number(g.CbteDesde) };
}

// ── QR (RG 4892) ─────────────────────────────────────────────────────────
// Link oficial que cualquiera puede escanear para verificar el comprobante.
function urlQR(d) {
  const datos = {
    ver: 1,
    fecha: d.fecha.slice(0, 4) + '-' + d.fecha.slice(4, 6) + '-' + d.fecha.slice(6, 8),
    cuit: Number(d.cuit),
    ptoVta: Number(d.ptoVta),
    tipoCmp: Number(d.cbteTipo),
    nroCmp: Number(d.numero),
    importe: Number(importe(d.importe)),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: Number(d.docTipo),
    nroDocRec: Number(d.docNro),
    tipoCodAut: 'E',
    codAut: Number(d.cae)
  };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(datos)).toString('base64');
}

// Cliente real (homologación o producción) con la misma forma que el
// simulador, para que el resto del código no sepa contra cuál habla.
function crearClienteReal(modo, cuit, obtenerCredenciales) {
  return {
    modo,
    async ultimoAutorizado(ptoVta, cbteTipo) { return ultimoAutorizado(modo, await obtenerCredenciales(), ptoVta, cbteTipo); },
    async solicitarCAE(c) { return solicitarCAE(modo, await obtenerCredenciales(), c); },
    async consultar(ptoVta, cbteTipo, numero) { return consultar(modo, await obtenerCredenciales(), ptoVta, cbteTipo, numero); }
  };
}

module.exports = {
  URLS, CBTE, DOC, COND_IVA, ErrorArca,
  armarTRA, firmarTRA, venceCertificado, leerRespuestaLogin, login,
  armarPedidoCAE, leerRespuestaCAE, urlQR, importe, escaparXml,
  crearClienteReal
};
