/**
 * crypto.js — опциональный мастер-пароль.
 * PBKDF2-SHA256 (310 000 итераций) -> AES-256-GCM (WebCrypto).
 * Ключ живёт только в памяти; в БД лежат соль и шифртекст контрольной строки.
 * Формат шифртекста: "enc:v1:<iv_b64>:<ct_b64>".
 */
(function (global) {
  'use strict';
  const PREFIX = 'enc:v1:';
  const CHECK = 'neongate-ok';
  const ITER = 310000;
  const te = new TextEncoder(), td = new TextDecoder();

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  function newSalt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }

  async function deriveKey(password, saltB64) {
    const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: ITER },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encrypt(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
    return `${PREFIX}${b64(iv)}:${b64(ct)}`;
  }

  async function decrypt(key, payload) {
    if (!isEncrypted(payload)) return payload;
    const [iv, ct] = payload.slice(PREFIX.length).split(':');
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return td.decode(buf);
  }

  const isEncrypted = (s) => typeof s === 'string' && s.startsWith(PREFIX);

  async function makeCheck(key) { return encrypt(key, CHECK); }
  async function verify(key, check) {
    try { return (await decrypt(key, check)) === CHECK; } catch (_) { return false; }
  }

  global.NeonCrypto = { newSalt, deriveKey, encrypt, decrypt, isEncrypted, makeCheck, verify };
})(window);
