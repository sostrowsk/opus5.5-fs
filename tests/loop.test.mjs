// AK-33 Determinismus über Renderraten und AK-34 Render-Interpolation – Hauptschleife (js/sim/loop.js) mit
// künstlicher Uhr, Eingabe über die echte Demand-Schicht (js/input/input.js, ohne DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, PHYS_DT, MAX_SUBSTEPS } from '../js/sim/loop.js';
import { stepAircraft } from '../js/sim/aircraft.js';
import { applyScenario } from '../js/sim/scenarios.js';
import { createInput } from '../js/input/input.js';
import { setup } from './pilot.mjs';

const report = (ak, values) => {
  if (process.env.AK_REPORT) console.log(`[${ak}]`, JSON.stringify(values, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
};

// Aufgezeichnete Eingabefolge (Physikschritt → Tastenereignis): Parkbremse lösen, Vollgas, Rollen mit
// Rotieren, Steigflug mit Querruder-, Trimm- und Klappeneingaben (Seitenruder: aufgezeichnete Analogfolge).
const s2n = (sec) => Math.round(sec / PHYS_DT);
const EVENTS = [
  [s2n(0.5), 'press', 'KeyB', 'B', true], // Shift+B: Parkbremse lösen
  [s2n(0.6), 'release', 'KeyB'],
  [s2n(1.0), 'press', 'Equal', '+', true], // Shift++: Vollgas
  [s2n(1.1), 'release', 'Equal'],
  [s2n(18.0), 'press', 'ArrowDown'],
  [s2n(18.3), 'release', 'ArrowDown'],
  [s2n(35.0), 'press', 'ArrowLeft'],
  [s2n(35.3), 'release', 'ArrowLeft'],
  [s2n(37.0), 'press', 'ArrowRight'],
  [s2n(37.3), 'release', 'ArrowRight'],
  [s2n(42.0), 'press', 'KeyG'], // Trimmung Nase hoch
  [s2n(42.5), 'release', 'KeyG'],
  [s2n(50.0), 'press', 'KeyV'], // Klappen 10
  [s2n(50.1), 'release', 'KeyV'],
];

/**
 * 60 s `runway`-Start mit Wind und Böen; frameDt = simuliertes Renderintervall. Liefert den Zustand nach N Schritten.
 * rudder: aufgezeichnete Seitenruder-Folge (je Physikschritt, analog wie der Touch-Slider). Ohne Aufzeichnung
 * lenkt ein einfacher Regler auf Kurs 270 und die Folge wird aufgezeichnet.
 */
function runAt(frameDt, rudder = null, N = s2n(60)) {
  const rec = [];
  const { ac, ctl, s } = setup({ mass: 1000, atm: { windDir: 240, windKt: 8, turbulence: 0.2 } });
  applyScenario(ac, 'runway', ctl);
  const input = createInput({ controls: ctl, target: null, settings: {}, getState: () => s });
  let k = 0, ev = 0, snap = null;
  const loop = createLoop({
    step() {
      if (snap) return;
      while (ev < EVENTS.length && EVENTS[ev][0] === k) {
        const [, kind, code, key = '', shift = false] = EVENTS[ev++];
        if (kind === 'press') input.press(code, key, shift);
        else input.release(code);
      }
      let r;
      if (rudder) r = rudder[k];
      else {
        const e = ((((270 - s.heading_deg) % 360) + 540) % 360) - 180;
        r = s.onGround ? Math.max(-1, Math.min(1, 0.15 * e - 0.02 * (s.w[2] * 180) / Math.PI)) : 0;
        rec.push(r);
      }
      input.setRudder(r);
      input.update(PHYS_DT);
      stepAircraft(ac, ctl, PHYS_DT);
      k++;
      if (k === N) snap = JSON.parse(JSON.stringify({ p: s.p, v: s.v, q: s.q, w: s.w, rpm: s.rpm, act: s.act, ctl }));
    },
  });
  let frames = 0;
  while (!snap && frames < 1e6) {
    loop.advance(frameDt);
    frames++;
  }
  return { snap, frames, dropped: loop.droppedSteps, rec };
}

test('AK-33 Determinismus: 60 s runway-Start bei 1/30, 1/60, 1/144 s Renderintervall bit-identisch', () => {
  const rec = runAt(1 / 60).rec; // Aufzeichnung
  const a = runAt(1 / 30, rec), b = runAt(1 / 60, rec), c = runAt(1 / 144, rec);
  report('AK-33', { frames: [a.frames, b.frames, c.frames], x: a.snap.p[0], alt: a.snap.p[1], rpm: a.snap.rpm });
  assert.ok(a.snap && b.snap && c.snap);
  assert.equal(a.dropped + b.dropped + c.dropped, 0);
  const same = (x, y, path = '') => {
    if (typeof x === 'number') return assert.ok(Object.is(x, y), `${path}: ${x} ≠ ${y}`);
    if (typeof x !== 'object' || x === null) return assert.equal(x, y, path);
    for (const key of Object.keys(x)) same(x[key], y[key], `${path}.${key}`);
  };
  same(a.snap, b.snap, '1/30↔1/60');
  same(a.snap, c.snap, '1/30↔1/144');
  assert.ok(a.snap.p[1] > 450 + 30, 'nach 60 s in der Luft');
});

test('Hauptschleife: höchstens 8 Substeps pro Frame, Überschuss verworfen und gezählt', () => {
  let n = 0;
  const loop = createLoop({ step: () => n++ });
  const r = loop.advance(0.2); // 24 Schritte fällig
  assert.equal(r.n, MAX_SUBSTEPS);
  assert.equal(loop.droppedSteps, 24 - MAX_SUBSTEPS);
  assert.ok(r.alpha >= 0 && r.alpha <= 1);
  loop.advance(10); // riesiges Intervall (Tab war im Hintergrund) → gekappt
  assert.equal(n, 2 * MAX_SUBSTEPS);
  loop.reset();
  assert.equal(loop.advance(0).n, 0);
});

test('AK-34 Render-Interpolation: 144-Hz-Uhr, Geradeausflug → monotone, gleichmäßige Positionsinkremente', () => {
  const { ac, ctl, s } = setup({ mass: 1000 });
  applyScenario(ac, 'cruise', ctl);
  const prev = s.p.slice();
  const loop = createLoop({
    step(i, n) {
      if (i === n - 1) prev.splice(0, 3, ...s.p); // Zustand vor dem letzten Schritt merken
      stepAircraft(ac, ctl, PHYS_DT);
    },
  });
  const xs = [];
  let alphaOk = true;
  for (let f = 0; f < 144 * 3; f++) {
    const { alpha } = loop.advance(1 / 144);
    if (!(alpha >= 0 && alpha <= 1)) alphaOk = false;
    const x = prev[0] + (s.p[0] - prev[0]) * alpha; // gerenderte Position (Kurs 270 → x nimmt ab)
    // liegt zwischen den letzten beiden Physikzuständen
    if ((x - prev[0]) * (x - s.p[0]) > 1e-9) alphaOk = false;
    xs.push(x);
  }
  const inc = xs.slice(1).map((x, i) => xs[i] - x); // > 0
  const mean = inc.reduce((a, b) => a + b, 0) / inc.length;
  const sd = Math.sqrt(inc.reduce((a, b) => a + (b - mean) ** 2, 0) / inc.length);
  report('AK-34', { mean_m: mean, cv: sd / mean, min: Math.min(...inc), max: Math.max(...inc) });
  assert.ok(alphaOk, 'α außerhalb [0, 1] oder Pose nicht zwischen den letzten beiden Zuständen');
  assert.ok(inc.every((d) => d > 0), 'Rückwärts- oder Doppelschritt');
  assert.ok(sd / mean < 0.1, `Varianz der Inkremente ${(100 * sd / mean).toFixed(1)} %`);
});
