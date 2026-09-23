// Robustheit (SPEC §4.1): deterministischer Fuzz-Test der Physik. Viele Episoden mit zufälligen Steuerfolgen
// (inkl. ungültiger Werte wie über SIM.setControls), Umwelt (Wind 0–35 kt, Turbulenz 0–100 %, Masse 800–1089 kg),
// Szenarien, Klappen, Zündung OFF/START, erzwungenen Extremlagen, Crash + Weiterrechnen + Reset. Nach JEDEM Schritt
// müssen alle numerischen Zustandsfelder endlich sein. Dazu der Physik-Watchdog (Crash-Grund 'numerical').
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, qFromEuler } from '../js/sim/math.js';
import { stepAircraft, setMass, createAircraft, createControls, CRASH_TEXT } from '../js/sim/aircraft.js';
import { applyScenario } from '../js/sim/scenarios.js';
import { createAtmosphere, setAtmosphereFromEnv } from '../js/sim/atmosphere.js';
import { worldGround, groundHeight, AIRPORT } from '../js/world/heightfield.js';
import { DT } from './pilot.mjs';

/** Pfad des ersten nicht-endlichen Zahlenwerts in o (rekursiv) oder null. */
function nonFinite(o, path) {
  if (typeof o === 'number') return Number.isFinite(o) ? null : path;
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const b = nonFinite(o[i], `${path}[${i}]`);
      if (b) return b;
    }
    return null;
  }
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      const b = nonFinite(o[k], `${path}.${k}`);
      if (b) return b;
    }
  }
  return null;
}
const checkAll = (ac) => nonFinite(ac.state, 'state') || nonFinite(ac.atm.gust, 'gust') || nonFinite(ac.atm.gustP, 'gustP');

test('Fuzz: zufällige Steuerfolgen, Umwelt, Szenarien, Extremlagen, Crash/Reset → Zustand bleibt immer endlich', () => {
  const rng = mulberry32(20260923);
  const R = (a, b) => a + (b - a) * rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const GARBAGE = [undefined, NaN, Infinity, -Infinity, 'x', null];
  const AXES = ['elevator', 'aileron', 'rudder', 'throttle', 'trim', 'flapsCmd', 'brakeL', 'brakeR'];
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => warnings++; // der Watchdog darf melden – hier zählt nur, dass nichts NaN wird
  let steps = 0, crashes = 0, resets = 0, garbage = 0, numerical = 0;
  try {
    for (let ep = 0; ep < 80; ep++) {
      const atm = createAtmosphere({ seed: 1 + ep });
      const ac = createAircraft({ ground: worldGround, atmosphere: atm, mass: R(800, 1089) });
      const ctl = createControls();
      const env = { windDir: R(0, 360), windKt: R(0, 35), turbulence: R(0, 100), qnh: R(960, 1040) };
      setAtmosphereFromEnv(atm, env);
      applyScenario(ac, pick(['runway', 'final', 'cruise']), ctl);
      let bad = checkAll(ac);
      assert.equal(bad, null, `Episode ${ep}: nach applyScenario nicht endlich: ${bad}`);
      for (let i = 0; i < 30 * 120; i++) {
        if (i % 60 === 0) {
          if (rng() < 0.5) {
            ctl.elevator = R(-1, 1);
            ctl.aileron = R(-1, 1);
            ctl.rudder = R(-1, 1);
          } else if (rng() < 0.2) {
            ctl.elevator = pick([-1, 1]);
            ctl.aileron = pick([-1, 1]);
            ctl.rudder = pick([-1, 1]);
          }
          if (rng() < 0.1) ctl.throttle = pick([0, 1, R(0, 1)]);
          if (rng() < 0.05) ctl.flapsCmd = Math.floor(R(0, 4));
          if (rng() < 0.03) ctl.ignition = pick(['OFF', 'BOTH', 'START']);
          if (rng() < 0.05) ctl.trim = R(-1, 1);
          if (rng() < 0.05) {
            ctl.brakeL = rng();
            ctl.brakeR = rng();
            ctl.parkingBrake = rng() < 0.2;
          }
          if (rng() < 0.03) {
            // ungültige Eingabe für einige Schritte, danach wieder gültig
            ctl[pick(AXES)] = pick(GARBAGE);
            garbage++;
          } else for (const k of AXES) if (typeof ctl[k] !== 'number' || !Number.isFinite(ctl[k])) ctl[k] = 0;
          if (rng() < 0.03) {
            env.windKt = R(0, 35);
            env.windDir = R(0, 360);
            env.turbulence = R(0, 100);
            setAtmosphereFromEnv(atm, env);
          }
          if (rng() < 0.03) atm.extraTurbulence = R(0, 0.3); // Wolke
          if (rng() < 0.01) setMass(ac, R(800, 1089));
          if (rng() < 0.04) {
            // Extremlage (Trudeln, Rückenflug, senkrecht), auch mit großer Fahrt oder großer Höhe
            const s = ac.state;
            s.q = qFromEuler(R(0, 6.28), R(-1.57, 1.57), R(-3.14, 3.14));
            s.w = [R(-8, 8), R(-8, 8), R(-8, 8)];
            if (rng() < 0.5) s.v = [R(-90, 90), R(-90, 90), R(-90, 90)];
            if (rng() < 0.2) s.p[1] += R(0, 4000);
          }
          if (rng() < 0.01 || (ac.state.crashed && rng() < 0.5)) {
            applyScenario(ac, pick(['runway', 'final', 'cruise']), ctl);
            resets++;
          }
        }
        stepAircraft(ac, ctl, DT);
        steps++;
        if (ac.state.crashed) crashes++;
        if (ac.state.crashReason === 'numerical') numerical++;
        bad = checkAll(ac);
        if (bad) assert.fail(`Episode ${ep}, Schritt ${i}: ${bad} nicht endlich (Controls ${JSON.stringify(ctl)})`);
      }
    }
  } finally {
    console.warn = warn;
  }
  if (process.env.AK_REPORT) console.log('[Fuzz]', JSON.stringify({ steps, crashes, resets, garbage, numerical, warnings }));
  assert.ok(garbage > 20 && resets > 20 && crashes > 0, 'Fuzz deckt ungültige Eingaben, Resets und Crashs ab');
  assert.equal(numerical, 0, 'ungültige Eingaben werden neutral behandelt, nicht als numerischer Crash');
});

test('Watchdog: nicht-endlicher Zustand → Crash "numerical", einmal geloggt, Zustand endlich, Neustart sauber', () => {
  const ac = createAircraft({ ground: worldGround, atmosphere: createAtmosphere() });
  const ctl = createControls();
  applyScenario(ac, 'cruise', ctl);
  const s = ac.state;
  const p0 = s.p.slice();
  const logs = [];
  const warn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    s.w[1] = NaN; // z. B. Speicherfehler/fehlerhafte Eingabe von außen
    for (let i = 0; i < 240; i++) stepAircraft(ac, ctl, DT);
  } finally {
    console.warn = warn;
  }
  assert.equal(s.crashed, true);
  assert.equal(s.crashReason, 'numerical');
  assert.ok(CRASH_TEXT.numerical, 'Crash-Text vorhanden');
  assert.equal(logs.length, 1, `genau eine Meldung: ${logs}`);
  assert.equal(checkAll(ac), null, `Zustand endlich: ${checkAll(ac)}`);
  assert.ok(Math.hypot(s.p[0] - p0[0], s.p[1] - p0[1], s.p[2] - p0[2]) < 1, 'letzte gültige Position');
  assert.ok(Number.isFinite(s.pitch_deg + s.bank_deg + s.ias_kt + s.heading_deg + s.g));
  // Atmosphäre (Böen) ebenfalls vergiftet → wird beim Watchdog neutralisiert
  applyScenario(ac, 'cruise', ctl);
  assert.equal(s.crashed, false);
  ac.atm.gust[2] = NaN;
  console.warn = () => {};
  try {
    for (let i = 0; i < 10; i++) stepAircraft(ac, ctl, DT);
  } finally {
    console.warn = warn;
  }
  assert.equal(s.crashReason, 'numerical');
  assert.equal(checkAll(ac), null);
  // am Boden (Radzustände, Radrotation, Bugradlenkung) ebenso
  applyScenario(ac, 'runway', ctl);
  ctl.throttle = 1;
  ctl.parkingBrake = false;
  for (let i = 0; i < 240; i++) stepAircraft(ac, ctl, DT);
  s.v[0] = Infinity;
  console.warn = () => {};
  try {
    for (let i = 0; i < 10; i++) stepAircraft(ac, ctl, DT);
  } finally {
    console.warn = warn;
  }
  assert.equal(s.crashReason, 'numerical');
  assert.equal(checkAll(ac), null, `am Boden: ${checkAll(ac)}`);
  // auch reine Darstellungswerte (Propellerwinkel) werden erkannt und bereinigt
  applyScenario(ac, 'cruise', ctl);
  s.propAngle = NaN;
  console.warn = () => {};
  try {
    stepAircraft(ac, ctl, DT);
  } finally {
    console.warn = warn;
  }
  assert.equal(s.crashReason, 'numerical');
  assert.equal(checkAll(ac), null, `Propellerwinkel: ${checkAll(ac)}`);
  // vergiftete Position wird VOR der Geländeabfrage erkannt: der Höhen-Cache bleibt intakt
  for (const bad of [['p', 0, NaN], ['p', 2, Infinity], ['time', null, NaN]]) {
    applyScenario(ac, 'cruise', ctl);
    const pOk = s.p.slice();
    if (bad[1] === null) s[bad[0]] = bad[2];
    else s[bad[0]][bad[1]] = bad[2];
    console.warn = () => {};
    try {
      stepAircraft(ac, ctl, DT);
    } finally {
      console.warn = warn;
    }
    assert.equal(s.crashReason, 'numerical', `${bad}`);
    assert.equal(checkAll(ac), null, `${bad}: ${checkAll(ac)}`);
    assert.ok(Math.hypot(s.p[0] - pOk[0], s.p[2] - pOk[2]) < 1, `${bad}: Position ${s.p}`);
    assert.equal(groundHeight(0, 0), AIRPORT.elevation, `${bad}: Geländecache vergiftet`);
  }
  // endliche, aber überlaufende Quaternion (Norm = ∞) darf nicht als „gültig“ übernommen werden
  applyScenario(ac, 'cruise', ctl);
  s.q = [1e308, 1e308, 1e308, 1e308];
  console.warn = () => {};
  try {
    stepAircraft(ac, ctl, DT);
  } finally {
    console.warn = warn;
  }
  assert.equal(s.crashReason, 'numerical');
  assert.ok(Math.abs(Math.hypot(...s.q) - 1) < 1e-9, `Quaternion normiert: ${s.q}`);
  // Neustart liefert einen sauberen, fliegbaren Zustand
  applyScenario(ac, 'runway', ctl);
  assert.equal(s.crashed, false);
  assert.equal(s.crashReason, null);
  for (let i = 0; i < 240; i++) stepAircraft(ac, ctl, DT);
  assert.equal(s.crashed, false);
  assert.equal(checkAll(ac), null);
});
