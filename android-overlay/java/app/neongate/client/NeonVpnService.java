package app.neongate.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

// libbox.aar — сборка ядра sing-box для Android (gomobile). См. README, раздел «Android».
import io.nekohasekai.libbox.BoxService;
import io.nekohasekai.libbox.InterfaceUpdateListener;
import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.NetworkInterfaceIterator;
import io.nekohasekai.libbox.PlatformInterface;
import io.nekohasekai.libbox.RoutePrefix;
import io.nekohasekai.libbox.RoutePrefixIterator;
import io.nekohasekai.libbox.SetupOptions;
import io.nekohasekai.libbox.StringIterator;
import io.nekohasekai.libbox.TunOptions;

/**
 * VpnService, внутри которого работает sing-box (libbox).
 *
 * ВАЖНО: интерфейс PlatformInterface меняется между версиями sing-box. Ниже — реализация
 * под ветку 1.12.x. Если при сборке компилятор жалуется на «does not override abstract
 * method…», добавьте недостающие методы по образцу класса PlatformInterfaceWrapper из
 * репозитория SagerNet/sing-box-for-android той же версии. Ядро сборки (libbox.aar) и
 * этот файл должны быть одной версии.
 */
public class NeonVpnService extends VpnService implements PlatformInterface {

    public static final String ACTION_START = "app.neongate.client.START";
    public static final String ACTION_STOP = "app.neongate.client.STOP";
    private static final String CHANNEL_ID = "neongate_vpn";

    /** Слушатель событий для плагина (log/exit). */
    public interface EventListener { void onEvent(String event, String key, String value); }
    private static volatile EventListener listener;
    public static void setListener(EventListener l) { listener = l; }
    private static void emit(String event, String key, String value) {
        EventListener l = listener;
        if (l != null) l.onEvent(event, key, value);
    }

    private BoxService box;
    private ParcelFileDescriptor tunFd;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopBox("stopped");
            return START_NOT_STICKY;
        }
        startForeground(1, buildNotification());
        new Thread(this::startBox, "neongate-core").start();
        return START_NOT_STICKY;
    }

    private synchronized void startBox() {
        try {
            File base = new File(getFilesDir(), "singbox");
            File tmp = new File(getCacheDir(), "singbox");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();

            SetupOptions opts = new SetupOptions();
            opts.setBasePath(base.getAbsolutePath());
            opts.setWorkingPath(base.getAbsolutePath());
            opts.setTempPath(tmp.getAbsolutePath());
            opts.setFixAndroidStack(true);
            Libbox.setup(opts);

            String config = new String(Files.readAllBytes(new File(base, "config.json").toPath()), StandardCharsets.UTF_8);
            box = Libbox.newService(config, this);
            box.start();
            emit("log", "message", "INFO sing-box запущен");
        } catch (Throwable t) {
            emit("log", "message", "ERROR " + t.getMessage());
            stopBox("error: " + t.getMessage());
        }
    }

    private synchronized void stopBox(String reason) {
        try { if (box != null) box.close(); } catch (Throwable ignored) { }
        box = null;
        try { if (tunFd != null) tunFd.close(); } catch (Throwable ignored) { }
        tunFd = null;
        stopForeground(true);
        stopSelf();
        emit("exit", "reason", reason);
    }

    @Override
    public void onRevoke() { stopBox("revoked"); }   // пользователь отключил VPN в системе

    @Override
    public void onDestroy() { stopBox("destroyed"); super.onDestroy(); }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "NeonGate VPN", NotificationManager.IMPORTANCE_LOW));
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("NeonGate")
                .setContentText("VPN активен")
                .setSmallIcon(android.R.drawable.stat_sys_vpn_ic)
                .setOngoing(true)
                .build();
    }

    /* ================= PlatformInterface ================= */

    /** Создаёт TUN через системный VpnService.Builder и отдаёт sing-box файловый дескриптор. */
    @Override
    public int openTun(TunOptions o) throws Exception {
        if (VpnService.prepare(this) != null) throw new IllegalStateException("android: нет разрешения VPN");
        Builder b = new Builder().setSession("NeonGate").setMtu(o.getMTU());

        RoutePrefixIterator a4 = o.getInet4Address();
        while (a4.hasNext()) { RoutePrefix p = a4.next(); b.addAddress(p.address(), p.prefix()); }
        RoutePrefixIterator a6 = o.getInet6Address();
        while (a6.hasNext()) { RoutePrefix p = a6.next(); b.addAddress(p.address(), p.prefix()); }

        if (o.getAutoRoute()) {
            b.addDnsServer(o.getDNSServerAddress().getValue());
            RoutePrefixIterator r4 = o.getInet4RouteAddress();
            if (r4.hasNext()) { while (r4.hasNext()) { RoutePrefix p = r4.next(); b.addRoute(p.address(), p.prefix()); } }
            else b.addRoute("0.0.0.0", 0);
            RoutePrefixIterator r6 = o.getInet6RouteAddress();
            if (r6.hasNext()) { while (r6.hasNext()) { RoutePrefix p = r6.next(); b.addRoute(p.address(), p.prefix()); } }
            else b.addRoute("::", 0);
        }
        // Собственный трафик приложения (в т.ч. исходящее соединение ядра к VPS) — мимо TUN,
        // иначе получится петля.
        b.addDisallowedApplication(getPackageName());

        tunFd = b.establish();
        if (tunFd == null) throw new IllegalStateException("android: VpnService.Builder.establish() вернул null");
        return tunFd.detachFd();   // владение дескриптором переходит к sing-box
    }

    @Override public boolean usePlatformAutoDetectInterfaceControl() { return true; }
    @Override public void autoDetectInterfaceControl(int fd) { protect(fd); }   // исходящие сокеты ядра — мимо VPN
    @Override public void writeLog(String message) { emit("log", "message", message); }
    @Override public boolean useProcFS() { return Build.VERSION.SDK_INT < 29; }
    @Override public boolean underNetworkExtension() { return false; }
    @Override public boolean includeAllNetworks() { return false; }
    @Override public void clearDNSCache() { }

    // --- заглушки: достаточны для базового сценария «весь трафик через VLESS» ---
    // Для смены Wi-Fi/LTE «на лету» реализуйте мониторинг сети по образцу DefaultNetworkMonitor
    // из sing-box-for-android (ConnectivityManager.registerDefaultNetworkCallback + listener.updateDefaultInterface).
    @Override public void startDefaultInterfaceMonitor(InterfaceUpdateListener l) { }
    @Override public void closeDefaultInterfaceMonitor(InterfaceUpdateListener l) { }
    @Override public NetworkInterfaceIterator getInterfaces() throws Exception { throw new UnsupportedOperationException(); }
    @Override public StringIterator systemCertificates() { return null; }
    @Override public io.nekohasekai.libbox.WIFIState readWIFIState() { return null; }
    @Override public void sendNotification(io.nekohasekai.libbox.Notification n) { }
    @Override public io.nekohasekai.libbox.ConnectionOwner findConnectionOwner(int p, String sa, int sp, String da, int dp) throws Exception {
        throw new UnsupportedOperationException("per-app routing не используется");
    }
    @Override public io.nekohasekai.libbox.LocalDNSTransport localDNSTransport() { return null; }
}
