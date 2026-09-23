// Himmelsmodell ohne three und ohne DOM (läuft unter node --test):
// Sonnenstand (48° N, Tagundnachtgleiche), Einfachstreuung nach Rayleigh/Mie mit Ozon-Absorption und daraus
// abgeleitete Licht-, Dunst- und Belichtungswerte. Dieselbe Formel liegt als GLSL (SKY_GLSL) im Himmels- und im
// Wasser-Shader; die CPU-Fassung liefert Sonnen-/Himmelslicht, Dunstfarben und die Werte für die Tests (AK-21).
import { clamp, DEG } from '../sim/math.js';

export const LAT = 48 * DEG;

/** Sonnenrichtung [x, y, z] (Three-Welt: +X Ost, +Y oben, −Z Nord) für die Tageszeit in Stunden. */
export function sunDirection(hours, out = [0, 0, 0]) {
  const H = ((hours - 12) / 24) * Math.PI * 2; // Stundenwinkel
  const e = -Math.sin(H); // Ost
  const n = -Math.sin(LAT) * Math.cos(H); // Nord
  const u = Math.cos(LAT) * Math.cos(H); // oben
  const l = Math.hypot(e, n, u);
  out[0] = e / l;
  out[1] = u / l;
  out[2] = -n / l;
  return out;
}

/** Sonnenhöhe in Grad. */
export function sunElevationDeg(hours) {
  const s = sunDirection(hours);
  return Math.asin(clamp(s[1], -1, 1)) / DEG;
}

// Optische Dicken im Zenit (RGB ≈ 680/550/440 nm)
export const TAU_R = [0.0464, 0.1085, 0.2648]; // Rayleigh (β·8 km)
export const TAU_M = 0.042; // Mie (leicht dunstig, wellenlängenunabhängig)
export const TAU_O = [0.021, 0.045, 0.002]; // Ozon-Absorption (Chappuis-Band → blaue Dämmerung)
export const MIE_G = 0.76;
export const SUN_E = 1.35; // Skalierung der Himmelsleuchtdichte (linear, vor Tone-Mapping)

/** Luftmasse nach Kasten-Young (cosZ = Sinus der Elevation); unter dem Horizont auf den Horizont begrenzt. */
export function airmass(cosZ) {
  const c = clamp(cosZ, 0, 1);
  const zDeg = Math.acos(c) / DEG;
  return 1 / (c + 0.50572 * Math.pow(96.07995 - zDeg, -1.6364));
}
/** Luftmasse der hoch liegenden Ozonschicht (≈ 22 km, Kugelschale). */
export function airmassOzone(cosZ) {
  const c = clamp(cosZ, 0, 1);
  const k = 6371 / 6393;
  return 1 / Math.sqrt(1 - k * k * (1 - c * c));
}

/** Sonnen-Transmission bis zum Boden (RGB, 0..1) bei Sonnen-Sinus sy. */
export function sunTransmittance(sy, out = [0, 0, 0]) {
  const m = airmass(sy), mo = airmassOzone(sy);
  const fade = smooth(-0.035, 0.01, sy); // Sonne hinter dem Horizont
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-(TAU_R[c] * m + TAU_M * m + TAU_O[c] * mo)) * fade;
  return out;
}

function smooth(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const _tsc = [0, 0, 0];
/**
 * Himmelsleuchtdichte (linear RGB, vor Tone-Mapping) in Blickrichtung v (normiert) bei Sonnenrichtung s.
 * Unterhalb des Horizonts wird die Horizontrichtung verwendet. Nachtanteil (Mond/Sternenlicht) inklusive.
 */
export function skyRadiance(vx, vy, vz, s, out = [0, 0, 0]) {
  const y = Math.max(vy, 0);
  const l = Math.hypot(vx, y, vz) || 1;
  vx /= l;
  vz /= l;
  const vyn = y / l;
  const mu = vx * s[0] + vyn * s[1] + vz * s[2];
  const mV = airmass(vyn);
  // Sonnenlicht an den Streupunkten: Blick nach oben → hohe Streupunkte → weniger Luftmasse auf dem Sonnenweg
  const sy = s[1];
  const mS = airmass(sy + 0.03) * (0.75 - 0.6 * vyn);
  const moS = airmassOzone(sy + 0.03);
  const fade = smooth(-0.2, 0.02, sy); // Dämmerung bis ≈ −11°
  for (let c = 0; c < 3; c++) _tsc[c] = Math.exp(-((TAU_R[c] + TAU_M) * mS + TAU_O[c] * moS)) * fade;
  const pr = 0.75 * (1 + mu * mu);
  const g = MIE_G;
  const pm = (1 - g * g) / Math.pow(1 + g * g - 2 * g * mu, 1.5);
  const moonUp = smooth(-0.05, 0.1, -sy); // Vollmond gegenüber der Sonne
  for (let c = 0; c < 3; c++) {
    const tr = TAU_R[c], tt = tr + TAU_M;
    const scat = 1 - Math.exp(-tt * mV);
    const single = ((tr * pr + TAU_M * pm) / tt) * scat;
    const multi = 0.28 * (tr / tt) * scat; // grobe Mehrfachstreuung (hellt den sonnenabgewandten Himmel auf)
    out[c] = SUN_E * _tsc[c] * (single + multi);
  }
  // Nachthimmel (Airglow + Mondlicht), unabhängig von der Sonne
  const night = 1 - smooth(-0.2, -0.05, sy);
  out[0] += night * (0.0009 + 0.004 * moonUp * (1 - vyn * 0.5));
  out[1] += night * (0.0014 + 0.006 * moonUp * (1 - vyn * 0.5));
  out[2] += night * (0.0030 + 0.011 * moonUp * (1 - vyn * 0.5));
  return out;
}

// ------------------------------------------------------------------ Sicht (Dunst-Rand bzw. in der Wolke)
export const CLEAR_VISIBILITY = 22000; // m – Randabblendung des Geländes (Fern-Mesh reicht ±24 km)
export const CLOUD_VISIBILITY = 140; // m – im Wolkenkern
/** Anteil „in der Wolke“ (0..1) aus der Wolkendichte an der Kamera. */
export function inCloudAmount(density) {
  return smooth(0.2, 0.5, density);
}
/** Fog-Sichtweite (m) für den Anteil in der Wolke. */
export function fogVisibility(inCloud) {
  return CLEAR_VISIBILITY + (CLOUD_VISIBILITY - CLEAR_VISIBILITY) * clamp(inCloud, 0, 1);
}

/** Leuchtdichte (Rec. 709) */
export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Alle von der Tageszeit abhängigen Beleuchtungswerte (CPU):
 * { sunDir, moonDir, elevation (°), darkness 0..1, sunColor (normiert), sunIntensity, moonIntensity,
 *   skyColor/skyIntensity (Hemisphäre), groundColor, hazeSun, hazeAway, hazeGlow (Dunst-Leuchtdichten),
 *   zenith, starAlpha, exposure }
 */
export function skyLighting(hours, out = {}) {
  const s = (out.sunDir = sunDirection(hours, out.sunDir || [0, 0, 0]));
  out.moonDir = [-s[0], -s[1], -s[2]];
  const elev = Math.asin(clamp(s[1], -1, 1)) / DEG;
  out.elevation = elev;
  out.darkness = clamp((6 - elev) / 14, 0, 1);
  // Sonnenlicht: Farbe relativ zur Mittagssonne (weiß), Intensität ∝ Leuchtdichte der Transmission
  const t = sunTransmittance(s[1], [0, 0, 0]);
  const tz = sunTransmittance(1, [0, 0, 0]);
  const rel = [t[0] / tz[0], t[1] / tz[1], t[2] / tz[2]];
  const lum = luminance(rel);
  const mx = Math.max(rel[0], rel[1], rel[2], 1e-6);
  out.sunColor = [rel[0] / mx, rel[1] / mx, rel[2] / mx];
  out.sunIntensity = 5.2 * lum;
  // Wolken in ≈ 1,8 km Höhe sehen die Sonne noch ≈ 1,4° länger (Abendrot an den Wolken nach Sonnenuntergang)
  const tcl = sunTransmittance(s[1] + 0.024, [0, 0, 0]);
  const relc = [tcl[0] / tz[0], tcl[1] / tz[1], tcl[2] / tz[2]];
  const mxc = Math.max(relc[0], relc[1], relc[2], 1e-6);
  out.cloudSunColor = [relc[0] / mxc, relc[1] / mxc, relc[2] / mxc];
  out.cloudSunIntensity = 5.2 * luminance(relc);
  const moonUp = smooth(0.0, 0.25, -s[1]);
  out.moonIntensity = 0.1 * moonUp;
  // Himmelslicht (Hemisphäre): Mittel über Zenit und 30°-Ring
  const acc = [0, 0, 0], tmp = [0, 0, 0];
  skyRadiance(0, 1, 0, s, tmp);
  for (let c = 0; c < 3; c++) acc[c] += tmp[c] * 2;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    skyRadiance(Math.cos(a) * 0.866, 0.5, Math.sin(a) * 0.866, s, tmp);
    for (let c = 0; c < 3; c++) acc[c] += tmp[c];
  }
  for (let c = 0; c < 3; c++) acc[c] /= 8;
  const skyLum = luminance(acc);
  const skyMax = Math.max(acc[0], acc[1], acc[2], 1e-6);
  out.skyColor = [acc[0] / skyMax, acc[1] / skyMax, acc[2] / skyMax];
  out.skyIntensity = 2.6 * skyLum + 0.02;
  out.zenith = skyRadiance(0, 1, 0, s, out.zenith || [0, 0, 0]);
  // Boden-Rückstrahlung (grünlich-braun) aus Sonne + Himmel
  const gi = 0.12 * (out.sunIntensity * Math.max(s[1], 0) + out.skyIntensity);
  out.groundColor = [0.42 * gi, 0.44 * gi, 0.34 * gi];
  // Dunst: Horizont zur Sonne (Azimut der Sonne, 1,5° Elevation) und gegenüber
  const ha = Math.hypot(s[0], s[2]) || 1;
  const hx = s[0] / ha, hz = s[2] / ha;
  // Sonnenseite ohne den engen Mie-Hof (der kommt als hazeGlow dazu): Mittel bei ±35° Azimut
  const ca = Math.cos(35 * DEG), sa = Math.sin(35 * DEG);
  out.hazeSun = skyRadiance(hx * ca - hz * sa, 0.026, hz * ca + hx * sa, s, out.hazeSun || [0, 0, 0]);
  const hs2 = skyRadiance(hx * ca + hz * sa, 0.026, hz * ca - hx * sa, s, [0, 0, 0]);
  for (let c = 0; c < 3; c++) out.hazeSun[c] = 0.5 * (out.hazeSun[c] + hs2[c]);
  out.hazeAway = skyRadiance(-hx, 0.026, -hz, s, out.hazeAway || [0, 0, 0]);
  const side = skyRadiance(hz, 0.026, -hx, s, [0, 0, 0]);
  // Querrichtung als Mittelwert einbeziehen (weicherer Übergang)
  for (let c = 0; c < 3; c++) out.hazeAway[c] = 0.5 * (out.hazeAway[c] + side[c]);
  // Vorwärtsstreuung im Dunst Richtung Sonne (golden hour)
  const tg = sunTransmittance(s[1], [0, 0, 0]);
  out.hazeGlow = [tg[0] * 0.55, tg[1] * 0.55, tg[2] * 0.55];
  out.starAlpha = clamp((-elev - 4) / 8, 0, 1);
  // Augenadaptation: Dämmerung und Nacht werden angehoben, bleiben aber sichtbar dunkler als der Tag
  const refLum = 0.55;
  const hl = luminance(out.hazeSun) * 0.5 + luminance(out.hazeAway) * 0.5 + 1e-4;
  out.exposure = clamp(Math.pow(refLum / hl, 0.4), 1, 2.4);
  return out;
}

// ------------------------------------------------------------------ GLSL-Fassung (identische Formeln)
export const SKY_GLSL = /* glsl */ `
const vec3 TAU_R = vec3(${TAU_R.join(', ')});
const float TAU_M = ${TAU_M.toFixed(4)};
const vec3 TAU_O = vec3(${TAU_O.join(', ')});
const float MIE_G = ${MIE_G.toFixed(3)};
float skyAirmass(float c) {
  c = clamp(c, 0.0, 1.0);
  float zDeg = degrees(acos(c));
  return 1.0 / (c + 0.50572 * pow(96.07995 - zDeg, -1.6364));
}
float skyAirmassO3(float c) {
  c = clamp(c, 0.0, 1.0);
  float k = 6371.0 / 6393.0;
  return inversesqrt(1.0 - k * k * (1.0 - c * c));
}
vec3 skyRadiance(vec3 v, vec3 s) {
  v.y = max(v.y, 0.0);
  v = normalize(v + vec3(0.0, 1e-5, 0.0));
  float mu = dot(v, s);
  float mV = skyAirmass(v.y);
  float mS = skyAirmass(s.y + 0.03) * (0.75 - 0.6 * v.y);
  float moS = skyAirmassO3(s.y + 0.03);
  float fade = smoothstep(-0.2, 0.02, s.y);
  vec3 tsc = exp(-((TAU_R + TAU_M) * mS + TAU_O * moS)) * fade;
  float pr = 0.75 * (1.0 + mu * mu);
  float g = MIE_G;
  float pm = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  vec3 tt = TAU_R + TAU_M;
  vec3 scat = 1.0 - exp(-tt * mV);
  vec3 single = ((TAU_R * pr + TAU_M * pm) / tt) * scat;
  vec3 multi = 0.28 * (TAU_R / tt) * scat;
  vec3 col = ${SUN_E.toFixed(3)} * tsc * (single + multi);
  float night = 1.0 - smoothstep(-0.2, -0.05, s.y);
  float moonUp = smoothstep(-0.05, 0.1, -s.y);
  col += night * (vec3(0.0009, 0.0014, 0.0030) + vec3(0.004, 0.006, 0.011) * moonUp * (1.0 - v.y * 0.5));
  return col;
}
`;
