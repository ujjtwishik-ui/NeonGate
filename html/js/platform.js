/**
 * platform.js — единая обёртка над нативными возможностями.
 *   tauri   -> Rust-команды (запуск sing-box sidecar, системный прокси)
 *   android -> Capacitor-плагин NeonVpn (VpnService + libbox)
 *   web     -> нативных возможностей нет: только импорт ключей и экспорт конфига
 */
(function (global) {
  'use strict';

  const isTauri = !!(global.__TAURI__ && global.__TAURI__.core);
  const cap = global.Capacitor;
  const isAndroid = !!(cap && cap.getPlatform && cap.getPlatform() === 'android');
  const kind = isTauri ? 'tauri' : isAndroid ? 'android' : 'web';

  const logSubs = new Set();
  const exitSubs = new Set();

  const NeonPlatform = {
    kind,
    /** есть ли у платформы настоящее VPN-ядро */
    get canConnect() { return kind !== 'web'; },
    /** какие режимы доступны */
    get modes() { return kind === 'android' ? ['tun'] : ['tun', 'proxy']; },

    onLog(cb) { logSubs.add(cb); return () => logSubs.delete(cb); },
    onExit(cb) { exitSubs.add(cb); return () => exitSubs.delete(cb); },

    /**
     * Запускает ядро.
     * @param {string} configJson  готовый конфиг sing-box
     * @param {{mode:string, proxyPort:number}} o
     */
    async start(configJson, o) {
      if (kind === 'tauri') {
        await global.__TAURI__.core.invoke('start_core', { config: configJson });
        if (o.mode === 'proxy') {
          await global.__TAURI__.core.invoke('set_system_proxy', { host: '127.0.0.1', port: Number(o.proxyPort) });
        }
      } else if (kind === 'android') {
        // Android может показать системный диалог «Подключение VPN» — ждём ответа пользователя.
        await cap.Plugins.NeonVpn.start({ config: configJson });
      } else {
        throw new Error('Веб-версия не может создавать VPN-соединение. Установите приложение для Windows или Android.');
      }
    },

    async stop(o = {}) {
      if (kind === 'tauri') {
        await global.__TAURI__.core.invoke('clear_system_proxy').catch(() => {});
        await global.__TAURI__.core.invoke('stop_core');
      } else if (kind === 'android') {
        await cap.Plugins.NeonVpn.stop();
      }
    },

    async copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
    },
    async readClipboard() {
      try { return await navigator.clipboard.readText(); } catch (_) { return null; }
    },

    /** Сохраняет текст как файл (web/Tauri webview: через скачивание). */
    downloadText(filename, text) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };

  // Подписки на события ядра
  if (kind === 'tauri') {
    global.__TAURI__.event.listen('core-log', (e) => logSubs.forEach(cb => cb(String(e.payload))));
    global.__TAURI__.event.listen('core-exit', (e) => exitSubs.forEach(cb => cb(e.payload)));
  } else if (kind === 'android') {
    cap.Plugins.NeonVpn.addListener('log', (e) => logSubs.forEach(cb => cb(String(e.message))));
    cap.Plugins.NeonVpn.addListener('exit', (e) => exitSubs.forEach(cb => cb(e.reason || '')));
  }

  global.NeonPlatform = NeonPlatform;
})(window);
