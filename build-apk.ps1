# Baut die Debug-APK. Voraussetzung: Werkzeuge in ..\Flugzeug-Lauscher-Tools (Node, JDK 21, Android SDK).
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$tools = Join-Path (Split-Path $root) 'Flugzeug-Lauscher-Tools'
$node  = (Get-ChildItem "$tools\node" -Directory | Select-Object -First 1).FullName
$jdk   = (Get-ChildItem "$tools\jdk21" -Directory | Select-Object -First 1).FullName
$env:JAVA_HOME = $jdk; $env:ANDROID_HOME = "$tools\android-sdk"; $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$node;$jdk\bin;$env:Path"
Set-Location $root

# Web-Dateien nach www kopieren; in der App spricht config.js direkt mit der API (CapacitorHttp umgeht CORS)
Remove-Item www -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory www | Out-Null
foreach ($f in 'index.html','style.css','app.js','data.js','manifest.json') { Copy-Item $f www }
"window.API_BASES = ['https://api.adsb.lol'];" | Set-Content www\config.js -Encoding utf8

if (-not (Test-Path android)) { npx cap add android }
npx cap sync android

# Berechtigungen für Standort ergänzen
$mf = "android\app\src\main\AndroidManifest.xml"
$x = Get-Content $mf -Raw
if ($x -notmatch 'ACCESS_FINE_LOCATION') {
  $perm = '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />' + "`n" +
          '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />' + "`n"
  $x = $x -replace '(<uses-permission android:name="android.permission.INTERNET" />)', ($perm + '$1')
  Set-Content $mf $x -Encoding utf8
}

Set-Location android
.\gradlew.bat assembleDebug
$apk = Resolve-Path app\build\outputs\apk\debug\app-debug.apk
Copy-Item $apk "$root\Flugzeug-Lauscher.apk" -Force
Write-Host "Fertig: $root\Flugzeug-Lauscher.apk"
