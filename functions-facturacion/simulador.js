// ══════════════════════════════════════════════════════════════════════════
// SIMULADOR DE ARCA — para probar sin conectarse a ARCA de verdad.
//
// Responde igual que ARCA (números correlativos, CAE de 14 dígitos,
// vencimiento a 10 días) pero los comprobantes NO VALEN: el CAE es inventado.
// Se usa en el emulador y mientras no esté cargado el certificado.
// Los números se guardan en arcaPrivado/simulador_<ptoVta>_<tipo>.
// ══════════════════════════════════════════════════════════════════════════
'use strict';

const { ErrorArca } = require('./arca');

function crearSimulador(db, opciones) {
  const op = opciones || {};
  const ref = (ptoVta, cbteTipo) => db.collection('arcaPrivado').doc('simulador_' + ptoVta + '_' + cbteTipo);

  async function fallaPedida() {
    // Para probar qué pasa cuando ARCA no responde: con
    // config/facturacion.simularFalla = true el simulador "se cae".
    if (op.leerConfig) {
      const cfg = await op.leerConfig();
      if (cfg && cfg.simularFalla) throw new ErrorArca('ARCA no respondió a tiempo (simulado)', { reintentable: true });
    }
  }

  return {
    modo: 'simulado',
    async ultimoAutorizado(ptoVta, cbteTipo) {
      await fallaPedida();
      const s = await ref(ptoVta, cbteTipo).get();
      return s.exists ? Number(s.data().ultimo || 0) : 0;
    },
    async solicitarCAE(c) {
      await fallaPedida();
      return db.runTransaction(async (tx) => {
        const r = ref(c.ptoVta, c.cbteTipo);
        const s = await tx.get(r);
        const ultimo = s.exists ? Number(s.data().ultimo || 0) : 0;
        const emitidos = (s.exists && s.data().emitidos) || {};
        // Mismas validaciones básicas que hace ARCA.
        if (c.numero !== ultimo + 1) {
          return { aprobado: false, errores: [{ codigo: '10016', mensaje: 'El número de comprobante no es el siguiente (simulado). Último: ' + ultimo }] };
        }
        if (!(Number(c.importe) > 0)) {
          return { aprobado: false, errores: [{ codigo: '10048', mensaje: 'El importe total tiene que ser mayor a cero (simulado)' }] };
        }
        const cae = String(70000000000000 + Math.floor(Math.random() * 9999999999999)).slice(0, 14);
        const vto = new Date(Date.now() + 10 * 24 * 3600 * 1000);
        const caeVto = vto.toISOString().slice(0, 10).replace(/-/g, '');
        emitidos[String(c.numero)] = { cae, caeVto, importe: Number(c.importe), docNro: String(c.docNro) };
        tx.set(r, { ultimo: c.numero, emitidos }, { merge: true });
        return { aprobado: true, cae, caeVto, numero: c.numero, observaciones: [] };
      });
    },
    async consultar(ptoVta, cbteTipo, numero) {
      const s = await ref(ptoVta, cbteTipo).get();
      const e = s.exists && s.data().emitidos && s.data().emitidos[String(numero)];
      return e ? Object.assign({ numero }, e) : null;
    }
  };
}

module.exports = { crearSimulador };
