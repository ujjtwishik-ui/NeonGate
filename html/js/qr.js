/**
 * qr.js — сканирование QR с камеры.
 * Порядок попыток:
 *   1. Нативный ML Kit (@capacitor-mlkit/barcode-scanning) — самый надёжный на Android.
 *   2. BarcodeDetector API + getUserMedia (Chrome/Edge/WebView, где поддерживается).
 *   3. Необязательный fallback: положите jsQR (https://github.com/cozmo/jsQR) в html/vendor/jsQR.js —
 *      он подхватится автоматически, если BarcodeDetector недоступен.
 * Возвращает строку из QR или null, если пользователь отменил.
 */
(function (global) {
  'use strict';

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  async function scanNative() {
    const MK = global.Capacitor?.Plugins?.BarcodeScanner;
    if (!MK) return undefined;                       // нет плагина
    const perm = await MK.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') throw new Error('Нет доступа к камере');
    const { barcodes } = await MK.scan({ formats: ['QR_CODE'] });
    return barcodes && barcodes[0] ? barcodes[0].rawValue : null;
  }

  async function scanWeb(videoEl, signal) {
    let detector = null, jsqr = null;
    if ('BarcodeDetector' in global) {
      detector = new global.BarcodeDetector({ formats: ['qr_code'] });
    } else {
      try { await loadScript('vendor/jsQR.js'); jsqr = global.jsQR; } catch (_) { /* нет файла */ }
    }
    if (!detector && !jsqr) throw new Error('Сканер QR недоступен в этом браузере. Вставьте ключ из буфера обмена.');

    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    try {
      while (!signal.aborted) {
        if (videoEl.readyState >= 2) {
          if (detector) {
            const codes = await detector.detect(videoEl);
            if (codes.length) return codes[0].rawValue;
          } else {
            canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight;
            ctx.drawImage(videoEl, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const r = jsqr(img.data, img.width, img.height);
            if (r) return r.data;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return null;
    } finally {
      stream.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
  }

  global.NeonQR = {
    /** @param {HTMLVideoElement} videoEl @param {AbortSignal} signal */
    async scan(videoEl, signal) {
      const native = await scanNative();
      if (native !== undefined) return native;
      return scanWeb(videoEl, signal);
    },
  };
})(window);
