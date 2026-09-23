// Kopfbewegung (SPEC §3.7, PLAN §2.1b): gedämpftes Feder-Masse-System im Body-System (x vorn, y rechts, z unten).
// Anregung ist die Abweichung der spezifischen Kraft am Piloten von 1 g (Lastvielfache, Querbeschleunigung,
// Längsbeschleunigung) – dadurch wirken Turbulenz und Fahrwerksstöße automatisch mit, stationärer Geradeausflug
// ergibt die Neutrallage. Harte Grenzen 2 cm / 1° (weich über tanh), kein Zufallswackeln, keine Horizont-
// aufrichtung, kein Zoom. Am Boden bei laufendem Motor eine drehzahlabhängige Vibration < 1 mm.
// Läuft im Physiktakt (deterministisch). Ohne three und ohne DOM (node --test).
import { DEG, G0, clamp, threeToBody } from '../sim/math.js';

export const HEAD = {
  freq: 2.5, // Hz Eigenfrequenz
  zeta: 0.7, // Dämpfungsgrad
  gain: 0.25, // Anteil der Beschleunigungsabweichung, der den Kopf auslenkt (Nacken hält dagegen)
  maxOffset: 0.02, // m
  maxRot: 1 * DEG, // rad
  rotPerM: (0.8 * DEG) / 0.02, // Nicken/Neigen pro Meter Versatz
  vibAmp: 0.0006, // m bei Volllast am Boden (< 1 mm)
  maxExcite: 4 * G0, // Anregung begrenzen (Aufsetzstoß)
};

export function createHead() {
  return {
    o: [0, 0, 0], // Versatz (Body, m) des Feder-Masse-Systems
    ov: [0, 0, 0], // Geschwindigkeit
    vPrev: null, // Weltgeschwindigkeit des letzten Schritts
    // Ausgabe: Versatz (Body, m), Nicken (rad, + = Nase/Blick hoch), Rollen (rad, + = rechts)
    out: { x: 0, y: 0, z: 0, pitch: 0, roll: 0 },
  };
}

export function resetHead(h) {
  h.o[0] = h.o[1] = h.o[2] = 0;
  h.ov[0] = h.ov[1] = h.ov[2] = 0;
  h.vPrev = null;
  const o = h.out;
  o.x = o.y = o.z = o.pitch = o.roll = 0;
}

const soft = (v, lim) => lim * Math.tanh(v / lim);

/**
 * Einen Physikschritt weiterrechnen. s: Flugzeugzustand (v, q, time, onGround, engineRunning, rpm, crashed),
 * strength: 0..1 (Einstellung Kopfbewegung / 100). Bei 0 wird nichts gerechnet und die Ausgabe ist exakt 0.
 */
export function stepHead(h, s, strength, dt) {
  const out = h.out;
  if (!(strength > 0) || s.crashed) {
    resetHead(h);
    return out;
  }
  // Weltbeschleunigung aus der Geschwindigkeitsänderung → spezifische Kraft im Body-System
  let ax = 0, ay = 0, az = 0;
  if (h.vPrev) {
    ax = (s.v[0] - h.vPrev[0]) / dt;
    ay = (s.v[1] - h.vPrev[1]) / dt;
    az = (s.v[2] - h.vPrev[2]) / dt;
  } else h.vPrev = [0, 0, 0];
  h.vPrev[0] = s.v[0];
  h.vPrev[1] = s.v[1];
  h.vPrev[2] = s.v[2];
  const f = threeToBody(s.q, [ax, ay + G0, az]); // spezifische Kraft (Body, NED: z unten)
  // Abweichung von 1 g „in den Sitz“ (0, 0, −g)
  const e = [f[0], f[1], f[2] + G0];
  const w = 2 * Math.PI * HEAD.freq;
  const k = w * w, c = 2 * HEAD.zeta * w;
  for (let i = 0; i < 3; i++) {
    const exc = clamp(e[i], -HEAD.maxExcite, HEAD.maxExcite);
    // Kopf bleibt träge zurück: Beschleunigung nach vorn → Kopf nach hinten (−x), mehr g → Kopf sinkt (+z)
    const acc = -k * h.o[i] - c * h.ov[i] - HEAD.gain * exc;
    h.ov[i] += acc * dt; // semi-implizit
    h.o[i] += h.ov[i] * dt;
  }
  let x = h.o[0] * strength, y = h.o[1] * strength, z = h.o[2] * strength;
  // Motorvibration am Boden (deterministisch aus der Simulationszeit, drehzahlabhängig, < 1 mm)
  if (s.onGround && s.engineRunning && s.rpm > 300) {
    const r = clamp(s.rpm / 2700, 0, 1.2);
    const a = HEAD.vibAmp * strength * (0.35 + 0.65 * r);
    const f1 = 6 + s.rpm / 300, t = s.time;
    z += a * 0.6 * Math.sin(2 * Math.PI * f1 * t);
    y += a * 0.3 * Math.sin(2 * Math.PI * f1 * 1.37 * t + 1.1);
  }
  // Ausgabe skaliert, weich begrenzt (Betrag ≤ 2 cm)
  const l = Math.hypot(x, y, z);
  if (l > 1e-9) {
    const sc = soft(l, HEAD.maxOffset) / l;
    x *= sc;
    y *= sc;
    z *= sc;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  // Kopf nickt mit dem Längsversatz (nach vorn → Blick nach unten) und neigt sich zur Seite des Versatzes
  out.pitch = soft(-x * HEAD.rotPerM, HEAD.maxRot);
  out.roll = soft(y * HEAD.rotPerM, HEAD.maxRot);
  return out;
}
