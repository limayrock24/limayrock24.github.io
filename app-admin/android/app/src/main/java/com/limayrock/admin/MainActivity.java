package com.limayrock.admin;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    // El panel de admin puede terminar abriéndose en cualquiera de estas
    // direcciones (limayrock24.github.io redirige al dominio propio). Capacitor
    // solo conecta la página con la app (avisos) en la dirección inicial,
    // así que acá se la conecta también en las demás.
    private static final Set<String> OTROS_DOMINIOS = new HashSet<>(Arrays.asList(
        "https://limayrock.com.ar",
        "https://www.limayrock.com.ar",
        "https://limayrock24.github.io"
    ));

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AvisosService.crearCanales(this);
        conectarEnTodosLosDominios();
        // La ventana de la app no sabe descargar los archivos que arma la página
        // (PDF de pedidos, liquidaciones, CSV...): la página se los pasa acá y
        // se abre el menú Compartir de Android (WhatsApp, Drive, guardar).
        if (bridge != null) bridge.getWebView().addJavascriptInterface(new Archivos(), "LimayRockArchivos");
    }

    private class Archivos {
        @JavascriptInterface
        public boolean compartir(String base64, String nombre, String tipo) {
            try {
                String limpio = (nombre == null || nombre.trim().isEmpty()) ? "archivo" : nombre.trim();
                limpio = limpio.replaceAll("[\\\\/:*?\"<>|]", "_");
                File carpeta = new File(getCacheDir(), "compartidos");
                if (!carpeta.exists()) carpeta.mkdirs();
                File archivo = new File(carpeta, limpio);
                byte[] datos = Base64.decode(base64, Base64.DEFAULT);
                FileOutputStream salida = new FileOutputStream(archivo);
                try { salida.write(datos); } finally { salida.close(); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", archivo);
                Intent enviar = new Intent(Intent.ACTION_SEND);
                enviar.setType(tipo == null || tipo.isEmpty() ? "application/octet-stream" : tipo);
                enviar.putExtra(Intent.EXTRA_STREAM, uri);
                enviar.putExtra(Intent.EXTRA_SUBJECT, limpio);
                enviar.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                final Intent elegir = Intent.createChooser(enviar, limpio);
                elegir.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(new Runnable() { public void run() { startActivity(elegir); } });
                return true;
            } catch (Exception e) {
                Log.e("LimayRock", "No se pudo compartir el archivo", e);
                return false;
            }
        }
    }

    private void conectarEnTodosLosDominios() {
        try {
            if (bridge == null || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
            Method m = Bridge.class.getDeclaredMethod("getJSInjector");
            m.setAccessible(true);
            Object injector = m.invoke(bridge);
            if (injector == null) return;
            Method s = injector.getClass().getMethod("getScriptString");
            s.setAccessible(true);
            String js = (String) s.invoke(injector);
            // El dominio inicial ya lo conecta Capacitor; se agregan los demás.
            Set<String> origenes = new HashSet<>(OTROS_DOMINIOS);
            origenes.remove(android.net.Uri.parse(bridge.getServerUrl() != null ? bridge.getServerUrl() : "")
                .buildUpon().path(null).fragment(null).clearQuery().build().toString());
            if (!origenes.isEmpty()) WebViewCompat.addDocumentStartJavaScript(bridge.getWebView(), js, origenes);
        } catch (Exception e) {
            Log.e("LimayRock", "No se pudo conectar la app en los otros dominios", e);
        }
    }
}
