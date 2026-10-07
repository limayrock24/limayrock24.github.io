package com.limayrock.delivery;

import android.os.Bundle;
import android.util.Log;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    // El panel de delivery puede terminar abriéndose en cualquiera de estas
    // direcciones (limayrock24.github.io redirige al dominio propio). Capacitor
    // solo conecta la página con la app (GPS, avisos) en la dirección inicial,
    // así que acá se la conecta también en las demás.
    private static final Set<String> OTROS_DOMINIOS = new HashSet<>(Arrays.asList(
        "https://limayrock.com.ar",
        "https://www.limayrock.com.ar",
        "https://limayrock24.github.io"
    ));

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        conectarEnTodosLosDominios();
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
