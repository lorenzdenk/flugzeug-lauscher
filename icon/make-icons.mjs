// Erzeugt das App-Symbol (Flugzeug mit Schallwellen, Frutiger Aero) als SVG + alle PNG-Grössen.
// Aufruf:  node icon/make-icons.mjs <Ordner mit node_modules/sharp>
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sharp = createRequire(path.resolve(process.argv[2] || '.') + '/')('sharp');

// ---- Bausteine (Koordinaten 1024 x 1024) ----
const defs = `
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7fdcff"/><stop offset=".45" stop-color="#25a6ee"/><stop offset="1" stop-color="#0a69bd"/>
  </linearGradient>
  <radialGradient id="glow" cx=".25" cy=".12" r=".7">
    <stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="hill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a6ec63"/><stop offset="1" stop-color="#3a9e27"/></linearGradient>
  <linearGradient id="hill2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fd146"/><stop offset="1" stop-color="#27801f"/></linearGradient>
  <linearGradient id="plane" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#e9f6ff"/><stop offset="1" stop-color="#a9d8f5"/></linearGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></linearGradient>
  <filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#04365f" flood-opacity=".55"/></filter>
  <filter id="wsh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#04365f" flood-opacity=".4"/></filter>
</defs>`;

const bg = `
<rect width="1024" height="1024" fill="url(#sky)"/>
<rect width="1024" height="1024" fill="url(#glow)"/>
<ellipse cx="250" cy="300" rx="190" ry="48" fill="#fff" opacity=".28"/>
<ellipse cx="800" cy="610" rx="150" ry="38" fill="#fff" opacity=".22"/>
<circle cx="860" cy="190" r="46" fill="#fff" opacity=".22"/><circle cx="160" cy="560" r="26" fill="#fff" opacity=".25"/>
<path d="M0 800 Q260 690 520 790 T1024 760 V1024 H0Z" fill="url(#hill1)"/>
<path d="M0 880 Q300 800 580 870 T1024 850 V1024 H0Z" fill="url(#hill2)"/>`;

// Flugzeug (Draufsicht, Spitze nach oben), zentriert um 0,0, ca. +-11 Einheiten
const planePath = 'M0 -10 L2.2 -3 L10 3 L10 5 L2.2 2.5 L1.8 8 L5 10 L5 11.5 L0 10.3 L-5 11.5 L-5 10 L-1.8 8 L-2.2 2.5 L-10 5 L-10 3 L-2.2 -3Z';
// Schallwellen: Bögen um einen Punkt unten links, die zum Flugzeug (oben rechts) laufen
const waves = [150, 250, 350].map((r, i) => {
  const a1 = -75 * Math.PI / 180, a2 = -15 * Math.PI / 180;
  const p = a => `${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`;
  return `<path d="M${p(a1)} A${r} ${r} 0 0 1 ${p(a2)}" stroke-width="${46 - i * 4}" opacity="${(1 - i * .22).toFixed(2)}"/>`;
}).join('\n');
const fgArt = `
<g transform="translate(300 790)" fill="none" stroke="#fff" stroke-linecap="round">${waves}</g>
<circle cx="300" cy="790" r="34" fill="#fff"/>
<g transform="translate(626 418) rotate(45) scale(21)"><path d="${planePath}" fill="#04365f" opacity=".28"/></g>
<g transform="translate(620 400) rotate(45) scale(21)">
  <path d="${planePath}" fill="url(#plane)" stroke="#fff" stroke-width=".35" stroke-linejoin="round"/>
</g>`;
const glossOverlay = `<path d="M60 70 Q512 -40 964 70 Q930 400 512 430 Q94 400 60 70Z" fill="url(#gloss)" opacity=".9"/>`;

const svg = (inner, clip = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${defs}${clip}${inner}</svg>`;
const rounded = (inner, r) => svg(`<clipPath id="c"><rect width="1024" height="1024" rx="${r}"/></clipPath><g clip-path="url(#c)">${inner}${glossOverlay}</g>
  <rect x="3" y="3" width="1018" height="1018" rx="${r - 3}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="6"/>`);

const full = rounded(bg + fgArt, 230);
const round = svg(`<clipPath id="c"><circle cx="512" cy="512" r="512"/></clipPath><g clip-path="url(#c)">${bg}${fgArt}${glossOverlay}</g>`);
const bgOnly = svg(bg);
const fgOnly = svg(`<g transform="translate(512 512) scale(.86) translate(-512 -512)">${fgArt}</g>`);

// ---- Ausgabe ----
const out = (p, data) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
out(path.join(here, 'icon.svg'), full);
const png = (s, size, file) => sharp(Buffer.from(s)).resize(size, size).png().toFile(file);

await png(full, 512, path.join(root, 'icon-512.png'));
await png(full, 192, path.join(root, 'icon-192.png'));
const res = path.join(root, 'android/app/src/main/res');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dens)) {
  const dir = path.join(res, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  await png(full, Math.round(48 * k), path.join(dir, 'ic_launcher.png'));
  await png(round, Math.round(48 * k), path.join(dir, 'ic_launcher_round.png'));
  await png(fgOnly, Math.round(108 * k), path.join(dir, 'ic_launcher_foreground.png'));
  await png(bgOnly, Math.round(108 * k), path.join(dir, 'ic_launcher_background.png'));
}
const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
out(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), xml);
out(path.join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'), xml);
console.log('Icons erzeugt');



