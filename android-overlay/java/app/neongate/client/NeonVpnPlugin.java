package app.neongate.client;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Мост JS -> VpnService.
 *   NeonVpn.start({config})  — запрашивает у пользователя разрешение VPN (если ещё не выдано),
 *                              сохраняет конфиг и запускает NeonVpnService
 *   NeonVpn.stop()           — останавливает сервис
 * События для JS: "log" {message}, "exit" {reason}
 */
@CapacitorPlugin(name = "NeonVpn")
public class NeonVpnPlugin extends Plugin {

    @Override
    public void load() {
        NeonVpnService.setListener((event, key, value) -> {
            JSObject data = new JSObject();
            data.put(key, value);
            notifyListeners(event, data);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        String config = call.getString("config");
        if (config == null || config.isEmpty()) {
            call.reject("config is required");
            return;
        }
        // Если разрешения ещё нет, система покажет диалог «Запрос на подключение».
        Intent prepare = VpnService.prepare(getContext());
        if (prepare != null) {
            startActivityForResult(call, prepare, "onVpnPermission");
        } else {
            launch(call);
        }
    }

    @ActivityCallback
    private void onVpnPermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK) launch(call);
        else call.reject("Разрешение на VPN не выдано");
    }

    private void launch(PluginCall call) {
        try {
            // Конфиг кладём в приватный каталог приложения (не в Intent — там лимит размера)
            File dir = new File(getContext().getFilesDir(), "singbox");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("mkdirs failed");
            try (FileOutputStream out = new FileOutputStream(new File(dir, "config.json"))) {
                out.write(call.getString("config").getBytes(StandardCharsets.UTF_8));
            }
            Intent i = new Intent(getContext(), NeonVpnService.class).setAction(NeonVpnService.ACTION_START);
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось запустить VPN: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), NeonVpnService.class).setAction(NeonVpnService.ACTION_STOP);
        getContext().startService(i);
        call.resolve();
    }
}
