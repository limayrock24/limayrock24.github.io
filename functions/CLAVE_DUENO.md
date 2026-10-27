# Clave de dueño: ver lo privado desde la caja

En la caja se entra con la cuenta de la caja (`local@`). Esa cuenta no puede
leer lo privado del dueño: detalle de egresos, pagos privados, valor hora y
configuración. Con la **clave de dueño** se puede ver todo eso desde una caja
durante **30 minutos**.

- **Dónde se revisa:** en la nube, con la función `claveDueno`, nunca en la PC.
- **Dónde se guarda:** solo su huella cifrada (scrypt con sal) en
  `servidorPrivado/claveDueno`. Las reglas no dejan que ninguna cuenta lea
  esa colección, ni siquiera la del dueño.
- **No está en el código ni en GitHub.**

## Cómo se usa en la caja
1. En el admin abierto en la caja, en cualquier pantalla con 🔒, tocá **"🔑 Ver con la clave de dueño"**.
2. Escribí la clave. Abajo aparece una barra verde: **"Modo dueño en esta caja hasta las HH:MM"**.
3. El modo dueño se corta solo:
   - cuando cerrás el admin,
   - cuando tocás "Cerrar ahora" en la barra, o
   - a los 30 minutos.

   En los tres casos lo privado se borra de la memoria de la caja.
4. **La venta no depende de esto.** Si la nube no responde, la caja sigue vendiendo normal; lo único que no se puede es ver lo privado.

## Cómo definirla o cambiarla
1. En tu compu o tu celu (no en la caja), abrí una **ventana de incógnito** (en Chrome: Ctrl + Shift + N).
2. Entrá a **limayrock24.github.io/admin/** y identificate **con tu cuenta de dueño** (`admin@`) y tu contraseña.
3. Andá a **Dinero → Rentabilidad → 🔑 Clave de dueño para la caja**.
4. Escribí la clave nueva dos veces y tocá **"Guardar clave"**.
5. Cerrá la ventana de incógnito.

**Requisitos de la clave:**
- Entre 8 y 64 caracteres: letras, números y símbolos.
- Si es fácil de adivinar (solo números, por ejemplo), avisa, pero deja guardarla.

**Otras cosas a tener en cuenta:**
- No hace falta saber la clave anterior.
- Por seguridad, tenés que **haber entrado con tu contraseña hace menos de 10 minutos**. Por eso se hace en una ventana de incógnito: ahí siempre entrás de cero con tu contraseña. (La página no tiene botón para cerrar la sesión de la cuenta.)
- Poner una clave nueva **desbloquea** la clave si estaba bloqueada por intentos.

## Intentos fallidos
- Se cuentan **en la nube y para todas las cajas juntas**. Recargar la página, cambiar de navegador o de PC no los resetea.
- Con **5 seguidos mal**, la clave se bloquea **15 minutos** y se levanta sola.
- Llega un aviso al celular del dueño (las notificaciones de dueño del sistema):
  - cuando la clave **se bloquea**;
  - cada vez que alguien **entra** con la clave.
- La cuenta del dueño (`admin@`) **nunca** queda bloqueada por esto.

## Emergencias (sin depender de nadie)

**Me olvidé la clave**
- Poné una nueva desde una ventana de incógnito, con tu cuenta de dueño (ver arriba).

**Se bloqueó y no puedo esperar los 15 minutos**
- Opción 1: poné una clave nueva desde una ventana de incógnito, con tu cuenta de dueño (ver arriba). Se desbloquea al instante.
- Opción 2:
  1. En la consola de Firebase (console.firebase.google.com, proyecto `limay-rock-852cb`), andá a **Firestore Database → Datos → `intentosClave` → `caja`**.
  2. Tocá los tres puntos → **Borrar documento**.

  Eso solo borra el contador de intentos.

**También me olvidé la contraseña de la cuenta del dueño**
1. En la consola de Firebase, andá a **Authentication → Usuarios**.
2. Buscá `admin@limayrock.app` → tres puntos → **Restablecer contraseña**, o editala.

Se hace con tu cuenta de Google del proyecto.

**La nube no responde (sin internet, o la función caída)**
- La caja sigue vendiendo.
- Lo privado se ve desde tu celu o tu compu con tu cuenta, o desde la PC de la caja en una ventana de incógnito (Ctrl + Shift + N) entrando con tu cuenta. Cerrá esa ventana al terminar.

## Publicarla (dos pasos, con copia para volver atrás)
1. **La función**, desde Google Cloud Shell. Se publica **solo** `claveDueno`; las demás no se tocan:
   ```
   mkdir -p ~/limay-fb/functions && cd ~/limay-fb
   curl -fsSL -o functions/index.js https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/index.js
   curl -fsSL -o functions/package.json https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/package.json
   echo '{"functions":{"source":"functions"}}' > firebase.json
   (cd functions && npm install --silent)
   npx -y firebase-tools@latest deploy --only functions:claveDueno --project limay-rock-852cb
   ```
2. **Las reglas** (`firestore.rules`), con la copia de las anteriores guardada y el mismo procedimiento del 23/10 (`~/reglas/publicar_reglas.py`).
3. Recién después, la página (el admin y la caja), que trae el botón y la pantalla para definir la clave.

## Volver atrás
- **Reglas:** volver a publicar la copia guardada antes del cambio.
- **Función:** `npx -y firebase-tools@latest functions:delete claveDueno --region southamerica-east1 --project limay-rock-852cb`.
- **Página:** volver a la versión anterior en GitHub.

Sin la función y sin las reglas nuevas, el botón de la clave avisa que no se pudo comprobar y la caja sigue como antes del cambio.
