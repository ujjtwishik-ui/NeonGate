# src-tauri/binaries

Сюда кладутся бинарники, которые Tauri упакует в .msi. Они НЕ хранятся в git (см. .gitignore).

Нужные файлы (скрипт `scripts/fetch-windows-deps.ps1` скачает их сам):

| Файл | Откуда |
|------|--------|
| `sing-box-x86_64-pc-windows-msvc.exe` | релиз sing-box (`sing-box-<ver>-windows-amd64.zip` -> `sing-box.exe`), переименовать |
| `wintun.dll` | https://www.wintun.net/ (`wintun-<ver>.zip` -> `wintun/bin/amd64/wintun.dll`) |

Суффикс `-x86_64-pc-windows-msvc` обязателен: Tauri подставляет target triple сам.
Узнать свой triple: `rustc -vV` (строка `host:`).
