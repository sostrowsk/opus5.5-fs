// Klang-Abbildung (SPEC §3.8, AK-29) – reine Funktionen, ohne WebAudio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioParams, detectEvents, fourier, engineWaves } from '../js/audio/audio.js';

const base = (o = {}) => ({
  rpm: 2400, engineRunning: true, thrEff: 0.75, tas_kt: 110, ias_kt: 105, beta_deg: 0, stallWarning: false,
  wheelContact: [false, false, false], gearCompression: [0, 0, 0], gs_kt: 110, surface: 'grass', warnings: [],
  crashed: false, propBroken: false, flapsDeg: 0, v: [0, 0, 0], ...o,
});

test('Motor: Zündfrequenz = RPM/30 (4 Zyl., Viertakt), Oszillator auf dem Arbeitsspiel RPM/120', () => {
  for (const rpm of [700, 1500, 2400, 2700]) {
    const p = audioParams(base({ rpm }), {});
    assert.equal(p.firingHz, rpm / 30);
    assert.equal(p.cycleHz * 4, p.firingHz);
    assert.ok(Math.abs(p.jitterRate * 40 - p.firingHz) < 1e-9);
  }
});

test('Motor: Last macht den Klang härter und lauter, Leerlauf rauer', () => {
  const idle = audioParams(base({ rpm: 700, thrEff: 0 }), {});
  const full = audioParams(base({ rpm: 2400, thrEff: 1 }), {});
  assert.ok(full.load > 0.95 && idle.load < 0.2);
  assert.ok(full.hardGain > 0.9 && idle.hardGain < 0.1);
  assert.ok(full.engCutoff > 3 * idle.engCutoff);
  assert.ok(full.engGain > idle.engGain);
  assert.ok(idle.rough > full.rough, 'Leerlauf unrund');
  const off = audioParams(base({ engineRunning: false, rpm: 900 }), {}); // Windmilling
  assert.equal(off.engGain, 0);
  assert.ok(off.propGain > 0 && off.crankGain > 0);
});

test('Anlasser nur bei START, Wind steigt mit IAS, Horn nur bei Stall-Warnung', () => {
  const crank = audioParams(base({ engineRunning: false, rpm: 200, ias_kt: 0 }), { ignition: 'START' });
  assert.ok(crank.starterGain > 0 && crank.crankGain > 0.3);
  assert.equal(audioParams(base(), { ignition: 'BOTH' }).starterGain, 0);
  let prev = -1;
  for (const ias of [0, 30, 60, 90, 120, 150]) {
    const w = audioParams(base({ ias_kt: ias }), {}).windGain;
    assert.ok(w > prev || (ias === 0 && w === 0));
    prev = w;
  }
  assert.equal(audioParams(base(), {}).hornGain, 0);
  assert.ok(audioParams(base({ stallWarning: true }), {}).hornGain > 0);
  assert.ok(audioParams(base({ warnings: ['VNE'] }), {}).warnGain > 0);
  const p = audioParams(base(), {}, { paused: true });
  assert.equal(p.master, 0);
  const c = audioParams(base({ crashed: true }), {});
  assert.equal(c.engGain + c.propGain + c.windGain + c.hornGain, 0);
});

test('Ereignisse: Aufsetzen → Stoß + Quietschen (Asphalt), Crash einmalig', () => {
  const mem = {};
  detectEvents(base({ v: [0, -1.5, 0], gs_kt: 60, surface: 'asphalt' }), mem, 1 / 60);
  const ev = detectEvents(base({ v: [0, -0.2, 0], gs_kt: 60, surface: 'asphalt', wheelContact: [false, true, true] }), mem, 1 / 60);
  const names = ev.map((e) => e[0]);
  assert.equal(names.filter((n) => n === 'thump').length, 2);
  assert.equal(names.filter((n) => n === 'screech').length, 2);
  assert.ok(ev.every(([, l]) => l > 0 && l <= 1));
  const c1 = detectEvents(base({ crashed: true }), mem, 1 / 60);
  const c2 = detectEvents(base({ crashed: true }), mem, 1 / 60);
  assert.deepEqual(c1.map((e) => e[0]), ['crash']);
  assert.equal(c2.length, 0);
});

test('Motorwelle: Zündfrequenz dominiert, halbe Ordnungen vorhanden (kein reiner Synth-Ton)', () => {
  const w = engineWaves(64).soft;
  const mag = (k) => Math.hypot(w.real[k], w.imag[k]);
  // Harmonische 4 (Zündfrequenz) stärker als die Arbeitsspiel-Ordnungen 1–3 …
  for (const k of [1, 2, 3]) assert.ok(mag(4) > 2 * mag(k), `k=${k}`);
  // … diese aber deutlich vorhanden (Zylinder-Unterschiede)
  assert.ok(mag(1) + mag(2) + mag(3) > 0.08 * mag(4));
  // Fourier-Kontrolle mit einem reinen Kosinus
  const f = fourier((u) => Math.cos(2 * Math.PI * 3 * u), 5, 256);
  assert.ok(Math.abs(f.real[3] - 1) < 1e-9 && Math.abs(f.real[2]) < 1e-9);
});
