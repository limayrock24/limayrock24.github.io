# Notificaciones push (Cloud Run functions)

Copia de referencia del código de las funciones que mandan las notificaciones
(proyecto `limay-rock-852cb`, región `southamerica-east1`). Cada función se
publica por separado desde esta misma carpeta, en Google Cloud Shell.

## Publicar / actualizar TODAS las funciones (método recomendado)

Así se instalaron las 8 el 14/10/2026 (Node.js 22). Usa la herramienta de
Firebase, que es con la que se crearon originalmente: los avisos reciben los
datos del documento igual que siempre.

```
mkdir -p ~/limay-fb/functions && cd ~/limay-fb
curl -fsSL -o functions/index.js https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/index.js
curl -fsSL -o functions/package.json https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/package.json
echo '{"functions":{"source":"functions"}}' > firebase.json
(cd functions && npm install --silent)
npx -y firebase-tools@latest login --no-localhost
npx -y firebase-tools@latest deploy --only functions --project limay-rock-852cb
```

## (Viejo) Publicar solo la función de mensajes con gcloud

Ojo: publicada con gcloud, la función recibe el evento SIN los datos del
documento (por eso avisoMensajeRepartidor busca los mensajes por consulta).

```
mkdir -p ~/limay-avisos && cd ~/limay-avisos
curl -fsSL -o index.js https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/index.js
curl -fsSL -o package.json https://raw.githubusercontent.com/limayrock24/limayrock24.github.io/main/functions/package.json
SA=$(gcloud functions describe avisoPedidoNuevo --region=southamerica-east1 --format='value(serviceConfig.serviceAccountEmail)')
TSA=$(gcloud functions describe avisoPedidoNuevo --region=southamerica-east1 --format='value(eventTrigger.serviceAccountEmail)')
gcloud functions deploy avisoMensajeRepartidor --gen2 --region=southamerica-east1 --runtime=nodejs22 \
  --source=. --entry-point=avisoMensajeRepartidor --trigger-location=southamerica-east1 \
  --trigger-event-filters=type=google.cloud.firestore.document.v1.created \
  --trigger-event-filters=database='(default)' \
  --trigger-event-filters-path-pattern=document='avisosDelivery/{id}' \
  --service-account="$SA" --trigger-service-account="$TSA" \
  --set-env-vars=GCLOUD_PROJECT=limay-rock-852cb
```

Usa la misma cuenta de servicio que `avisoPedidoNuevo`, así tiene los mismos
permisos (leer `fcmTokens` y mandar avisos).
