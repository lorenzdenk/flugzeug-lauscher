# Flugzeug-Lauscher

Zeigt, welches Flugzeug du gerade über dir hörst – nur Flüge von/nach Zürich (ZRH).

- **Landekonzept ZRH** (Nord / Ost / Süd) – aus dem Live-Verkehr der letzten 30 min abgeleitet
- **Liste** nach 3D-Distanz (inkl. Höhe), mit Typ, Airline, Herkunft/Ziel; das nächste Flugzeug ist aufgeklappt
- **Kompass-Radar** (Blickrichtung oben) oder **Karte** (OpenStreetMap)
- Design im Frutiger-Aero-Stil

Daten: [adsb.lol](https://adsb.lol) (Positionen, Routen), [hexdb.io](https://hexdb.io) (Typ/Betreiber),
[Open-Meteo](https://open-meteo.com) (Geländehöhe), [BigDataCloud](https://www.bigdatacloud.com) (Gemeindename),
Kartenkacheln © OpenStreetMap-Mitwirkende.

## Web-Version lokal starten

```
python server.py
```

Dann http://localhost:8765 öffnen. `server.py` reicht `/adsb/*` an adsb.lol weiter (die API sendet keine CORS-Header).
Testen mit festem Standort: `http://localhost:8765/?lat=47.4581&lon=8.5555`.

## Android-APK bauen (Capacitor)

Voraussetzungen: Node.js, JDK 21, Android SDK (Plattform 35). Dann in PowerShell:

```
npm install
powershell -ExecutionPolicy Bypass -File build-apk.ps1
```

`build-apk.ps1` erwartet die Werkzeuge im Nachbarordner `Flugzeug-Lauscher-Tools` (`node`, `jdk21`, `android-sdk`) –
Pfade am Skriptanfang bei Bedarf anpassen. Ergebnis: `Flugzeug-Lauscher.apk` (Debug-Signatur).

## App-Symbol neu erzeugen

`icon/make-icons.mjs` erzeugt Symbol und alle Android-Grössen (benötigt das npm-Paket `sharp`).
