# NeonGate — VLESS (XTLS-Reality + Vision) клиент на sing-box

Один фронтенд (`html/`, чистые HTML/CSS/JS) и три способа доставки:

| Платформа | Обёртка | Что умеет |
|-----------|---------|-----------|
| Web (Render) | статика / Express | импорт и хранение ключей, экспорт конфига sing-box. **VPN-соединение создать не может** (ограничение браузера) |
| Windows `.msi` | Tauri v2 + WebView2 | TUN (Wintun) и системный прокси, sidecar `sing-box.exe` |
| Android `.apk` | Capacitor + нативный плагин | TUN через `VpnService` + libbox (sing-box как библиотека) |

## 0. Что проверено, а что нет

Проверено в песочнице: парсер `vless://` и генератор конфига (`npm test`), синтаксис всех JS, валидность JSON-конфигов, SQL-схема (единственный активный ключ, ротация логов).

**Не собиралось и не запускалось** (в песочнице нет Rust, Android SDK, Windows): Tauri-часть, Android-плагин, UI в реальном WebView. Ожидайте мелких правок при первой сборке. Самое хрупкое место — `NeonVpnService.java`: интерфейс `PlatformInterface` в libbox меняется от версии к версии (см. раздел 4).

## 1. Структура проекта

```
NeonGate/
├── README.md
├── package.json              # скрипты: start, test, icons, tauri:*, cap:*
├── server.js                 # Express: раздаёт html/ (+ заголовки безопасности, шаблон requireRole)
├── render.yaml               # Blueprint для Render
├── capacitor.config.json
├── html/                     # ВЕСЬ фронтенд (автономная папка)
│   ├── index.html
│   ├── css/style.css         # чёрный #0a0a0a + лайм-градиент #ccff00 ⇄ #66ff00, неоновое свечение
│   ├── assets/icon.svg
│   ├── db/schema.sql         # SQLite-схема (configs, settings, logs) — единый источник
│   └── js/
│       ├── vless.js          # парсер vless:// и генератор конфига sing-box (outbound + TUN/mixed inbound)
│       ├── db.js             # слой хранения: Tauri-SQLite / Capacitor-SQLite / localStorage (web)
│       ├── crypto.js         # необязательный мастер-пароль (PBKDF2 → AES-256-GCM)
│       ├── platform.js       # единый API: start/stop ядра, события, буфер обмена
│       ├── qr.js             # сканер QR (ML Kit / BarcodeDetector / jsQR)
│       └── app.js            # UI: подключение, статистика, ключи, логи, настройки
├── scripts/
│   ├── test-vless.js         # тест парсера (фиктивные данные)
│   └── fetch-windows-deps.ps1# скачивает sing-box.exe и wintun.dll
├── src-tauri/                # Windows
│   ├── Cargo.toml
│   ├── build.rs              # встраивает манифест requireAdministrator
│   ├── app.manifest
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── binaries/             # sing-box-x86_64-pc-windows-msvc.exe, wintun.dll (кладёте сами)
│   └── src/{main.rs, lib.rs} # sidecar, системный прокси, миграция SQLite
└── android-overlay/          # файлы, которые копируются в android/ после `cap add android`
    ├── AndroidManifest.snippet.xml
    ├── res/xml/network_security_config.xml
    └── java/app/neongate/client/{MainActivity,NeonVpnPlugin,NeonVpnService}.java
```

## 2. Что нужно поставить локально

| Для чего | Инструмент |
|----------|-----------|
| всё | **Node.js ≥ 22**, Git |
| `.msi` | **Rust** (stable, target `x86_64-pc-windows-msvc`), **Visual Studio Build Tools** (workload «Разработка классических приложений на C++»), **WebView2 Runtime** (есть в Windows 11), WiX подтянется Tauri автоматически (нужен Windows) |
| `.apk` | **Android Studio** (SDK + JDK 21), для сборки libbox: **Go**, **Android NDK**, `gomobile` |
| TUN на Windows | `wintun.dll` (https://www.wintun.net/) и `sing-box.exe` — скрипт `fetch-windows-deps.ps1` скачает оба |

> Сборка `.msi` возможна только на Windows. APK можно собирать на любой ОС.

## 3. Веб-версия на Render

1. Залейте проект в GitHub (ключи в репозиторий не коммитить — их там и нет).
2. Render → **New → Blueprint** → выберите репозиторий. Подхватится `render.yaml` (статический сайт из `html/`).
   Либо вручную: **New → Static Site**, *Publish directory* = `html`, *Build command* пустой.
3. Если нужен Express (`server.js`, заголовки CSP): **New → Web Service**, Runtime Node, Build `npm install --omit=dev`, Start `npm start`, Health check `/healthz`.
4. Локально: `npm install && npm start` → http://localhost:3000.

В веб-версии кнопка «Подключиться» не работает — это сделано намеренно и показано в интерфейсе.

## 4. Windows `.msi` (Tauri v2 + Wintun)

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-windows-deps.ps1   # sing-box + wintun -> src-tauri\binaries
npm run icons                                                             # иконки из html/assets/icon.svg -> src-tauri/icons
npm run tauri:dev      # отладка: запускайте терминал ОТ ИМЕНИ АДМИНИСТРАТОРА
npm run tauri:build    # итог: src-tauri\target\release\bundle\msi\NeonGate_0.1.0_x64_ru-RU.msi
```

Как это устроено:
- `app.manifest` + `build.rs` → `requireAdministrator`: при запуске UAC, а дочерний `sing-box.exe` (sidecar `externalBin`) наследует права и может создать Wintun-адаптер и маршруты.
- `wintun.dll` кладётся как ресурс в корень каталога установки — рядом с `sing-box.exe`, где ядро его ищет.
- Режим «Системный прокси» пишет `HKCU\...\Internet Settings` и уведомляет WinINET; при выходе из приложения прокси снимается автоматически.
- Компромисс: админ-права требуются приложению целиком, даже в режиме прокси. Альтернатива (запуск только ядра через отдельный elevated-сервис) сложнее и здесь не реализована.
- Установщик не подписан → SmartScreen покажет предупреждение. Для распространения нужен сертификат подписи кода.

## 5. Android `.apk` (Capacitor + VpnService + libbox)

**Шаг 1. Собрать `libbox.aar` (ядро sing-box как библиотека).**
```bash
git clone https://github.com/SagerNet/sing-box && cd sing-box
git checkout v<версия>              # подберите версию, под которую пишете PlatformInterface (1.12.x в этом проекте)
go install github.com/sagernet/gomobile/cmd/gomobile@latest && gomobile init   # см. актуальную инструкцию в docs sing-box
make lib_android                    # даёт libbox.aar; в тегах сборки должен быть with_clash_api (статистика)
```
(Подробности — раздел *Build from source → Android* в документации sing-box.)

**Шаг 2. Создать Android-проект.**
```bash
npm install
npx cap add android
npx cap sync android
```

**Шаг 3. Применить overlay** (из корня проекта; Windows — `xcopy`/Проводник):
```bash
cp android-overlay/java/app/neongate/client/*.java android/app/src/main/java/app/neongate/client/   # перезапишет MainActivity
mkdir -p android/app/src/main/res/xml && cp android-overlay/res/xml/network_security_config.xml android/app/src/main/res/xml/
mkdir -p android/app/libs && cp /путь/к/libbox.aar android/app/libs/
```
Затем:
- вставьте содержимое `android-overlay/AndroidManifest.snippet.xml` в `android/app/src/main/AndroidManifest.xml` (разрешения, `networkSecurityConfig`, `<service>`);
- в `android/app/build.gradle` в блок `dependencies` добавьте `implementation fileTree(dir: 'libs', include: ['*.jar', '*.aar'])`.

**Шаг 4. Собрать.** `npx cap open android` → Android Studio → *Build → Build APK(s)* (отладочный). Для релиза: *Build → Generate Signed Bundle / APK* со своим keystore (в git не класть).

Если Gradle/компилятор ругается на `NeonVpnService` («does not override abstract method…»), версии libbox и интерфейса разошлись: добавьте недостающие методы по `PlatformInterfaceWrapper` из `sing-box-for-android` той же версии. Мониторинг смены сети (Wi-Fi ⇄ LTE) в проекте — заглушка; для продакшена реализуйте `DefaultNetworkMonitor`.

Сканирование QR на Android идёт через `@capacitor-mlkit/barcode-scanning` (уже в `package.json`). Хранилище — `@capacitor-community/sqlite`.

## 6. Безопасность

- В коде и тестах нет реальных ключей; только фиктивные данные. Ключи хранятся локально (SQLite), на сервер ничего не уходит.
- Мастер-пароль (Настройки): ключи в БД шифруются AES-256-GCM, ключ выводится PBKDF2 (310 000 итераций) и живёт только в памяти. Забытый пароль восстановить нельзя.
- API статистики ядра слушает только `127.0.0.1:9090` и защищён случайным секретом на сессию.
- Лог ядра очищается от UUID перед записью в журнал; `config.json` с ключом лежит только в каталоге данных приложения.
- Админ-эндпоинтов нет; в `server.js` оставлен шаблон `requireRole()` на случай их появления.
- Экспортированный `neongate-singbox.json` содержит ваш ключ — не публикуйте его.

## 7. Лицензия и юридическое

sing-box распространяется по **GPL-3.0** (с дополнительным условием об именовании). Если вы раздаёте приложение со встроенным sing-box/libbox, нужно соблюдать условия GPL (предоставить исходный код своей части). Wintun — отдельная лицензия, см. wintun.net. Используйте VPN в соответствии с законодательством вашей страны.

## 8. Известные ограничения

- Веб-версия хранит данные в `localStorage`, а не в SQLite (SQLite в браузере требует WASM-сборки sql.js).
- Нет подписок (subscription URL), маршрутизации по странам/приложениям, автозапуска, трея.
- Версии зависимостей в `package.json` для Capacitor-плагинов — `latest`; после первой успешной установки зафиксируйте их.
- Минимальная версия sing-box — 1.12 (формат DNS-серверов и rule actions в `vless.js`).
