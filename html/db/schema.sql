-- NeonGate: локальная схема SQLite.
-- Единственный источник истины: этот файл читают
--   * Tauri (src-tauri/src/main.rs, include_str! -> миграция tauri-plugin-sql)
--   * Capacitor/Android (js/db.js делает fetch('db/schema.sql'))
-- Все операторы идемпотентны (IF NOT EXISTS / OR IGNORE).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- configs: сохранённые ключи (vless://)
-- uri хранится открытым текстом ИЛИ как "enc:v1:<iv>:<ciphertext>" (AES-GCM),
-- если пользователь включил мастер-пароль. В зашифрованном режиме
-- address/port/... остаются NULL, чтобы не светить сервер в файле БД.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS configs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  uri          TEXT    NOT NULL UNIQUE,
  address      TEXT,
  port         INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  security     TEXT,                       -- none | tls | reality
  transport    TEXT,                       -- tcp | ws | grpc | ...
  flow         TEXT,                       -- xtls-rprx-vision | ''
  is_active    INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- Не более одного активного ключа.
CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_single_active
  ON configs (is_active) WHERE is_active = 1;

-- ---------------------------------------------------------------
-- settings: key/value
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('mode',        'tun'),                 -- tun | proxy
  ('proxy_port',  '2080'),                -- порт mixed (SOCKS5+HTTP) в режиме proxy
  ('dns_remote',  '1.1.1.1'),             -- DoH-сервер, идёт через туннель
  ('log_level',   'info'),                -- trace|debug|info|warn|error
  ('bypass_lan',  'true'),                -- локальные адреса мимо туннеля
  ('master_salt', ''),                    -- пусто = мастер-пароль выключен
  ('master_check','');                    -- шифртекст контрольной строки

-- ---------------------------------------------------------------
-- logs: журнал подключений и событий ядра
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL DEFAULT (datetime('now')),
  level     TEXT    NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message   TEXT    NOT NULL,
  config_id INTEGER REFERENCES configs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);

-- Ротация: хранить не более 1000 последних записей.
CREATE TRIGGER IF NOT EXISTS trg_logs_rotate
AFTER INSERT ON logs
BEGIN
  DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - 1000;
END;
