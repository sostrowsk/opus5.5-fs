// Demand-Schicht der Eingabe (SPEC §4.4, AK-26, AK-35) – ohne DOM: Tastenereignisse als einfache Objekte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInput, RAMP_UP, RAMP_BACK, TRIM_RATE, THROTTLE_RATE } from '../js/input/input.js';
import { createControls } from '../js/sim/aircraft.js';

const DT = 1 / 120;
function setup(extra = {}) {
  const controls = createControls();
  const lights = { landing: false, nav: false, strobe: false, beacon: false };
  const calls = [];
  const settings = { invertElevator: false, coordAssist: false, ...extra.settings };
  const actions = new Proxy({}, { get: (_, k) => (arg) => calls.push(arg === undefined ? k : `${k}:${arg}`) });
  const input = createInput({ controls, lights, actions, settings, target: null, getState: extra.getState });
  const key = (code, o = {}) => ({ code, key: o.key ?? '', shiftKey: !!o.shift, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const down = (code, o) => input.onKeyDown(key(code, o));
  const up = (code) => input.onKeyUp(key(code));
  const run = (s) => {
    for (let i = 0; i < Math.round(s / DT); i++) input.update(DT);
  };
  return { controls, lights, calls, settings, input, down, up, run };
}

test('Ruder-Rampe: 1,5/s hoch, 3/s zurück auf 0 (SPEC §4.4)', () => {
  const t = setup();
  t.down('ArrowLeft');
  t.run(0.4);
  assert.ok(Math.abs(t.controls.aileron + RAMP_UP * 0.4) < 0.01, `aileron ${t.controls.aileron}`);
  t.run(1);
  assert.equal(t.controls.aileron, -1);
  t.up('ArrowLeft');
  t.run(0.2);
  assert.ok(Math.abs(t.controls.aileron + 1 - RAMP_BACK * 0.2) < 0.01, `aileron ${t.controls.aileron}`);
  t.run(0.2);
  assert.equal(t.controls.aileron, 0);
  // Höhenruder: ↓ = ziehen (+), ↑ = drücken (−); Seitenruder Z/X bzw. , .
  t.down('ArrowDown');
  t.run(0.2);
  assert.ok(t.controls.elevator > 0.25);
  t.up('ArrowDown');
  t.down('KeyX');
  t.run(0.2);
  assert.ok(t.controls.rudder > 0.25);
  t.up('KeyX');
  t.down('Comma');
  t.run(0.5);
  assert.ok(t.controls.rudder < -0.3);
});

test('Invertiertes Höhenruder', () => {
  const t = setup({ settings: { invertElevator: true } });
  t.down('ArrowUp');
  t.run(0.3);
  assert.ok(t.controls.elevator > 0.3);
});

test('Trimmung ist ein eigener Kanal, Yoke bleibt 0', () => {
  const t = setup();
  t.down('KeyG');
  t.run(1);
  t.up('KeyG');
  assert.ok(Math.abs(t.controls.trim - TRIM_RATE) < 0.01);
  assert.equal(t.controls.elevator, 0);
  t.down('Home');
  t.run(2);
  t.up('Home');
  assert.ok(Math.abs(t.controls.trim + TRIM_RATE) < 0.01);
});

test('Gas, Klappen, Bremsen, Lichter, Zündung, Ansichten (AK-26)', () => {
  const t = setup();
  t.down('PageUp');
  t.run(1);
  t.up('PageUp');
  assert.ok(Math.abs(t.controls.throttle - THROTTLE_RATE) < 0.01);
  t.down('ShiftLeft');
  t.down('BracketRight', { key: '*', shift: true });
  assert.equal(t.controls.throttle, 1);
  t.up('BracketRight');
  t.down('Slash', { key: '_', shift: true });
  assert.equal(t.controls.throttle, 0);
  t.up('Slash');
  t.down('KeyB', { shift: true });
  assert.equal(t.controls.parkingBrake, true);
  t.up('KeyB');
  t.up('ShiftLeft');
  t.down('KeyB');
  t.run(0.1);
  assert.equal(t.controls.brakeL, 1);
  assert.equal(t.controls.brakeR, 1);
  t.up('KeyB');
  t.down('KeyN');
  t.run(0.1);
  assert.equal(t.controls.brakeL, 1);
  assert.equal(t.controls.brakeR, 0);
  t.up('KeyN');
  t.down('KeyV');
  t.up('KeyV');
  t.down('F6');
  t.up('F6');
  assert.equal(t.controls.flapsCmd, 2);
  t.down('KeyF');
  t.up('KeyF');
  assert.equal(t.controls.flapsCmd, 1);
  t.down('KeyL');
  t.down('KeyO');
  assert.equal(t.lights.landing, true);
  assert.equal(t.lights.nav && t.lights.strobe, true);
  // Zündung: Tipp BOTH → OFF → BOTH, halten → START, loslassen → BOTH
  t.down('KeyI');
  t.run(0.1);
  t.up('KeyI');
  assert.equal(t.controls.ignition, 'OFF');
  t.down('KeyI');
  t.run(0.5);
  assert.equal(t.controls.ignition, 'START');
  t.up('KeyI');
  assert.equal(t.controls.ignition, 'BOTH');
  for (const k of ['KeyC', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Space', 'KeyH', 'KeyP', 'KeyR']) {
    t.down(k);
    t.up(k);
  }
  t.down('Minus', { key: '?', shift: true });
  assert.deepEqual(t.calls, ['toggleExternal', 'view:front', 'view:left', 'view:right', 'view:panel', 'center', 'toggleHud', 'pause', 'reset', 'help']);
});

test('Fokusverlust: clearAll setzt Ruder sofort auf 0 (AK-35)', () => {
  const t = setup();
  t.down('ArrowLeft');
  t.down('KeyB');
  t.run(0.5);
  assert.ok(t.controls.aileron < -0.5);
  t.input.clearAll();
  assert.equal(t.controls.aileron, 0);
  assert.equal(t.controls.brakeL, 0);
  t.run(0.5); // nach dem Fortsetzen: Taste gilt als losgelassen
  assert.equal(t.controls.aileron, 0);
  assert.equal(t.input.keys.size, 0);
});

test('Quellen: zuletzt aktive gewinnt; Touch-Stick setzt beim Loslassen 0 (AK-28)', () => {
  const t = setup();
  t.input.setStick('touch', 0.5, -0.4);
  t.run(0.05);
  assert.equal(t.controls.elevator, 0.5);
  assert.equal(t.controls.aileron, -0.4);
  t.input.setStick('touch', 0, 0);
  t.run(DT);
  assert.equal(t.controls.elevator, 0);
  assert.equal(t.controls.aileron, 0);
  t.input.setStick('mouse', 0.3, 0.2);
  t.run(0.1);
  assert.equal(t.controls.elevator, 0.3);
  t.down('ArrowRight'); // Tastatur übernimmt, Rampe startet an der Mausposition
  t.run(0.1);
  assert.ok(t.controls.aileron > 0.3);
  t.input.setRudder(-0.6);
  t.run(DT);
  assert.equal(t.controls.rudder, -0.6);
  t.input.setRudder(0);
  t.run(DT);
  assert.equal(t.controls.rudder, 0);
});

test('Gesperrt (Menü offen): Tasten ändern controls nicht (AK-38)', () => {
  const t = setup();
  t.input.setBlocked(true);
  t.down('ArrowLeft');
  t.down('KeyV');
  t.run(0.5);
  assert.equal(t.controls.aileron, 0);
  assert.equal(t.controls.flapsCmd, 0);
  t.input.setBlocked(false);
  t.down('KeyV');
  assert.equal(t.controls.flapsCmd, 1);
});

test('setControls-Suspend: erst echter Input übernimmt wieder', () => {
  const t = setup();
  t.down('ArrowLeft');
  t.up('ArrowLeft');
  t.input.suspend();
  t.controls.aileron = 0.7;
  t.run(0.5);
  assert.equal(t.controls.aileron, 0.7);
  t.down('ArrowRight');
  t.run(DT);
  assert.ok(t.controls.aileron > 0.7 - 0.05);
});

test('Koordinationshilfe: Seitenruder ∝ β nur über 30 m AGL, manuelles Ruder hat Vorrang', () => {
  const s = { beta_deg: 4, agl: 300, onGround: false, crashed: false };
  const t = setup({ settings: { coordAssist: true }, getState: () => s });
  t.run(DT);
  assert.ok(t.controls.rudder > 0.3, `rudder ${t.controls.rudder}`);
  t.down('KeyZ'); // Pedal wird aus der Hilfsstellung heraus übernommen, dann Rampe nach links
  t.run(0.5);
  assert.ok(t.controls.rudder < 0, 'manuelles Ruder gewinnt');
  t.up('KeyZ');
  t.run(1);
  s.agl = 10;
  t.run(DT);
  assert.equal(t.controls.rudder, 0);
});

test('Autorepeat nach clearAll löst Umschalter nicht erneut aus; Maus-Quelle freigeben', () => {
  const t = setup();
  t.input.onKeyDown({ code: 'KeyP', key: 'p', repeat: false, preventDefault() {} });
  t.input.clearAll(); // wie togglePause()
  t.input.onKeyDown({ code: 'KeyP', key: 'p', repeat: true, preventDefault() {} });
  assert.deepEqual(t.calls, ['pause']);
  t.input.setStick('mouse', 0.8, -0.8);
  t.run(DT);
  assert.equal(t.controls.elevator, 0.8);
  t.input.releaseSource('mouse');
  t.run(0.5);
  assert.equal(t.controls.elevator, 0);
  assert.equal(t.controls.aileron, 0);
});

test('Koordinationshilfe hinterlässt keinen Rest-Ausschlag (auch vor der ersten Eingabe)', () => {
  const s = { beta_deg: 4, agl: 300, onGround: false, crashed: false };
  const t = setup({ settings: { coordAssist: true }, getState: () => s });
  t.run(DT);
  assert.ok(t.controls.rudder > 0.5);
  s.agl = 10;
  t.run(DT);
  assert.equal(t.controls.rudder, 0);
  s.agl = 300;
  t.run(DT);
  t.settings.coordAssist = false;
  t.run(DT);
  assert.equal(t.controls.rudder, 0);
  t.input.setBlocked(true);
  t.input.flaps(1);
  assert.equal(t.controls.flapsCmd, 0);
});

test('Touch/Maus: nicht-endliche Stick-/Seitenruderwerte (entartetes Element-Rechteck) werden zu 0', () => {
  const t = setup();
  t.input.setStick('touch', NaN, -Infinity);
  t.run(DT);
  assert.equal(t.controls.elevator, 0);
  assert.equal(t.controls.aileron, 0);
  t.input.setRudder(NaN);
  t.run(DT);
  assert.equal(t.controls.rudder, 0);
  assert.ok(Number.isFinite(t.controls.elevator) && Number.isFinite(t.controls.aileron) && Number.isFinite(t.controls.rudder));
});
