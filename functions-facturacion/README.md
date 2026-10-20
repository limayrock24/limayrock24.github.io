# Facturación electrónica (ARCA) — funciones de Firebase

Esta carpeta es la parte del sistema que habla con ARCA. Está separada de
`functions/` (notificaciones): es otro *codebase* de Firebase, así que publicar
una no toca la otra. Corre en los servidores
de Google (Cloud Functions), **no en la página**, para que el certificado y la
clave privada nunca queden a la vista.

## Cómo funciona

1. El punto de venta guarda la venta con `facturaPedido` cuando se cobró algo
   por Mercado Pago (transferencia o Point). En un pago mixto, solo esa parte.
2. `facturarVenta` ve la venta nueva, crea `facturas/<idVenta>` y pide el CAE
   a ARCA (Factura C, código 11, "Venta de mercadería").
3. Si la venta se anula, `anularFactura` emite la Nota de Crédito C (código 13)
   en `facturas/<idVenta>_NC`.
4. Si ARCA no responde, la factura queda `pendiente` y `reintentarPendientes`
   la vuelve a intentar cada 10 minutos. El admin también puede tocar
   "Reintentar ahora" (deja un pedido en `facturacionSolicitudes`).
5. Los números son correlativos: un turno en `arcaPrivado` hace que las dos
   cajas pidan de a una. Si un intento se corta a mitad de camino, el próximo
   consulta a ARCA si ese número ya se autorizó, para no facturar dos veces.

La facturación se prende y se apaga desde Admin → Dinero → Facturas
(`config/facturacion.activa`).

## Modos (`functions-facturacion/.env` → `ARCA_MODO`)

| Modo | Qué hace |
|---|---|
| `simulado` | No se conecta a ARCA. CAE inventado; los comprobantes dicen "SIMULADO · NO VÁLIDO". |
| `homologacion` | Ambiente de pruebas de ARCA. Hace falta el certificado de pruebas. |
| `produccion` | Facturas reales. |

## Secretos (nunca en el repositorio)

El certificado y la clave privada se cargan en Google Secret Manager como
`ARCA_CERT` y `ARCA_KEY`. Al tenerlos cargados se pone `ARCA_CON_SECRETOS=si`
en `.env`. Los archivos `.key`, `.pem`, `.crt` y `.csr` están en `.gitignore`.

## Pruebas

```
cd functions-facturacion && npm install && npm test
```

Las pruebas no se conectan a nada: arman y leen los mensajes de ARCA y
verifican la firma digital con OpenSSL.
