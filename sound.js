// Hörbarkeits-Modell: schätzt den Schallpegel eines Flugzeugs am Standort – ohne Mikrofon, nur aus ADS-B-Daten.
//
//   Pegel = Quellpegel(Typklasse, Flugphase)            LAmax in 305 m Abstand (Grössenordnung der ANP/NPD-Daten)
//         − 20·log10(d / 305 m)                          geometrische Ausbreitung
//         − Luftabsorption(d)                            pro km abnehmend, weil die hohen Frequenzen zuerst verschwinden
//         − Zusatzdämpfung bei flachem Einfallswinkel    Boden, Bebauung, Gelände (nach SAE AIR 5662)
//         ± Richtwirkung                                 Jets sind unter Schub nach hinten lauter als nach vorn
//
// Genauigkeit: etwa ±6 dB. Wind, Temperaturschichtung und Geländeabschattung sind nicht berücksichtigt.
(function (root) {
'use strict';

// [Start/Steigflug, Landeanflug] in dB(A) bei 305 m
const CLASSES = {
  heavy4:    [94, 84],   // A340, B747, MD-11, grosse Militärtransporter
  heavy2:    [90, 80],   // A330, B767, B777, B757
  heavyNew:  [86, 77],   // A350, B787, A330neo
  narrow:    [85, 77],   // A320-Familie (ceo), B737 Classic/NG
  narrowNew: [80, 74],   // A320neo, A220, B737 MAX, Embraer E2
  regional:  [82, 75],   // Embraer E-Jets, CRJ, Fokker, Avro
  bizjet:    [80, 72],
  turboprop: [79, 73],   // Dash 8, ATR, Saab
  tpSingle:  [76, 70],   // PC-12, PC-6, Caravan
  piston:    [70, 65],   // Kleinflugzeuge
  heli:      [80, 79],   // im Reiseflug kaum leiser als im Steigflug
  mil:       [104, 92],  // Kampfjets
  silent:    [25, 25],   // Segelflugzeuge, Ballone
};
const JETS = new Set(['heavy4', 'heavy2', 'heavyNew', 'narrow', 'narrowNew', 'regional', 'bizjet', 'mil']);

const LISTS = {
  heavy4: 'A342 A343 A345 A346 A388 B741 B742 B743 B744 B748 B74S B74R MD11 DC10 A124 A225 IL76 IL96 IL62 C17 C5M A400 K35R E3TF E3CF B703',
  heavy2: 'A306 A30B A310 A332 A333 A3ST B752 B753 B762 B763 B764 B772 B77L B773 B77W',
  heavyNew: 'A338 A339 A359 A35K B788 B789 B78X B778 B779',
  narrow: 'A318 A319 A320 A321 B712 B721 B722 MD81 MD82 MD83 MD87 MD88 MD90 T204 T154',
  narrowNew: 'A19N A20N A21N B37M B38M B39M B3XM BCS1 BCS3 E290 E295 E275',
  regional: 'E170 E75L E75S E190 E195 E135 E145 E45X CRJ1 CRJ2 CRJ7 CRJ9 CRJX F70 F100 RJ70 RJ85 RJ1H B461 B462 B463 SU95 AN48',
  bizjet: 'F2TH F900 E35L E545 E550 E50P E55P PRM1 PC24 HDJT BE40 ASTR G150 G280 HA4T SF50 EA50 GALX',
  turboprop: 'DH8A DH8B DH8C DH8D AT43 AT45 AT46 AT72 AT73 AT75 AT76 SF34 SB20 D328 JS32 JS41 B190 BE20 B350 BE9L BE99 C130 C30J C295 CN35 E120 F50 F27 AN26 L410 SW4 DHC6 DHC7 C160',
  tpSingle: 'PC12 PC6T PC7 PC9 PC21 C208 TBM7 TBM8 TBM9 P46T M600 KODI',
  mil: 'F18 F18H F18S F16 F15 F35 F5 EUFI RFAL TOR HAWK A10 L39 GRIP',
  heli: 'EC20 EC30 EC35 EC45 EC55 EC25 EC75 AS50 AS55 AS65 AS32 AS3B A109 A119 A139 A169 A189 B06 B407 B412 B429 B212 B505 R22 R44 R66 H500 MD52 MD60 S76 S92 H47 H60 H64 NH90 G2CA CABR K126 EXPL B105 BK17 H160 H175',
  silent: 'GLID BALL',
};
const BY_TYPE = {};
for (const cls of Object.keys(LISTS)) for (const t of LISTS[cls].split(' ')) BY_TYPE[t] = cls;
const BIZ_RE = /^(C25|C5[0-9]|C6[0-9]|C7[0-9]|GL[0-9EF]|CL[0-9]|FA[0-9]|LJ[0-9]|H25)/;

// Typklasse aus ICAO-Typcode, sonst aus der ADS-B-Kategorie, sonst aus dem Flugverhalten
function classify(type, category, gs, altFt) {
  const t = (type || '').toUpperCase();
  if (BY_TYPE[t]) return BY_TYPE[t];
  if (/^B73[0-9]$/.test(t)) return 'narrow';
  if (BIZ_RE.test(t)) return 'bizjet';
  switch (category) {
    case 'A1': return 'piston';
    case 'A2': return 'bizjet';
    case 'A3': return 'narrow';
    case 'A4': case 'A5': return 'heavy2';
    case 'A6': return 'mil';
    case 'A7': return 'heli';
    case 'B1': case 'B2': case 'B3': return 'silent';
    case 'B4': case 'B6': return 'piston';
  }
  return (gs > 220 || altFt > 15000) ? 'narrow' : 'piston';
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;

// Quellpegel je nach Flugphase. rate: ft/min, gs: kt, hAgl: Höhe über Flugplatzniveau in m
function sourceLevel(cls, rate, gs, hAgl) {
  const [dep, app] = CLASSES[cls] || CLASSES.narrow;
  const level = app + 2, idle = app - 4;               // Horizontalflug braucht mehr Schub als der Gleitpfad; Sinkflug im Leerlauf weniger
  let L;
  if (rate >= 0) {
    L = lerp(level, dep, clamp01(rate / 1200));
    L -= 3 * clamp01((hAgl - 1500) / 6000) * clamp01(rate / 1200);   // Steigschub nimmt mit der Höhe ab
  } else {
    L = lerp(level, idle, clamp01(-rate / 700));
  }
  if (rate < 200 && hAgl < 1100 && gs < 200) L = Math.max(L, app);   // Endanflug: Fahrwerk und Klappen draussen, Triebwerke stützen
  if (JETS.has(cls)) L += 4 * clamp01((gs - 250) / 200);              // schneller Flug: Umströmungslärm, hoher Schub im Reiseflug
  return L;
}

// Luftabsorption in dB für A-bewerteten Fluglärm (aus dem Verlauf typischer NPD-Kurven)
function absorption(dM) {
  const km = dM / 1000;
  return 2.5 * Math.min(km, 3) + 1.3 * Math.max(0, Math.min(km, 8) - 3) + 0.6 * Math.max(0, km - 8);
}

// Zusatzdämpfung bei flachem Einfall (SAE AIR 5662), darunter zusätzlich Abschattung durch Gelände und Häuser
function lowAngle(elDeg, horizM) {
  const b = Math.max(0, elDeg);
  if (b >= 50) return 0;
  const lambda = 1.137 - 0.0229 * b + 9.72 * Math.exp(-0.142 * b);
  const gamma = horizM >= 914 ? 1 : 1.089 * (1 - Math.exp(-0.00274 * horizM));
  const shield = horizM > 1500 ? 8 * clamp01((3 - elDeg) / 3) : 0;
  return lambda * gamma + shield;
}

/* o: { cls, rate (ft/min), gs (kt), hAgl (m), dist (m, Luftlinie), horiz (m), el (Grad über Horizont),
        toward (−1…1: +1 = fliegt direkt auf den Standort zu) }  ->  geschätzter Pegel in dB(A) */
function estimate(o) {
  const d = Math.max(o.dist, 60);
  let L = sourceLevel(o.cls, o.rate, o.gs, o.hAgl);
  if (JETS.has(o.cls)) L -= 2 * (o.toward || 0) * clamp01(o.rate / 1200);
  L -= 20 * Math.log10(d / 305);
  L -= absorption(d);
  L -= lowAngle(o.el, o.horiz);
  return L;
}

// Umgebungslärm: ohne Mikrofon nicht messbar, darum wählbar
const AMBIENT = [
  { key: 'ruhig', db: 35 },     // Land, Nacht, ruhiger Garten
  { key: 'normal', db: 45 },    // Wohnquartier tagsüber
  { key: 'laut', db: 55 },      // Strassenlärm – oder drinnen bei geschlossenem Fenster
];
const DETECT_BELOW = 5;         // Fluglärm ist tieffrequent und fällt schon knapp unter dem Umgebungspegel auf
function describe(db, ambientDb) {
  const over = db - ambientDb;
  return over < -DETECT_BELOW ? 'nicht hörbar' : over < 3 ? 'leise' : over < 13 ? 'gut hörbar' : over < 25 ? 'laut' : 'sehr laut';
}

const api = { CLASSES, AMBIENT, DETECT_BELOW, classify, sourceLevel, absorption, lowAngle, estimate, describe };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Sound = api;
})(typeof window !== 'undefined' ? window : globalThis);
