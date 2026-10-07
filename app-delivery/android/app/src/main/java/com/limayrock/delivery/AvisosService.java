package com.limayrock.delivery;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Avisos de Limay Rock (pedidos nuevos, pedido cobrado, etc.).
 *
 * La función de Firebase manda los avisos como "datos" (titulo, cuerpo, tag,
 * url), igual que a la página web. Una app no los muestra sola, así que acá se
 * arma la notificación a mano. Así llegan aunque la app esté cerrada o el
 * celular bloqueado, como los de WhatsApp.
 */
public class AvisosService extends FirebaseMessagingService {

    static final String CANAL_PEDIDOS = "pedidos";
    static final String CANAL_AVISOS = "avisos";

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        String titulo = d.get("titulo");
        String cuerpo = d.get("cuerpo");
        String tag = d.get("tag");
        if (msg.getNotification() != null) {
            if (titulo == null) titulo = msg.getNotification().getTitle();
            if (cuerpo == null) cuerpo = msg.getNotification().getBody();
        }
        if (titulo == null || titulo.isEmpty()) titulo = "Limay Rock";
        if (cuerpo == null) cuerpo = "";
        boolean esPedido = "pedido".equals(tag);

        crearCanales();

        Intent abrir = new Intent(this, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, abrir,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, esPedido ? CANAL_PEDIDOS : CANAL_AVISOS)
                .setSmallIcon(R.drawable.ic_aviso)
                .setColor(0xFFF5C200)
                .setContentTitle(titulo)
                .setContentText(cuerpo)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(cuerpo))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(esPedido ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT);
        if (esPedido) {
            b.setVibrate(new long[]{0, 300, 100, 300, 100, 300});
            b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
        }

        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return; // el repartidor no dio permiso de notificaciones
        }
        NotificationManagerCompat.from(this).notify(tag != null ? tag : "limayrock", (int) (System.currentTimeMillis() % Integer.MAX_VALUE), b.build());
    }

    @Override
    public void onNewToken(String token) {
        // La página de delivery vuelve a registrar el celular cada vez que se abre la app.
    }

    private void crearCanales() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CANAL_PEDIDOS) == null) {
            NotificationChannel c = new NotificationChannel(CANAL_PEDIDOS, "Pedidos nuevos", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Avisos de pedidos de delivery");
            c.enableVibration(true);
            c.setVibrationPattern(new long[]{0, 300, 100, 300, 100, 300});
            Uri sonido = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            c.setSound(sonido, new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            c.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CANAL_AVISOS) == null) {
            NotificationChannel c = new NotificationChannel(CANAL_AVISOS, "Otros avisos", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(c);
        }
    }
}
