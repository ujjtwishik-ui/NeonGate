//! NeonGate (Tauri v2): управление ядром sing-box и системным прокси.
//!
//! Команды, доступные фронтенду через `window.__TAURI__.core.invoke`:
//!   start_core(config)            — пишет config.json и запускает sidecar `sing-box run`
//!   stop_core()                   — останавливает ядро
//!   set_system_proxy(host, port)  — включает системный прокси Windows
//!   clear_system_proxy()          — выключает системный прокси
//! События: `core-log` (строка вывода ядра), `core-exit` (код/причина завершения).

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Процесс ядра. Mutex — команды Tauri могут вызываться из разных потоков.
#[derive(Default)]
struct Core(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn start_core(app: AppHandle, state: State<'_, Core>, config: String) -> Result<(), String> {
    // Не запускаем второй экземпляр.
    if state.0.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("Ядро уже запущено".into());
    }

    // Валидируем JSON до записи на диск.
    serde_json::from_str::<serde_json::Value>(&config).map_err(|e| format!("Некорректный конфиг: {e}"))?;

    // Рабочий каталог ядра: %APPDATA%\app.neongate.client\core
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("core");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg_path = dir.join("config.json");
    std::fs::write(&cfg_path, config).map_err(|e| e.to_string())?;

    // Sidecar: binaries/sing-box-<target-triple>.exe, собирается в каталог установки.
    // Права администратора наследуются от самого приложения (см. app.manifest).
    let (mut rx, child) = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| e.to_string())?
        .args([
            "run",
            "-c", &cfg_path.to_string_lossy(),
            "-D", &dir.to_string_lossy(),
        ])
        .spawn()
        .map_err(|e| format!("Не удалось запустить sing-box: {e}"))?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(child);

    // Пересылаем вывод ядра во фронтенд и ловим завершение процесса.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => {
                    let _ = handle.emit("core-log", String::from_utf8_lossy(&l).trim_end().to_string());
                }
                CommandEvent::Error(e) => {
                    let _ = handle.emit("core-log", format!("ERROR {e}"));
                }
                CommandEvent::Terminated(p) => {
                    if let Some(st) = handle.try_state::<Core>() {
                        if let Ok(mut g) = st.0.lock() { *g = None; }
                    }
                    let _ = handle.emit("core-exit", format!("код {:?}", p.code));
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_core(state: State<'_, Core>) -> Result<(), String> {
    if let Some(child) = state.0.lock().map_err(|e| e.to_string())?.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Системный прокси Windows (HKCU\...\Internet Settings). Права администратора не нужны.
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod sysproxy {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> Result<(), String> {
        let out = Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }

    fn notify() {
        // Сообщаем WinINET, что настройки изменились (иначе браузеры подхватят не сразу).
        unsafe {
            InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null(), 0);
            InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null(), 0);
        }
    }

    pub fn set(host: &str, port: u16) -> Result<(), String> {
        let server = format!("{host}:{port}");
        reg(&["add", KEY, "/v", "ProxyServer", "/t", "REG_SZ", "/d", &server, "/f"])?;
        reg(&["add", KEY, "/v", "ProxyOverride", "/t", "REG_SZ", "/d", "localhost;127.*;10.*;192.168.*;<local>", "/f"])?;
        reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"])?;
        notify();
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        reg(&["add", KEY, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"])?;
        notify();
        Ok(())
    }
}

#[cfg(not(windows))]
mod sysproxy {
    pub fn set(_h: &str, _p: u16) -> Result<(), String> { Err("Системный прокси поддержан только в Windows".into()) }
    pub fn clear() -> Result<(), String> { Ok(()) }
}

#[tauri::command]
fn set_system_proxy(host: String, port: u16) -> Result<(), String> {
    // Только loopback и разумный диапазон портов — защита от подмены из webview.
    if host != "127.0.0.1" || port < 1024 { return Err("Недопустимый адрес прокси".into()); }
    sysproxy::set(&host, port)
}

#[tauri::command]
fn clear_system_proxy() -> Result<(), String> { sysproxy::clear() }

pub fn run() {
    // Схема БД лежит в html/db/schema.sql — единый источник для всех платформ.
    let migrations = vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../../html/db/schema.sql"),
        kind: MigrationKind::Up,
    }];

    let app = tauri::Builder::default()
        .manage(Core::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:neongate.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![start_core, stop_core, set_system_proxy, clear_system_proxy])
        .build(tauri::generate_context!())
        .expect("ошибка сборки приложения");

    app.run(|handle, event| {
        // При выходе обязательно гасим ядро и снимаем системный прокси,
        // иначе у пользователя «пропадёт интернет».
        if let RunEvent::Exit = event {
            if let Some(st) = handle.try_state::<Core>() {
                if let Ok(mut g) = st.0.lock() {
                    if let Some(child) = g.take() { let _ = child.kill(); }
                }
            }
            let _ = sysproxy::clear();
        }
    });
}
