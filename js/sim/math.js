// Kleine Vektor-/Quaternion-Mathematik für die Physik (ohne three, ohne DOM).
//
// Konventionen
// - Welt (Three.js): +X = Ost, +Y = oben, −Z = Nord. Positionen/Geschwindigkeiten der Sim liegen in diesem System.
// - Lokales Navigationssystem NED: [Nord, Ost, unten].
// - Body (Luftfahrt): x = vorn (Nase), y = rechts (rechter Flügel), z = unten.
// - Quaternion q = [w, x, y, z] beschreibt die Drehung Body → NED.
// Genau EINE Übersetzung Body → Three-Welt: bodyToThree(q, v).

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KT = 0.514444; // m/s pro Knoten
export const FT = 0.3048; // m pro Fuß
export const FPM = FT / 60; // m/s pro ft/min
export const G0 = 9.80665;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Lineare Interpolation in einer Stützstellentabelle (xs aufsteigend), außerhalb konstant. */
export function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (x > xs[i]) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** Wie interp, aber linear extrapolierend an beiden Enden. */
export function interpExtrap(xs, ys, x) {
  const n = xs.length;
  let i;
  if (x <= xs[1]) i = 1;
  else if (x >= xs[n - 2]) i = n - 1;
  else {
    i = 1;
    while (x > xs[i]) i++;
  }
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** Winkel auf (−π, π] normieren. */
export function wrapPi(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}
/** Grad auf [0, 360) normieren. */
export function wrap360(d) {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

// ---------------------------------------------------------------- Vektoren (Arrays [x,y,z])
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export function norm(a) {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
/** a += b * s (in place), gibt a zurück. */
export function addScaled(a, b, s) {
  a[0] += b[0] * s;
  a[1] += b[1] * s;
  a[2] += b[2] * s;
  return a;
}

// ---------------------------------------------------------------- Quaternionen [w,x,y,z]
export function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l;
  q[1] /= l;
  q[2] /= l;
  q[3] /= l;
  return q;
}
export const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];

/** Vektor mit q drehen (Body → NED). */
export function qRot(q, v) {
  const [w, x, y, z] = q;
  // t = 2 * cross(qv, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
/** Vektor mit q⁻¹ drehen (NED → Body). */
export function qRotInv(q, v) {
  return qRot([q[0], -q[1], -q[2], -q[3]], v);
}

/**
 * Quaternion aus Luftfahrt-Eulerwinkeln (rad): Kurs ψ (0 = Nord, 90° = Ost),
 * Nick θ (positiv = Nase hoch), Querneigung φ (positiv = rechter Flügel unten).
 * Reihenfolge ZYX (erst Kurs, dann Nick, dann Rollen).
 */
export function qFromEuler(psi, theta, phi) {
  const cy = Math.cos(psi / 2), sy = Math.sin(psi / 2);
  const cp = Math.cos(theta / 2), sp = Math.sin(theta / 2);
  const cr = Math.cos(phi / 2), sr = Math.sin(phi / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}
/** Eulerwinkel {psi, theta, phi} (rad) aus Quaternion Body → NED. psi in [0, 2π). */
export function qToEuler(q) {
  const [w, x, y, z] = q;
  const phi = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const theta = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
  let psi = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  if (psi < 0) psi += 2 * Math.PI;
  return { psi, theta, phi };
}

/** q ← q + ½·q⊗(0,ω)·dt, danach normalisiert (ω im Body-System). */
export function qIntegrate(q, w, dt) {
  const h = 0.5 * dt;
  const [a, b, c, d] = q;
  q[0] = a + h * (-b * w[0] - c * w[1] - d * w[2]);
  q[1] = b + h * (a * w[0] + c * w[2] - d * w[1]);
  q[2] = c + h * (a * w[1] - b * w[2] + d * w[0]);
  q[3] = d + h * (a * w[2] + b * w[1] - c * w[0]);
  return qNormalize(q);
}

// ---------------------------------------------------------------- Achsen-Übersetzung
/** NED [n, e, d] → Three-Welt [x, y, z]. */
export const nedToThree = (v) => [v[1], -v[2], -v[0]];
/** Three-Welt [x, y, z] → NED [n, e, d]. */
export const threeToNed = (v) => [-v[2], v[0], -v[1]];

/** DIE Übersetzung: Body-Vektor (x vorn, y rechts, z unten) → Three-Weltvektor. */
export function bodyToThree(q, vBody) {
  return nedToThree(qRot(q, vBody));
}
/** Umkehrung: Three-Weltvektor → Body-Vektor. */
export function threeToBody(q, vWorld) {
  return qRotInv(q, threeToNed(vWorld));
}
/**
 * Quaternion für ein Three-Objekt, dessen lokale Achsen der Three-Konvention folgen
 * (Nase −Z, rechts +X, oben +Y). Rückgabe [x, y, z, w] für THREE.Quaternion.set(x,y,z,w).
 */
export function quatToThree(q) {
  return [q[2], -q[3], -q[1], q[0]];
}

/** Kurs (Grad) → Three-Richtungsvektor in der Horizontalen. */
export function headingToThree(deg) {
  const a = deg * DEG;
  return [Math.sin(a), 0, -Math.cos(a)];
}

// ---------------------------------------------------------------- Zufall (seeded)
/** Mulberry32 – deterministischer PRNG, liefert Funktion → [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standardnormalverteilte Zufallszahl aus einer [0,1)-Quelle (Box-Muller). */
export function gauss(rng) {
  let u = rng();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
