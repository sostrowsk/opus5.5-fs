// ISA-Atmosphäre, Wind-Grenzschicht und Böen (Dryden-ähnlich, seeded). Ohne three, ohne DOM.
import { KT, DEG, clamp, mulberry32, gauss } from './math.js';

export const T0 = 288.15; // K
export const P0 = 101325; // Pa
export const RHO0 = 1.225; // kg/m³
export const LAPSE = 0.0065; // K/m
export const R_AIR = 287.053;
export const GAMMA = 1.4;
const EXP = 5.25588; // g/(R·L)
export const A0 = Math.sqrt(GAMMA * R_AIR * T0); // Schallgeschwindigkeit Meereshöhe

/**
 * Zustand der Luft in Höhe h (m MSL). qnhHpa verschiebt den Bodendruck (Standard 1013,25 hPa).
 * Rückgabe { T, p, rho, sigma, a }.
 */
export function isa(h, qnhHpa = 1013.25) {
  const hh = Math.min(h, 11000);
  const T = T0 - LAPSE * hh;
  let p = qnhHpa * 100 * Math.pow(T / T0, EXP);
  if (h > 11000) p *= Math.exp((-9.80665 * (h - 11000)) / (R_AIR * T));
  const rho = p / (R_AIR * T);
  return { T, p, rho, sigma: rho / RHO0, a: Math.sqrt(GAMMA * R_AIR * T) };
}

/** Druckhöhe (m) zu einem statischen Druck p (Pa), Referenz 1013,25 hPa. */
export function pressureAltitude(p) {
  return (T0 / LAPSE) * (1 - Math.pow(p / P0, 1 / EXP));
}
/** Höhenmesseranzeige (m) für statischen Druck p (Pa) bei Kollsman-Einstellung kollsmanHpa. */
export function altimeterAltitude(p, kollsmanHpa) {
  return (T0 / LAPSE) * (1 - Math.pow(p / (kollsmanHpa * 100), 1 / EXP));
}

/** Kalibrierte Fahrt (m/s) aus TAS (m/s) und Luftzustand (kompressibel, Pitot-Formel). */
export function casFromTas(tas, air) {
  const M = tas / air.a;
  const qc = air.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}
/** Umkehrung: TAS (m/s) aus CAS (m/s). */
export function tasFromCas(cas, air) {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
  const M = Math.sqrt(5 * (Math.pow(qc / air.p + 1, 2 / 7) - 1));
  return M * air.a;
}

// ---------------------------------------------------------------- Wind & Turbulenz
const WIND_REF_AGL = 10; // m – bis hierhin gilt die eingestellte Bodenwindstärke
const WIND_TOP_AGL = 600; // m – Ende der Grenzschicht
const WIND_TOP_FACTOR = 1.5; // Windzunahme bis 600 m AGL

// Turbulenz-Parameter (Dryden-ähnlich, erste Ordnung)
const TURB_SIGMA_MAX = 2.3; // m/s Standardabweichung vertikal bei 100 %
const TURB_L_UV = 180; // m Skalenlänge horizontal
const TURB_L_W = 90; // m Skalenlänge vertikal
const TURB_SPAN = 10.97; // m Spannweite (Roll-Böe)
const TURB_L_P = (4 * TURB_SPAN) / Math.PI; // m Skalenlänge Roll-Böe (Dryden: Knick bei ω = πV/4b)

/**
 * Atmosphären-Zustand. Alle Werte live veränderbar.
 * windDir: Richtung, AUS der der Wind weht (°), windKt: Bodenwind (kt), turbulence 0..1.
 */
export function createAtmosphere(opts = {}) {
  const seed = opts.seed ?? 1729;
  return {
    qnh: opts.qnh ?? 1013.25,
    windDir: opts.windDir ?? 0,
    windKt: opts.windKt ?? 0,
    turbulence: opts.turbulence ?? 0,
    extraTurbulence: 0, // z. B. in Wolken (0..1), wird von der Welt gesetzt
    seed,
    rng: mulberry32(seed),
    gust: [0, 0, 0], // Body-Achsen (u, v, w) m/s
    gustP: 0, // Roll-Böe rad/s
  };
}

/** Werte aus dem UI-/SIM-env übernehmen ({ windDir, windKt, turbulence (%), qnh (hPa) }). */
export function setAtmosphereFromEnv(atm, env) {
  if (env.windDir !== undefined) atm.windDir = +env.windDir;
  if (env.windKt !== undefined) atm.windKt = +env.windKt;
  if (env.turbulence !== undefined) atm.turbulence = clamp(+env.turbulence / 100, 0, 1);
  if (env.qnh !== undefined) atm.qnh = +env.qnh;
}

/** Windfaktor der Grenzschicht über der Höhe über Grund (logarithmisch 10 → 600 m). */
export function windProfile(agl) {
  if (agl <= WIND_REF_AGL) return 1;
  const h = Math.min(agl, WIND_TOP_AGL);
  return 1 + ((WIND_TOP_FACTOR - 1) * Math.log(h / WIND_REF_AGL)) / Math.log(WIND_TOP_AGL / WIND_REF_AGL);
}

/** Mittlerer Wind (ohne Böen) als Three-Weltvektor (m/s) in der Höhe agl (m). */
export function windAt(atm, agl, out = [0, 0, 0]) {
  const s = atm.windKt * KT * windProfile(Math.max(0, agl));
  const a = atm.windDir * DEG;
  // Wind weht AUS windDir, also in Richtung windDir + 180°.
  out[0] = -s * Math.sin(a);
  out[1] = 0;
  out[2] = s * Math.cos(a);
  return out;
}

/** Turbulenzintensität (Standardabweichung vertikal, m/s) abhängig von Grad und Höhe über Grund. */
export function turbulenceSigma(atm, agl) {
  const level = clamp(atm.turbulence + atm.extraTurbulence, 0, 1.5);
  if (level <= 0) return 0;
  // Mechanische Turbulenz nahe am Boden stärker, darüber abklingend auf 70 %.
  const f = 0.7 + 0.45 * Math.exp(-Math.max(0, agl) / 450);
  return TURB_SIGMA_MAX * level * f;
}

/**
 * Böen einen Schritt weiterführen (Filter 1. Ordnung, Zeitkonstante L/V).
 * V: Fahrt (m/s), agl: Höhe über Grund (m). Ergebnis in atm.gust (Body) und atm.gustP.
 */
export function updateGusts(atm, dt, V, agl) {
  const sw = turbulenceSigma(atm, agl);
  const g = atm.gust;
  if (sw <= 0) {
    // sanft abklingen, damit das Abschalten keinen Sprung erzeugt
    const k = Math.exp(-dt / 1.5);
    g[0] *= k;
    g[1] *= k;
    g[2] *= k;
    atm.gustP *= k;
    return;
  }
  const v = Math.max(V, 8);
  // Nahe am Boden sind vertikale Böen durch den Boden begrenzt, horizontale stärker.
  const nearGround = clamp(agl / 60, 0.35, 1);
  const su = sw * (1.25 - 0.25 * nearGround);
  const svw = sw * nearGround;
  const step = (x, sigma, L) => {
    const a = Math.exp((-v * dt) / L);
    return a * x + sigma * Math.sqrt(1 - a * a) * gauss(atm.rng);
  };
  g[0] = step(g[0], su, TURB_L_UV);
  g[1] = step(g[1], su, TURB_L_UV);
  g[2] = step(g[2], svw, TURB_L_W);
  // Roll-Böe nach Dryden (MIL-F-8785C, niedrige Höhe L_w ≈ h):
  // σ_p = σ_w·√(0,8/V)·(π/4b)^(1/6) / L_w^(1/3). Ein pauschales σ_w/b wäre ~6× zu stark und
  // lässt die Maschine schon bei leichter Turbulenz hands-off in Querlagen von >10° kippen.
  const Lw = clamp(agl, 20, 533);
  const sp = (sw * Math.sqrt(0.8 / v) * Math.pow(Math.PI / (4 * TURB_SPAN), 1 / 6)) / Math.cbrt(Lw);
  atm.gustP = step(atm.gustP, sp, TURB_L_P);
}

/** RNG und Böen zurücksetzen (reproduzierbar). */
export function resetGusts(atm) {
  atm.rng = mulberry32(atm.seed);
  atm.gust = [0, 0, 0];
  atm.gustP = 0;
}
