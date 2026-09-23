// AK-37 Kopfbewegung (js/cockpit/head.js): ≤ 2 cm / ≤ 1° auch bei harter Landung (600 ft/min) und Turbulenz 100 %,
// Rückkehr binnen 2 s nach Ende der Anregung auf < 1 mm, bei 0 % exakt 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG, qFromEuler } from '../js/sim/math.js';
import { stepAircraft } from '../js/sim/aircraft.js';
import { applyScenario, trimAircraft } from '../js/sim/scenarios.js';
import { AIRPORT } from '../js/world/heightfield.js';
import { C172 } from '../js/sim/c172.js';
import { createHead, stepHead, HEAD } from '../js/cockpit/head.js';
import { setup, DT } from './pilot.mjs';

const report = (ak, values) => {
  if (process.env.AK_REPORT) console.log(`[${ak}]`, JSON.stringify(values, (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v)));
};
const mag = (o) => Math.hypot(o.x, o.y, o.z);

function track(ac, ctl, strength, seconds, cb) {
  const h = createHead();
  const r = { maxOff: 0, maxRot: 0, series: [] };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    cb?.(ac.state, i * DT);
    stepAircraft(ac, ctl, DT);
    const o = stepHead(h, ac.state, strength, DT);
    r.maxOff = Math.max(r.maxOff, mag(o));
    r.maxRot = Math.max(r.maxRot, Math.abs(o.pitch), Math.abs(o.roll));
    r.series.push({ t: i * DT, off: mag(o), o: { ...o }, onGround: ac.state.onGround });
  }
  return r;
}

test('AK-37 Kopfbewegung: Turbulenz 100 % → ≤ 2 cm und ≤ 1°; bei 0 % exakt 0', () => {
  const run = (strength) => {
    const { ac, ctl } = setup({ atm: { turbulence: 1 } });
    applyScenario(ac, 'cruise', ctl);
    return track(ac, ctl, strength, 60);
  };
  const full = run(1), off = run(0);
  report('AK-37 Turbulenz', { maxOff_cm: full.maxOff * 100, maxRot_deg: full.maxRot / DEG });
  assert.ok(full.maxOff > 0.001, 'Turbulenz bewegt den Kopf spürbar');
  assert.ok(full.maxOff <= HEAD.maxOffset, `Versatz ${(full.maxOff * 100).toFixed(2)} cm`);
  assert.ok(full.maxRot <= 1 * DEG, `Drehung ${(full.maxRot / DEG).toFixed(2)}°`);
  assert.ok(off.series.every((e) => e.o.x === 0 && e.o.y === 0 && e.o.z === 0 && e.o.pitch === 0 && e.o.roll === 0));
});

test('AK-37 Kopfbewegung: harte Landung 600 ft/min → ≤ 2 cm / ≤ 1°, danach zurück auf < 1 mm', () => {
  const { ac, ctl, s } = setup();
  const tr = trimAircraft(ac, { x: 300, z: 0, alt: AIRPORT.elevation + C172.cgRestHeight + 0.3, heading: 270, kias: 55, flapsDeg: 30, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged);
  ctl.throttle = 0;
  const V = Math.hypot(...s.v);
  // Hauptfahrwerk zuerst (Abfanglage 4°), Sinken so, dass ≈ 600–650 ft/min beim Aufsetzen anliegen
  const gam = -Math.asin((800 * 0.3048) / 60 / V);
  s.q = qFromEuler(270 * DEG, 4 * DEG, 0);
  s.v = [-V * Math.cos(gam), V * Math.sin(gam), 0];
  let tdVs = null, tdT = 0;
  const r = track(ac, ctl, 1, 30, (st, t) => {
    if (tdVs === null && st.onGround) (tdVs = st.vs_fpm), (tdT = t);
    // nach dem Aufsetzen ausbremsen bis zum Stand → Ende der Anregung
    if (tdVs !== null && t > tdT + 3) ctl.brakeL = ctl.brakeR = 0.6;
    ctl.elevator = 0;
  });
  assert.ok(!s.crashed, `Crash ${s.crashReason}`);
  assert.ok(tdVs !== null && -tdVs >= 550, `Sinkrate beim Aufsetzen ${tdVs}`);
  // Ende der Anregung: Flugzeug steht (Motor läuft im Leerlauf weiter → Vibration < 1 mm zulässig)
  assert.ok(Math.hypot(...s.v) < 0.05, 'steht am Ende');
  const tail = r.series.filter((e) => e.t >= 27);
  const lastMax = Math.max(...tail.map((e) => e.off));
  report('AK-37 Landung', { tdVs, maxOff_cm: r.maxOff * 100, maxRot_deg: r.maxRot / DEG, rest_mm: lastMax * 1000 });
  assert.ok(r.maxOff > 0.005, 'Aufsetzstoß ist spürbar');
  assert.ok(r.maxOff <= HEAD.maxOffset, `Versatz ${(r.maxOff * 100).toFixed(2)} cm`);
  assert.ok(r.maxRot <= 1 * DEG, `Drehung ${(r.maxRot / DEG).toFixed(2)}°`);
  assert.ok(lastMax < 0.001, `Rest ${(lastMax * 1000).toFixed(2)} mm im Stand`);
});

test('AK-37 Kopfbewegung: Rückkehr binnen 2 s nach einem 3-g-Stoß auf < 1 mm', () => {
  const h = createHead();
  const st = { v: [0, 0, -50], q: qFromEuler(0, 0, 0), time: 0, onGround: false, engineRunning: true, rpm: 2400, crashed: false };
  let max = 0, after = 0;
  for (let i = 0; i < 600; i++) {
    const t = i * DT;
    if (t >= 1 && t < 1.25) st.v[1] += 2 * 9.81 * DT; // 0,25 s Zusatzlast +2 g (3 g gesamt)
    st.time = t;
    const o = stepHead(h, st, 1, DT);
    max = Math.max(max, mag(o));
    if (t >= 1.25 + 2) after = Math.max(after, mag(o));
  }
  report('AK-37 Stoß', { max_cm: max * 100, after2s_mm: after * 1000 });
  assert.ok(max <= HEAD.maxOffset && max > 0.005);
  assert.ok(after < 0.001, `nach 2 s noch ${(after * 1000).toFixed(3)} mm`);
});
