/**
 * db.js — слой хранения. Один интерфейс, три адаптера:
 *   1. Tauri (Windows)  -> SQLite через tauri-plugin-sql   (window.__TAURI__.sql)
 *   2. Capacitor (APK)  -> SQLite через @capacitor-community/sqlite
 *   3. Браузер (web)    -> localStorage (демо; SQLite в браузере требует WASM-сборки sql.js)
 *
 * В SQL используем плейсхолдеры "?"; для Tauri они переписываются в $1, $2...
 */
(function (global) {
  'use strict';
  const DB_NAME = 'neongate';

  const DEFAULT_SETTINGS = {
    mode: 'tun', proxy_port: '2080', dns_remote: '1.1.1.1', log_level: 'info',
    bypass_lan: 'true', master_salt: '', master_check: '',
  };

  /* ------------------------- адаптер Tauri ------------------------- */
  async function tauriAdapter() {
    const Database = global.__TAURI__.sql.default || global.__TAURI__.sql;
    // load() применяет миграции, зарегистрированные в main.rs
    const db = await Database.load(`sqlite:${DB_NAME}.db`);
    const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
    return {
      kind: 'sqlite-tauri',
      run: async (sql, args = []) => {
        const r = await db.execute(conv(sql), args);
        return { lastId: r.lastInsertId, changes: r.rowsAffected };
      },
      all: (sql, args = []) => db.select(conv(sql), args),
    };
  }

  /* ----------------------- адаптер Capacitor ----------------------- */
  async function capacitorAdapter() {
    const P = global.Capacitor.Plugins.CapacitorSQLite;
    const database = DB_NAME;
    try {
      await P.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
    } catch (e) { /* соединение уже создано */ }
    await P.open({ database, readonly: false });
    const schema = await (await fetch('db/schema.sql')).text();
    await P.execute({ database, statements: schema, transaction: false, readonly: false });
    return {
      kind: 'sqlite-capacitor',
      run: async (sql, args = []) => {
        const r = await P.run({ database, statement: sql, values: args, transaction: true, readonly: false, returnMode: 'no' });
        return { lastId: r.changes?.lastId, changes: r.changes?.changes };
      },
      all: async (sql, args = []) => (await P.query({ database, statement: sql, values: args, readonly: false })).values || [],
    };
  }

  /* ------------------------ адаптер localStorage ------------------- */
  // Минимальная эмуляция только тех запросов, которые использует приложение (см. API ниже).
  function webAdapter() {
    const KEY = 'neongate.db.v1';
    let s;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* ignore */ }
    s = s || { configs: [], logs: [], settings: { ...DEFAULT_SETTINGS }, seq: 1 };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* quota */ } };
    return { kind: 'localStorage', state: s, save };
  }

  const nowStr = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  /* ============================ публичный API ======================= */
  const NeonDB = {
    adapter: null,
    web: null,

    async init() {
      const P = global.NeonPlatform.kind;
      if (P === 'tauri') this.adapter = await tauriAdapter();
      else if (P === 'android') this.adapter = await capacitorAdapter();
      else { this.web = webAdapter(); this.adapter = { kind: 'localStorage' }; }
      return this.adapter.kind;
    },

    get isWeb() { return !!this.web; },

    /* ---- configs ---- */
    async listConfigs() {
      if (this.isWeb) return [...this.web.state.configs].sort((a, b) => b.id - a.id);
      return this.adapter.all('SELECT * FROM configs ORDER BY id DESC');
    },
    async addConfig(c) {
      if (this.isWeb) {
        const st = this.web.state;
        if (st.configs.some(x => x.uri === c.uri)) return null;
        const row = { id: st.seq++, is_active: st.configs.length ? 0 : 1, created_at: nowStr(), last_used_at: null, ...c };
        st.configs.push(row); this.web.save(); return row.id;
      }
      const exist = await this.adapter.all('SELECT id FROM configs WHERE uri = ?', [c.uri]);
      if (exist.length) return null;
      const hasActive = (await this.adapter.all('SELECT id FROM configs WHERE is_active = 1')).length > 0;
      const r = await this.adapter.run(
        'INSERT INTO configs (name, uri, address, port, security, transport, flow, is_active) VALUES (?,?,?,?,?,?,?,?)',
        [c.name, c.uri, c.address ?? null, c.port ?? null, c.security ?? null, c.transport ?? null, c.flow ?? null, hasActive ? 0 : 1]);
      return r.lastId;
    },
    async updateConfigUri(id, uri, meta) {
      if (this.isWeb) {
        Object.assign(this.web.state.configs.find(x => x.id === id), { uri, ...meta }); this.web.save(); return;
      }
      await this.adapter.run('UPDATE configs SET uri=?, address=?, port=?, security=?, transport=?, flow=? WHERE id=?',
        [uri, meta.address ?? null, meta.port ?? null, meta.security ?? null, meta.transport ?? null, meta.flow ?? null, id]);
    },
    async deleteConfig(id) {
      if (this.isWeb) {
        const st = this.web.state; const was = st.configs.find(x => x.id === id);
        st.configs = st.configs.filter(x => x.id !== id);
        if (was?.is_active && st.configs[0]) st.configs[0].is_active = 1;
        this.web.save(); return;
      }
      const was = (await this.adapter.all('SELECT is_active FROM configs WHERE id=?', [id]))[0];
      await this.adapter.run('DELETE FROM configs WHERE id=?', [id]);
      if (was?.is_active) await this.adapter.run('UPDATE configs SET is_active=1 WHERE id=(SELECT MIN(id) FROM configs)');
    },
    async setActive(id) {
      if (this.isWeb) { this.web.state.configs.forEach(x => { x.is_active = x.id === id ? 1 : 0; }); this.web.save(); return; }
      // сначала снимаем флаг — частичный UNIQUE-индекс не допускает двух активных
      await this.adapter.run('UPDATE configs SET is_active=0 WHERE is_active=1');
      await this.adapter.run('UPDATE configs SET is_active=1 WHERE id=?', [id]);
    },
    async touchConfig(id) {
      if (this.isWeb) { const c = this.web.state.configs.find(x => x.id === id); if (c) { c.last_used_at = nowStr(); this.web.save(); } return; }
      await this.adapter.run("UPDATE configs SET last_used_at=datetime('now') WHERE id=?", [id]);
    },

    /* ---- settings ---- */
    async getSettings() {
      if (this.isWeb) return { ...DEFAULT_SETTINGS, ...this.web.state.settings };
      const rows = await this.adapter.all('SELECT key, value FROM settings');
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async setSetting(key, value) {
      value = String(value);
      if (this.isWeb) { this.web.state.settings[key] = value; this.web.save(); return; }
      await this.adapter.run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [key, value]);
    },

    /* ---- logs ---- */
    async addLog(level, message, configId = null) {
      message = String(message).slice(0, 2000);
      if (this.isWeb) {
        const st = this.web.state;
        st.logs.push({ id: st.seq++, ts: nowStr(), level, message, config_id: configId });
        if (st.logs.length > 1000) st.logs.splice(0, st.logs.length - 1000);
        this.web.save(); return;
      }
      await this.adapter.run('INSERT INTO logs (level, message, config_id) VALUES (?,?,?)', [level, message, configId]);
    },
    async listLogs(limit = 200) {
      if (this.isWeb) return [...this.web.state.logs].reverse().slice(0, limit);
      return this.adapter.all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', [limit]);
    },
    async clearLogs() {
      if (this.isWeb) { this.web.state.logs = []; this.web.save(); return; }
      await this.adapter.run('DELETE FROM logs');
    },
  };

  global.NeonDB = NeonDB;
})(window);
