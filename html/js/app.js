/**
 * app.js — логика интерфейса NeonGate.
 * Зависит от: NeonPlatform, NeonCrypto, NeonVless, NeonDB, NeonQR (подключены раньше).
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const P = window.NeonPlatform, DB = window.NeonDB, V = window.NeonVless, C = window.NeonCrypto;

  const CLASH_PORT = 9090;

  const S = {
    configs: [],          // строки БД, поле uri уже расшифровано (только в памяти)
    settings: {},
    status: 'disconnected',
    key: null,            // CryptoKey мастер-пароля (в памяти)
    connectedAt: 0,
    totalUp: 0, totalDown: 0,
    abort: null,          // AbortController потока статистики
    secret: '',           // секрет clash_api на текущую сессию
    timer: null,
    activeId: null,
  };

  /* ============================ утилиты ============================ */
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${kind === 'error' ? 'error' : ''}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  const fmtBytes = (n) => {
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const fmtTime = (s) => [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

  async function log(level, msg) {
    try { await DB.addLog(level, msg, S.activeId); } catch (_) { /* журнал не должен ломать UI */ }
    if ($('#view-logs').classList.contains('active')) renderLogs();
  }

  /* ============================ навигация ========================== */
  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'logs') renderLogs();
    if (name === 'keys') renderKeys();
  }
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('[data-view-go]').forEach(b => b.addEventListener('click', () => showView(b.dataset.viewGo)));

  /* ============================ статус ============================= */
  const STATUS_TEXT = { disconnected: 'Отключено', connecting: 'Подключение…', connected: 'Подключено', error: 'Ошибка' };

  function setStatus(st, sub) {
    S.status = st;
    document.body.dataset.state = st;
    $('#statusText').textContent = STATUS_TEXT[st];
    $('#powerBtn').setAttribute('aria-label', st === 'connected' || st === 'connecting' ? 'Отключиться' : 'Подключиться');
    const defaults = {
      disconnected: 'Выберите ключ и нажмите кнопку',
      connecting: 'Запускаем ядро…',
      connected: S.settings.mode === 'tun' ? 'Весь трафик идёт через туннель' : `Прокси 127.0.0.1:${S.settings.proxy_port}`,
      error: 'Подробности — в разделе «Логи»',
    };
    $('#statusSub').textContent = sub || defaults[st];
    $$('#modeSeg button').forEach(b => { b.disabled = st === 'connecting' || st === 'connected' || !P.modes.includes(b.dataset.mode); });
  }

  function resetStats() {
    $('#stDown').textContent = '0 Б/с'; $('#stUp').textContent = '0 Б/с';
    $('#stTime').textContent = '00:00:00'; $('#stTotal').textContent = '0 Б';
    S.totalUp = S.totalDown = 0;
  }

  /* ========================= ключи и шифрование ===================== */
  const metaOf = (p, encrypted) => encrypted
    ? { address: null, port: null, security: null, transport: null, flow: null }
    : { address: p.address, port: p.port, security: p.security, transport: p.type, flow: p.flow || null };

  async function loadConfigs() {
    const rows = await DB.listConfigs();
    const out = [];
    for (const r of rows) {
      let uri = r.uri;
      if (C.isEncrypted(uri)) {
        if (!S.key) continue; // пока заблокировано
        try { uri = await C.decrypt(S.key, uri); } catch (_) { continue; }
      }
      let parsed = null;
      try { parsed = V.parseVless(uri); } catch (_) { /* битый ключ покажем без деталей */ }
      out.push({ ...r, uri, parsed });
    }
    S.configs = out;
    const act = out.find(c => c.is_active);
    S.activeId = act ? act.id : null;
  }

  const activeConfig = () => S.configs.find(c => c.is_active) || null;
  const masterOn = () => !!S.settings.master_salt;

  async function importLinks(text) {
    const links = V.extractLinks(text);
    if (!links.length) { toast('В тексте нет ссылок vless://', 'error'); return; }
    let added = 0, dup = 0; const errors = [];
    for (const link of links) {
      try {
        const p = V.parseVless(link);
        if (S.configs.some(c => c.uri === link)) { dup++; continue; }
        const enc = masterOn();
        const stored = enc ? await C.encrypt(S.key, link) : link;
        const id = await DB.addConfig({ name: p.name, uri: stored, ...metaOf(p, enc) });
        if (id === null) dup++; else added++;
      } catch (e) { errors.push(e.message); }
    }
    await loadConfigs(); renderAll();
    if (added) { toast(`Добавлено ключей: ${added}`); log('info', `Импортировано ключей: ${added}`); }
    if (dup) toast(`Уже есть в списке: ${dup}`);
    if (errors.length) { toast(errors[0], 'error'); log('warn', `Ошибки импорта: ${errors.join('; ')}`); }
  }

  /* ============================ рендер ============================= */
  function renderKeys() {
    const ul = $('#keyList'); ul.innerHTML = '';
    $('#keysEmpty').classList.toggle('hidden', S.configs.length > 0);
    for (const c of S.configs) {
      const p = c.parsed;
      const li = document.createElement('li');
      li.className = `card key ${c.is_active ? 'active' : ''}`;
      const sub = p ? `${esc(p.address)}:${p.port}` : 'ключ повреждён';
      const badges = p ? `${p.security === 'reality' ? '<span class="badge">REALITY</span>' : ''}${p.flow ? '<span class="badge">VISION</span>' : ''}` : '';
      li.innerHTML = `<span class="dot"></span>
        <div class="meta"><div class="name">${esc(c.name)}</div><div class="sub">${badges}${sub}</div></div>
        <button class="btn ghost danger" data-del="${c.id}">Удалить</button>`;
      li.querySelector('.meta').addEventListener('click', () => selectConfig(c.id));
      li.querySelector('.dot').addEventListener('click', () => selectConfig(c.id));
      const del = li.querySelector('[data-del]');
      let armed = 0;
      del.addEventListener('click', async () => {      // двойное нажатие вместо confirm()
        if (!armed) { armed = setTimeout(() => { armed = 0; del.textContent = 'Удалить'; }, 3000); del.textContent = 'Точно?'; return; }
        clearTimeout(armed);
        await DB.deleteConfig(c.id); await loadConfigs(); renderAll();
        log('info', `Ключ удалён: ${c.name}`);
      });
      ul.appendChild(li);
    }
  }

  function renderActive() {
    const a = activeConfig();
    $('#activeName').textContent = a ? a.name : '— не выбран —';
  }

  async function renderLogs() {
    const rows = await DB.listLogs(200);
    $('#logList').innerHTML = rows.length
      ? rows.map(r => `<li class="${esc(r.level)}"><time>${esc(String(r.ts).slice(5, 19))}</time>${esc(r.message)}</li>`).join('')
      : '<li>Журнал пуст</li>';
  }

  function renderSettings() {
    const s = S.settings;
    $('#setPort').value = s.proxy_port; $('#setDns').value = s.dns_remote;
    $('#setLog').value = s.log_level; $('#setLan').checked = s.bypass_lan === 'true';
    $('#btnMaster').textContent = masterOn() ? 'Снять мастер-пароль' : 'Установить мастер-пароль';
    $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));
    $('#aboutBox').innerHTML = `Платформа: <b>${P.kind}</b> · Хранилище: <b>${esc(DB.adapter?.kind || '—')}</b>` +
      (DB.isWeb ? '<br>В веб-версии данные лежат в localStorage браузера (не SQLite).' : '');
  }

  function renderAll() { renderKeys(); renderActive(); renderSettings(); }

  async function selectConfig(id) {
    if (S.status === 'connected' || S.status === 'connecting') { toast('Сначала отключитесь', 'error'); return; }
    await DB.setActive(id); await loadConfigs(); renderAll();
  }

  /* ========================= подключение =========================== */
  function buildConfigFor(cfg, mode) {
    const s = S.settings;
    return V.buildSingBoxConfig(cfg.parsed, {
      mode, proxyPort: Number(s.proxy_port), dnsRemote: s.dns_remote, logLevel: s.log_level,
      bypassLan: s.bypass_lan === 'true', platform: P.kind === 'android' ? 'android' : 'windows',
      clashPort: CLASH_PORT, clashSecret: S.secret,
    });
  }

  const clashHeaders = () => ({ Authorization: `Bearer ${S.secret}` });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitForCore(signal) {
    for (let i = 0; i < 40 && !signal.aborted; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CLASH_PORT}/version`, { headers: clashHeaders(), signal });
        if (r.ok) return true;
      } catch (_) { /* ядро ещё поднимается */ }
      await sleep(400);
    }
    return false;
  }

  async function streamTraffic(signal) {
    try {
      const r = await fetch(`http://127.0.0.1:${CLASH_PORT}/traffic`, { headers: clashHeaders(), signal });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const { up, down } = JSON.parse(line);
            S.totalUp += up; S.totalDown += down;
            $('#stUp').textContent = `${fmtBytes(up)}/с`; $('#stDown').textContent = `${fmtBytes(down)}/с`;
            $('#stTotal').textContent = fmtBytes(S.totalUp + S.totalDown);
          } catch (_) { /* неполная строка */ }
        }
      }
    } catch (_) { /* отмена или разрыв — статус обновит onExit */ }
  }

  async function connect() {
    const cfg = activeConfig();
    if (!cfg) { toast('Сначала добавьте и выберите ключ', 'error'); showView('keys'); return; }
    if (!cfg.parsed) { toast('Выбранный ключ повреждён', 'error'); return; }
    if (!P.canConnect) { toast('Веб-версия не может подключаться — используйте приложение', 'error'); return; }

    const mode = S.settings.mode;
    S.secret = randomSecret();
    S.abort = new AbortController();
    resetStats();
    setStatus('connecting');
    log('info', `Подключение: ${cfg.name} (${mode === 'tun' ? 'TUN' : 'системный прокси'})`);

    try {
      await P.start(JSON.stringify(buildConfigFor(cfg, mode)), { mode, proxyPort: S.settings.proxy_port });
      const ok = await waitForCore(S.abort.signal);
      if (S.abort.signal.aborted) return;           // пользователь отменил
      if (!ok) throw new Error('Ядро не ответило за 16 секунд. Проверьте ключ и логи.');
      S.connectedAt = Date.now();
      S.timer = setInterval(() => { $('#stTime').textContent = fmtTime((Date.now() - S.connectedAt) / 1000 | 0); }, 1000);
      setStatus('connected');
      DB.touchConfig(cfg.id);
      log('info', 'Подключено');
      streamTraffic(S.abort.signal);
    } catch (e) {
      await teardown();
      setStatus('error', String(e.message || e));
      log('error', `Ошибка подключения: ${e.message || e}`);
      toast(String(e.message || e), 'error');
    }
  }

  async function teardown() {
    if (S.abort) S.abort.abort();
    clearInterval(S.timer); S.timer = null;
    try { await P.stop(); } catch (e) { log('warn', `Остановка: ${e.message || e}`); }
  }

  async function disconnect() {
    await teardown();
    setStatus('disconnected');
    log('info', 'Отключено пользователем');
    resetStats();
  }

  $('#powerBtn').addEventListener('click', () => {
    if (S.status === 'connected' || S.status === 'connecting') disconnect(); else connect();
  });

  // ядро завершилось само (падение, остановка из трея, нет прав и т.п.)
  P.onExit(async (reason) => {
    if (S.status === 'disconnected') return;
    const wasConnected = S.status === 'connected' || S.status === 'connecting';
    await teardown();
    if (wasConnected) {
      setStatus('error', 'Ядро sing-box остановилось');
      log('error', `Ядро остановилось ${reason ? `(${reason})` : ''}`);
    }
  });

  // строки лога от ядра (без секретов — sing-box не печатает ключи; режем на всякий случай uuid/pbk)
  P.onLog((line) => {
    const clean = String(line).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '«uuid»');
    const level = /\b(ERROR|FATAL|PANIC)\b/.test(clean) ? 'error' : /\bWARN/.test(clean) ? 'warn' : 'debug';
    if (level !== 'debug') log(level, clean);
  });

  /* ============================= режимы ============================ */
  $$('#modeSeg button').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    await DB.setSetting('mode', b.dataset.mode); S.settings.mode = b.dataset.mode; renderSettings();
  }));

  /* ============================ импорт ============================= */
  $('#btnPaste').addEventListener('click', async () => {
    const text = await P.readClipboard();
    if (text === null) { $('#dlgManual').showModal(); toast('Нет доступа к буферу — вставьте ключ вручную', 'error'); return; }
    await importLinks(text);
  });

  $('#btnManual').addEventListener('click', () => { $('#manualText').value = ''; $('#dlgManual').showModal(); });
  $('#dlgManual').addEventListener('close', async () => {
    if ($('#dlgManual').returnValue === 'ok') await importLinks($('#manualText').value);
    $('#manualText').value = '';
  });

  $('#btnFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await importLinks(await f.text());
  });

  $('#btnScan').addEventListener('click', async () => {
    const dlg = $('#dlgQr'); const ac = new AbortController();
    $('#qrCancel').onclick = () => { ac.abort(); dlg.close(); };
    dlg.addEventListener('cancel', () => ac.abort(), { once: true });
    dlg.showModal();
    try {
      const text = await NeonQR.scan($('#qrVideo'), ac.signal);
      if (dlg.open) dlg.close();
      if (text) await importLinks(text);
    } catch (e) {
      if (dlg.open) dlg.close();
      toast(String(e.message || e), 'error');
    }
  });

  $('#btnExport').addEventListener('click', () => {
    const cfg = activeConfig();
    if (!cfg || !cfg.parsed) { toast('Нет выбранного ключа', 'error'); return; }
    S.secret = randomSecret();
    P.downloadText('neongate-singbox.json', JSON.stringify(buildConfigFor(cfg, S.settings.mode), null, 2));
    toast('Файл содержит данные вашего ключа — не публикуйте его');
  });

  /* ============================= логи ============================== */
  $('#btnClearLogs').addEventListener('click', async () => { await DB.clearLogs(); renderLogs(); });

  /* =========================== настройки =========================== */
  $('#btnSaveSettings').addEventListener('click', async () => {
    const port = Number($('#setPort').value);
    if (!(port >= 1024 && port <= 65535) || port === CLASH_PORT) { toast('Порт: 1024–65535, кроме 9090', 'error'); return; }
    const dns = $('#setDns').value.trim();
    if (!/^[\w.:-]+$/.test(dns)) { toast('Некорректный DNS-адрес', 'error'); return; }
    await DB.setSetting('proxy_port', port); await DB.setSetting('dns_remote', dns);
    await DB.setSetting('log_level', $('#setLog').value); await DB.setSetting('bypass_lan', $('#setLan').checked);
    S.settings = await DB.getSettings(); toast('Сохранено');
  });

  /* ========================= мастер-пароль ========================= */
  function askPassword({ title, hint, confirm = false, allowReset = false, allowCancel = true }) {
    return new Promise((resolve) => {
      const dlg = $('#dlgPass'), form = $('#passForm'), inp = $('#passInput'), inp2 = $('#passInput2'), err = $('#passErr');
      $('#passTitle').textContent = title; $('#passHint').textContent = hint || '';
      inp.value = inp2.value = ''; err.textContent = '';
      inp2.classList.toggle('hidden', !confirm);
      $('#passReset').classList.toggle('hidden', !allowReset);
      $('#passCancel').classList.toggle('hidden', !allowCancel);
      const done = (v) => { form.onsubmit = null; dlg.close(); resolve(v); };
      form.onsubmit = (e) => {
        e.preventDefault();
        if (confirm && inp.value !== inp2.value) { err.textContent = 'Пароли не совпадают'; return; }
        if (inp.value.length < 8) { err.textContent = 'Минимум 8 символов'; return; }
        done({ password: inp.value, setError: (m) => { err.textContent = m; dlg.showModal(); } });
      };
      $('#passCancel').onclick = () => done(null);
      $('#passReset').onclick = () => done('reset');
      dlg.oncancel = (e) => { if (!allowCancel) e.preventDefault(); else done(null); };
      if (!dlg.open) dlg.showModal();
      inp.focus();
    });
  }

  async function unlockFlow() {
    // повторяем, пока пароль не подойдёт либо пользователь не сбросит хранилище
    for (;;) {
      const r = await askPassword({ title: 'Разблокировка', hint: 'Введите мастер-пароль, чтобы открыть ключи.', allowReset: true, allowCancel: false });
      if (r === 'reset') {
        for (const c of await DB.listConfigs()) await DB.deleteConfig(c.id);
        await DB.setSetting('master_salt', ''); await DB.setSetting('master_check', '');
        S.settings = await DB.getSettings(); S.key = null;
        toast('Хранилище сброшено'); return;
      }
      const key = await C.deriveKey(r.password, S.settings.master_salt);
      if (await C.verify(key, S.settings.master_check)) { S.key = key; return; }
      toast('Неверный пароль', 'error');
    }
  }

  $('#btnMaster').addEventListener('click', async () => {
    if (S.status === 'connected' || S.status === 'connecting') { toast('Сначала отключитесь', 'error'); return; }
    if (!masterOn()) {
      const r = await askPassword({ title: 'Новый мастер-пароль', hint: 'Ключи будут зашифрованы. Восстановить пароль невозможно.', confirm: true });
      if (!r) return;
      const salt = C.newSalt(); const key = await C.deriveKey(r.password, salt);
      for (const c of S.configs) await DB.updateConfigUri(c.id, await C.encrypt(key, c.uri), metaOf(null, true));
      await DB.setSetting('master_salt', salt); await DB.setSetting('master_check', await C.makeCheck(key));
      S.key = key; toast('Мастер-пароль установлен'); log('info', 'Мастер-пароль включён');
    } else {
      const r = await askPassword({ title: 'Снять мастер-пароль', hint: 'Подтвердите текущий пароль. Ключи снова будут храниться открыто.' });
      if (!r) return;
      const key = await C.deriveKey(r.password, S.settings.master_salt);
      if (!(await C.verify(key, S.settings.master_check))) { toast('Неверный пароль', 'error'); return; }
      for (const c of S.configs) await DB.updateConfigUri(c.id, c.uri, c.parsed ? metaOf(c.parsed, false) : {});
      await DB.setSetting('master_salt', ''); await DB.setSetting('master_check', '');
      S.key = null; toast('Мастер-пароль снят'); log('info', 'Мастер-пароль выключен');
    }
    S.settings = await DB.getSettings(); await loadConfigs(); renderAll();
  });

  /* ============================== старт ============================ */
  (async function init() {
    try {
      await DB.init();
      S.settings = await DB.getSettings();
      if (masterOn()) await unlockFlow();
      await loadConfigs();
      renderAll();
      $('#webNote').classList.toggle('hidden', P.canConnect);
      setStatus('disconnected');
      log('info', `NeonGate запущен (${P.kind}, ${DB.adapter.kind})`);
    } catch (e) {
      console.error(e);
      setStatus('error', 'Не удалось открыть хранилище');
      toast(`Ошибка инициализации: ${e.message || e}`, 'error');
    }
  })();

  // Браузер/WebView закрывается — гасим ядро и системный прокси
  window.addEventListener('beforeunload', () => { if (S.status !== 'disconnected') P.stop().catch(() => {}); });
})();
