// build.rs — встраивает манифест Windows с requestedExecutionLevel=requireAdministrator.
// Благодаря этому приложение при запуске показывает UAC-запрос, а дочерний процесс
// sing-box.exe (sidecar) наследует права администратора и может создавать Wintun-адаптер
// и менять таблицу маршрутизации.
fn main() {
    #[cfg(windows)]
    {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("app.manifest"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
    }
    #[cfg(not(windows))]
    tauri_build::build();
}
