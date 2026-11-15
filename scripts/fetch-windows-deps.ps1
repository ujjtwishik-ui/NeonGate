<#
  Скачивает sing-box.exe и wintun.dll в src-tauri\binaries.
  Запуск (PowerShell, из корня проекта):
      powershell -ExecutionPolicy Bypass -File scripts\fetch-windows-deps.ps1
  Версию sing-box можно задать параметром: -SingBoxVersion 1.12.0
  Актуальные версии: https://github.com/SagerNet/sing-box/releases и https://www.wintun.net/
#>
param(
  [string]$SingBoxVersion = "",
  [string]$WintunVersion  = "0.14.1"
)
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force $dest | Out-Null
$tmp = Join-Path $env:TEMP ("neongate-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- sing-box ---
if (-not $SingBoxVersion) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/SagerNet/sing-box/releases/latest"
  $SingBoxVersion = $rel.tag_name.TrimStart("v")
}
Write-Host "sing-box $SingBoxVersion"
$zip = Join-Path $tmp "sb.zip"
Invoke-WebRequest "https://github.com/SagerNet/sing-box/releases/download/v$SingBoxVersion/sing-box-$SingBoxVersion-windows-amd64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $tmp -Force
$exe = Get-ChildItem $tmp -Recurse -Filter sing-box.exe | Select-Object -First 1
Copy-Item $exe.FullName (Join-Path $dest "sing-box-x86_64-pc-windows-msvc.exe") -Force

# --- wintun ---
Write-Host "wintun $WintunVersion"
$wz = Join-Path $tmp "wintun.zip"
Invoke-WebRequest "https://www.wintun.net/builds/wintun-$WintunVersion.zip" -OutFile $wz
Expand-Archive $wz -DestinationPath (Join-Path $tmp "wt") -Force
Copy-Item (Join-Path $tmp "wt\wintun\bin\amd64\wintun.dll") (Join-Path $dest "wintun.dll") -Force

Remove-Item $tmp -Recurse -Force
Write-Host "Готово: $dest"
Get-ChildItem $dest | Format-Table Name, Length
