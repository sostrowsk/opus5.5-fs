// Akzeptanzkriterien AK-01 … AK-18 (SPEC §8) headless gegen die reine Physik.
// Standard: 1089 kg, ISA, kein Wind, Turbulenz 0 (sofern nicht anders angegeben).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG, FT, KT, clamp, wrapPi, qFromEuler, bodyToThree } from '../js/sim/math.js';
import { stepAircraft, evalAirborne } from '../js/sim/aircraft.js';
import { windAt } from '../js/sim/atmosphere.js';
import { applyScenario, trimAircraft } from '../js/sim/scenarios.js';
import { flatGround, groundHeight, surface, isRunway, AIRPORT, WATER_LEVEL } from '../js/world/heightfield.js';
import { C172 } from '../js/sim/c172.js';
import { setup, run, createPilot, DT, mean, std } from './pilot.mjs';

// Messwerte ausgeben: AK_REPORT=1 node --test tests/
const report = (ak, values) => {
  if (process.env.AK_REPORT) console.log(`[${ak}]`, JSON.stringify(values, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
};
const inRange = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(2)} nicht in [${lo}, ${hi}]`);
const hdgErr = (target, h) => wrapPi((target - h) * DEG) / DEG;

/** Bodenlenkung per Seitenruder/Bugrad (Kurs halten auf der Piste). */
function steerOnGround(s, ctl, heading) {
  const e = hdgErr(heading, s.heading_deg);
  ctl.rudder = clamp(0.25 * e - 0.6 * s.w[2] / DEG * 0.1, -1, 1);
}

/** Stall-Versuch: Leerlauf, Fahrtabbau ~1 kt/s, Flügel gerade. Liefert KCAS/KIAS bei Horn und Abriss. */
function stallRun(flaps) {
  const { ac, ctl } = setup({ ground: flatGround(0) });
  const v0 = flaps ? 60 : 70;
  const tr = trimAircraft(ac, { x: 0, z: 0, alt: 1500, heading: 270, kias: v0, flapsDeg: flaps, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged, 'Trimmung für Stall-Versuch');
  ctl.throttle = 0;
  const p = createPilot({ speed: v0, heading: 270 });
  let horn = null, stall = null;
  let prevIas = ac.state.ias_kt, decel = [];
  run(ac, ctl, 120, (s, t) => {
    p.speed = v0 - Math.max(0, t - 2) * 1.0;
    p.update(s, ctl);
    if (t > 5 && !stall) decel.push((prevIas - s.ias_kt) / DT);
    prevIas = s.ias_kt;
    if (!horn && s.stallWarning) horn = { kcas: s.cas_kt, kias: s.ias_kt };
    if (!stall && s.stalled) {
      stall = { kcas: s.cas_kt, kias: s.ias_kt };
      return true;
    }
  });
  assert.ok(stall, 'kein Strömungsabriss erreicht');
  assert.ok(horn, 'Überziehwarnung hat nie angesprochen');
  return { horn, stall, decel: mean(decel) };
}

// ------------------------------------------------------------------------------------------ Start
test('AK-02 Standdrehzahl: Vollgas mit Bremse → nach 5 s 2300–2420 RPM', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  assert.ok(ctl.parkingBrake && s.onGround && !s.crashed);
  const x0 = s.p[0];
  ctl.throttle = 1;
  run(ac, ctl, 5);
  report('AK-02', { rpm: s.rpm });
  inRange(s.rpm, 2300, 2420, 'RPM nach 5 s');
  assert.ok(Math.abs(s.p[0] - x0) < 0.1, 'Bremse muss halten');
});

test('AK-01 Startlauf: Abheben bei 52–62 KIAS nach 250–420 m (Piste 27, Klappen 0, Rotation bei 55 KIAS)', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  assert.equal(s.flapsDeg, 0);
  assert.ok(Math.abs(s.alt_ft - 1476) < 10, `Platzhöhe ${s.alt_ft}`);
  ctl.throttle = 1;
  run(ac, ctl, 3); // Vollgas bei gesetzter Bremse
  ctl.parkingBrake = false;
  const x0 = s.p[0];
  let rotT = null, airT = 0, cand = null, lift = null;
  run(ac, ctl, 60, (s, t) => {
    steerOnGround(s, ctl, 270);
    if (rotT === null && s.ias_kt >= 55) rotT = t;
    if (rotT !== null) {
      // weiche Rotation: Nicklage-Ziel rampt mit 5°/s auf 10°
      const th = Math.min(10, (t - rotT) * 5) * DEG;
      ctl.elevator = clamp(8 * (th - s.pitch_deg * DEG) - 1.5 * s.w[1] + 0.1, -1, 1);
    }
    if (!s.onGround) {
      if (airT === 0) cand = { ias: s.ias_kt, dist: Math.abs(s.p[0] - x0) };
      airT += DT;
      if (airT >= 1) {
        lift = cand;
        return true;
      }
    } else airT = 0;
  });
  assert.ok(lift, 'nicht abgehoben');
  assert.ok(!s.crashed, `Crash: ${s.crashReason}`);
  report('AK-01', lift);
  inRange(lift.ias, 52, 62, 'Abhebegeschwindigkeit KIAS');
  inRange(lift.dist, 250, 420, 'Rollstrecke m');
});

test('AK-10 Propellereffekte: Startlauf Vollgas, Seitenruder neutral → Kursdrift nach links > 3° in 5 s', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  const h0 = s.heading_deg;
  ctl.throttle = 1;
  ctl.parkingBrake = false;
  ctl.rudder = 0;
  run(ac, ctl, 5);
  const drift = hdgErr(s.heading_deg, h0); // negativ = links
  report('AK-10', { drift });
  assert.ok(drift < -3, `Kursdrift ${drift.toFixed(2)}° (erwartet < −3°)`);
});

// ------------------------------------------------------------------------------------------ Flugleistungen
test('AK-03 Steigflug: Vollgas, Klappen 0, 76 KIAS, 2300–2700 ft Druckhöhe → 520–700 ft/min', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  const tr = trimAircraft(ac, { x: 0, z: 0, alt: 2100 * FT, heading: 270, kias: 76, flapsDeg: 0, throttle: 1 }, ctl);
  assert.ok(tr.converged);
  const p = createPilot({ speed: 76, heading: 270, ball: true });
  let t1 = null, t2 = null;
  const ias = [];
  run(ac, ctl, 300, (s, t) => {
    p.update(s, ctl);
    if (t1 === null && s.pressureAlt_ft >= 2300) t1 = t;
    if (t1 !== null) ias.push(s.ias_kt);
    if (t2 === null && s.pressureAlt_ft >= 2700) {
      t2 = t;
      return true;
    }
  });
  assert.ok(t1 !== null && t2 !== null, 'Messfenster nicht erreicht');
  const roc = 400 / ((t2 - t1) / 60);
  report('AK-03', { roc, ias: mean(ias) });
  assert.ok(Math.abs(mean(ias) - 76) < 1, `Fahrt nicht gehalten: ${mean(ias)}`);
  inRange(roc, 520, 700, 'Steigrate ft/min');
});

test('AK-04 Reiseflug: 4500 ft, Horizontalflug mit 2400 RPM → TAS 100–115 kt', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'cruise', ctl);
  const alt0 = s.p[1];
  const p = createPilot({ alt: alt0, heading: 270, ball: true, rpm: 2400 });
  p.setRpmIntegrator(ctl.throttle);
  const tas = [], rpm = [], dalt = [];
  run(ac, ctl, 300, (s, t) => {
    p.update(s, ctl);
    if (t > 270) {
      tas.push(s.tas_kt);
      rpm.push(s.rpm);
      dalt.push(s.p[1] - alt0);
    }
  });
  report('AK-04', { tas: mean(tas), rpm: mean(rpm), dalt: mean(dalt) });
  assert.ok(Math.abs(mean(rpm) - 2400) < 10, `RPM ${mean(rpm)}`);
  assert.ok(Math.abs(mean(dalt)) < 10, `Höhe nicht gehalten: ${mean(dalt)} m`);
  assert.ok(std(tas) < 0.5, 'TAS nicht stabil');
  inRange(mean(tas), 100, 115, 'Reiseflug-TAS kt');
});

test('AK-05 Stall clean: 47–54 KCAS (≈ 42–47 KIAS), Horn 5–10 kt vorher', () => {
  const r = stallRun(0);
  report('AK-05', { ...r, margin: r.horn.kcas - r.stall.kcas });
  assert.ok(r.decel > 0.6 && r.decel < 1.4, `Fahrtabbau ${r.decel.toFixed(2)} kt/s`);
  inRange(r.stall.kcas, 47, 54, 'Stall KCAS');
  inRange(r.stall.kias, 42, 47, 'Stall KIAS');
  inRange(r.horn.kcas - r.stall.kcas, 5, 10, 'Horn-Vorlauf kt');
});

test('AK-06 Stall Klappen 30: 42–49 KCAS (≈ 30–38 KIAS), Horn 5–10 kt vorher', () => {
  const r = stallRun(30);
  report('AK-06', { ...r, margin: r.horn.kcas - r.stall.kcas });
  assert.ok(r.decel > 0.6 && r.decel < 1.4, `Fahrtabbau ${r.decel.toFixed(2)} kt/s`);
  inRange(r.stall.kcas, 42, 49, 'Stall KCAS');
  inRange(r.stall.kias, 30, 38, 'Stall KIAS');
  inRange(r.horn.kcas - r.stall.kcas, 5, 10, 'Horn-Vorlauf kt');
});

test('AK-07 Gleitflug: Leerlauf, 65 KIAS, Klappen 0 → Gleitzahl 8–10 (60 s)', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  const tr = trimAircraft(ac, { x: 0, z: 0, alt: 1800, heading: 270, kias: 65, flapsDeg: 0, throttle: 0 }, ctl);
  assert.ok(tr.converged);
  const p = createPilot({ speed: 65, heading: 270 });
  run(ac, ctl, 10, (s) => p.update(s, ctl));
  const p0 = s.p.slice();
  const ias = [];
  run(ac, ctl, 60, (s) => {
    p.update(s, ctl);
    ias.push(s.ias_kt);
  });
  const dist = Math.hypot(s.p[0] - p0[0], s.p[2] - p0[2]);
  const loss = p0[1] - s.p[1];
  assert.ok(Math.abs(mean(ias) - 65) < 1, `Fahrt ${mean(ias)}`);
  report('AK-07', { ratio: dist / loss, ias: mean(ias) });
  inRange(dist / loss, 8, 10, 'Gleitzahl');
});

// ------------------------------------------------------------------------------------------ Stabilität & Steuerung
test('AK-08 Trimmstabilität: cruise hands-off 60 s → Höhe ±150 ft, Kurs ±10°, Phygoide wächst nicht', () => {
  for (const kick of [0, 5]) {
    const { ac, ctl, s } = setup();
    applyScenario(ac, 'cruise', ctl);
    assert.equal(ctl.elevator, 0);
    const alt0 = s.alt_ft, h0 = s.heading_deg;
    if (kick) {
      // Phygoide anregen: +5 kt Fahrt entlang der Flugbahn
      const v = s.v, vl = Math.hypot(...v);
      for (let k = 0; k < 3; k++) v[k] *= (vl + kick * KT) / vl;
    }
    let max1 = 0, max2 = 0, maxAlt = 0, maxHdg = 0;
    run(ac, ctl, 60, (s, t) => {
      const d = Math.abs(s.alt_ft - alt0);
      if (t < 30) max1 = Math.max(max1, d);
      else max2 = Math.max(max2, d);
      maxAlt = Math.max(maxAlt, d);
      maxHdg = Math.max(maxHdg, Math.abs(hdgErr(s.heading_deg, h0)));
    });
    report('AK-08', { kick, maxAlt, maxHdg, max1, max2 });
    assert.ok(!s.crashed);
    assert.ok(maxAlt <= 150, `Höhenabweichung ${maxAlt.toFixed(1)} ft (Anregung ${kick} kt)`);
    assert.ok(maxHdg <= 10, `Kursabweichung ${maxHdg.toFixed(2)}° (Anregung ${kick} kt)`);
    // ohne Anregung gibt es keine Phygoide – dort nur numerische Toleranz (1 ft), mit Anregung streng
    const tol = kick ? 0 : 1;
    assert.ok(max2 <= max1 + tol, `Phygoide wächst: ${max1.toFixed(1)} → ${max2.toFixed(1)} ft (Anregung ${kick} kt)`);
    if (kick) assert.ok(max1 > 10, `Phygoide nicht angeregt (${max1.toFixed(1)} ft)`);
  }
});

test('AK-09 Rollrate: 105 KIAS, voller Querruderausschlag → 30–60°/s, negatives Wendemoment β > 0,5°', () => {
  for (const dir of [1, -1]) {
    const { ac, ctl, s } = setup();
    applyScenario(ac, 'cruise', ctl);
    assert.ok(Math.abs(s.ias_kt - 105) < 0.5);
    ctl.aileron = dir;
    let pMax = 0, betaMax = 0;
    run(ac, ctl, 2.5, (s) => {
      pMax = Math.max(pMax, dir * s.w[0] / DEG);
      betaMax = Math.max(betaMax, dir * s.beta_deg);
    });
    report('AK-09', { dir, pMax, betaMax });
    inRange(pMax, 30, 60, `Rollrate °/s (Richtung ${dir})`);
    assert.ok(betaMax > 0.5, `negatives Wendemoment: β ${betaMax.toFixed(2)}° (Richtung ${dir})`);
  }
});

test('AK-11 Klappen: 0→30 bei 80 KIAS → Pitch-Änderung > 2° in 3 s; Stall mit Klappen niedriger', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  const tr = trimAircraft(ac, { x: 0, z: 0, alt: 1000, heading: 270, kias: 80, flapsDeg: 0, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged);
  const th0 = s.pitch_deg;
  ctl.flapsCmd = 3;
  let dMax = 0;
  run(ac, ctl, 3, (s) => {
    dMax = Math.max(dMax, Math.abs(s.pitch_deg - th0));
  });
  report('AK-11', { dPitch: dMax });
  assert.ok(dMax > 2, `Pitch-Änderung ${dMax.toFixed(2)}°`);
  const clean = stallRun(0), full = stallRun(30);
  assert.ok(full.stall.kcas < clean.stall.kcas - 3, `Stall Klappen 30 (${full.stall.kcas}) nicht niedriger als clean (${clean.stall.kcas})`);
});

test('AK-12 Trimmung: final hands-off hält 70 ± 3 KIAS; Gleichgewichtsfahrt monoton in der Trimmung', () => {
  const eq = [];
  let trim0 = null;
  for (const dt of [-0.15, -0.075, 0, 0.075, 0.15]) {
    const { ac, ctl, s } = setup({ ground: flatGround(0) });
    const info = applyScenario(ac, 'final', ctl);
    assert.ok(info.converged, 'final-Szenario nicht getrimmt');
    assert.equal(ctl.elevator, 0);
    if (dt === 0) trim0 = ctl.trim;
    ctl.trim += dt;
    const ias = [];
    run(ac, ctl, 90, (s, t) => {
      assert.equal(ctl.elevator, 0);
      if (t >= 60) ias.push(s.ias_kt);
    });
    assert.ok(!s.crashed);
    eq.push(mean(ias));
  }
  report('AK-12', { eq, trim0 });
  assert.ok(Math.abs(eq[2] - 70) <= 3, `Gleichgewichtsfahrt mit Szenario-Trimmung ${eq[2].toFixed(2)} KIAS (Trimm ${trim0})`);
  for (let i = 1; i < eq.length; i++) {
    assert.ok(eq[i] < eq[i - 1] - 0.5, `nicht monoton: ${eq.map((v) => v.toFixed(1)).join(' / ')}`);
  }
});

test('AK-13 Bodeneffekt: Gleiten unter 5 m AGL mit ≥ 10 % geringerer Sinkrate als auf 50 m', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  const sink = (agl) => {
    const tr = trimAircraft(ac, { x: 0, z: 0, alt: C172.cgRestHeight + agl, heading: 270, kias: 65, flapsDeg: 0, throttle: 0 }, ctl);
    assert.ok(tr.converged, `Trimmung auf ${agl} m`);
    const e = evalAirborne(ac, ctl);
    assert.ok(Math.abs(e.ax) + Math.abs(e.az) < 1e-5);
    return -s.v[1];
  };
  const high = sink(50), low = sink(2.5);
  report('AK-13', { high, low, ratio: low / high });
  assert.ok(low <= 0.9 * high, `Sinkrate 2,5 m: ${low.toFixed(3)} m/s, 50 m: ${high.toFixed(3)} m/s`);
  // dynamisch: aus dem 2,5-m-Gleichgewicht 0,5 s frei weiterfliegen – bleibt flacher als auf 50 m
  trimAircraft(ac, { x: 0, z: 0, alt: C172.cgRestHeight + 2.5, heading: 270, kias: 65, flapsDeg: 0, throttle: 0 }, ctl);
  const y0 = s.p[1];
  run(ac, ctl, 0.5);
  assert.ok(!s.onGround, 'Boden berührt');
  assert.ok(y0 - s.p[1] <= 0.9 * high * 0.5, `Höhenverlust in 0,5 s: ${(y0 - s.p[1]).toFixed(3)} m`);
});

// ------------------------------------------------------------------------------------------ Landung & Boden
test('AK-14 Landung: Aufsetzen ≤ 300 ft/min auf der Piste ohne Crash', () => {
  const { ac, ctl, s } = setup();
  // kurzer Endanflug 27: 3°-Gleitpfad auf Aufsetzpunkt 150 m hinter der Schwelle, 30 m über Grund
  const aim = AIRPORT.runway.x1 - 150;
  const d = 30 / Math.tan(3 * DEG);
  const tr = trimAircraft(ac, { x: aim + d, z: 0, alt: AIRPORT.elevation + C172.cgRestHeight + 30, heading: 270, kias: 60, flapsDeg: 30, gammaDeg: -3 }, ctl);
  assert.ok(tr.converged);
  const p = createPilot({ speed: 60, heading: 270, ball: true });
  let flare = false, td = null;
  run(ac, ctl, 60, (s) => {
    if (!flare && s.agl < 6) {
      flare = true;
      ctl.throttle = 0;
      p.speed = null;
      p.vs = -1.5;
    }
    if (flare) p.vs = -(0.3 + 0.18 * Math.max(0, s.agl));
    p.update(s, ctl);
    if (!td && s.onGround) {
      td = { vs: s.vs_fpm, x: s.p[0], z: s.p[2], ias: s.ias_kt };
      return true;
    }
  });
  assert.ok(td, 'nicht aufgesetzt');
  report('AK-14', td);
  run(ac, ctl, 2, (s) => steerOnGround(s, ctl, 270));
  assert.ok(!s.crashed, `Crash: ${s.crashReason}`);
  assert.ok(-td.vs <= 300, `Sinkrate beim Aufsetzen ${(-td.vs).toFixed(0)} ft/min`);
  assert.ok(isRunway(td.x, td.z), `Aufsetzpunkt (${td.x.toFixed(0)}, ${td.z.toFixed(1)}) nicht auf der Piste`);
  // ausrollen mit Bremse bis zum Stillstand – ohne Crash, auf der Piste
  ctl.elevator = 0;
  run(ac, ctl, 60, (s) => {
    steerOnGround(s, ctl, 270);
    ctl.brakeL = ctl.brakeR = 1;
    if (s.gs_kt < 0.05) return true;
  });
  assert.ok(!s.crashed && s.gs_kt < 0.1 && isRunway(s.p[0], s.p[2]));
});

test('AK-14 Bremsen: aus 50 KIAS in ≤ 250 m zum Stehen; 30 s Parkbremse → Drift < 0,1 m', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  ctl.throttle = 1;
  ctl.parkingBrake = false;
  run(ac, ctl, 40, (s) => {
    steerOnGround(s, ctl, 270);
    ctl.elevator = -0.2; // Bugrad am Boden halten
    if (s.ias_kt >= 50) return true;
  });
  assert.ok(s.ias_kt >= 50 && s.onGround);
  const x0 = s.p[0];
  ctl.throttle = 0;
  ctl.elevator = 0;
  let stopped = false;
  run(ac, ctl, 40, (s) => {
    steerOnGround(s, ctl, 270);
    ctl.brakeL = ctl.brakeR = 1;
    if (s.gs_kt < 0.05) {
      stopped = true;
      return true;
    }
  });
  assert.ok(stopped, 'nicht zum Stehen gekommen');
  const dist = Math.abs(s.p[0] - x0);
  report('AK-14b', { dist });
  assert.ok(dist <= 250, `Bremsweg ${dist.toFixed(1)} m`);
  // Parkbremse, Motor im Leerlauf; erst das Nachwippen nach der Vollbremsung abklingen lassen
  ctl.brakeL = ctl.brakeR = 0;
  ctl.rudder = 0;
  ctl.parkingBrake = true;
  run(ac, ctl, 5);
  const p0 = s.p.slice();
  run(ac, ctl, 30);
  const drift = Math.hypot(s.p[0] - p0[0], s.p[2] - p0[2]);
  report('AK-14c', { drift });
  assert.ok(s.rpm > 500, 'Motor läuft im Leerlauf');
  assert.ok(drift < 0.1, `Drift ${drift.toFixed(4)} m`);
});

// ------------------------------------------------------------------------------------------ Crash
test('AK-15 Crash: Aufsetzen mit ≥ 1000 ft/min → crashed, Grund "gear"', () => {
  const { ac, ctl, s } = setup();
  const tr = trimAircraft(ac, { x: 300, z: 0, alt: AIRPORT.elevation + C172.cgRestHeight + 1.5, heading: 270, kias: 55, flapsDeg: 30, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged);
  ctl.throttle = 0;
  // stationärer Sinkflug mit ≈ 1040 ft/min: Bahn und Lage gemeinsam um γ drehen (Anstellwinkel bleibt)
  const V = Math.hypot(...s.v);
  const gam = -Math.asin(5.3 / V);
  s.q = qFromEuler(270 * DEG, tr.alpha + gam, 0);
  s.v = [-V * Math.cos(gam), V * Math.sin(gam), 0];
  let tdVs = null;
  run(ac, ctl, 2, (s) => {
    if (tdVs === null && s.onGround) tdVs = s.vs_fpm;
    if (s.crashed) return true;
  });
  report('AK-15', { tdVs, reason: s.crashReason });
  assert.ok(tdVs !== null && -tdVs >= 1000, `Sinkrate beim Aufsetzen ${tdVs}`);
  assert.equal(s.crashed, true);
  assert.equal(s.crashReason, 'gear');
});

test('AK-15 Crash: Aufsetzen im Wasser → "water"', () => {
  // See suchen, der groß genug ist
  let lake = null;
  for (let r = 1000; r < 40000 && !lake; r += 200) {
    for (let a = 0; a < 360 && !lake; a += 3) {
      const x = r * Math.cos(a * DEG), z = r * Math.sin(a * DEG);
      let ok = true;
      for (let dx = -80; dx <= 80 && ok; dx += 20) for (let dz = -40; dz <= 40 && ok; dz += 20) ok = surface(x + dx, z + dz) === 'water';
      if (ok) lake = [x, z];
    }
  }
  assert.ok(lake, 'kein See gefunden');
  const { ac, ctl, s } = setup();
  const tr = trimAircraft(ac, { x: lake[0] + 40, z: lake[1], alt: WATER_LEVEL + C172.cgRestHeight + 0.8, heading: 270, kias: 55, flapsDeg: 30, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged);
  ctl.throttle = 0;
  s.v[1] = -1.2;
  run(ac, ctl, 3, (s) => s.crashed);
  assert.equal(s.crashed, true);
  assert.equal(s.crashReason, 'water');
});

test('AK-15 Crash: auch über tiefen Seen (Grund ≫ 25 m unter dem Wasserspiegel) → "water"', () => {
  let deep = null;
  for (let x = -40000; x <= 40000 && !deep; x += 250) {
    for (let z = -40000; z <= 40000 && !deep; z += 250) {
      if (surface(x, z) === 'water' && WATER_LEVEL - groundHeight(x, z) > 30) deep = [x, z];
    }
  }
  assert.ok(deep, 'kein tiefer See gefunden');
  const { ac, ctl, s } = setup();
  const tr = trimAircraft(ac, { x: deep[0], z: deep[1], alt: WATER_LEVEL + C172.cgRestHeight + 0.8, heading: 270, kias: 55, flapsDeg: 30, gammaDeg: 0 }, ctl);
  assert.ok(tr.converged);
  assert.ok(Math.abs(s.agl - 0.8) < 0.01, `AGL über Wasser ${s.agl}`);
  ctl.throttle = 0;
  s.v[1] = -1.2;
  run(ac, ctl, 3, (s) => s.crashed);
  assert.equal(s.crashReason, 'water');
});

test('AK-15 Crash: Flügelspitze am Boden → "structure"', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  // 35° Querneigung knapp über der Piste, Flügelspitze als tiefster Punkt
  s.q = qFromEuler(270 * DEG, 0, 35 * DEG);
  const tip = bodyToThree(s.q, C172.structure.find((p) => p.name === 'wingR').pos);
  s.p = [0, AIRPORT.elevation - tip[1] + 0.1, 0];
  s.v = [0, 0, 0];
  s.w = [0, 0, 0];
  run(ac, ctl, 2, (s) => s.crashed);
  assert.equal(s.crashed, true);
  assert.equal(s.crashReason, 'structure');
});

test('AK-15 VNE: 170 KIAS → nur Warnung "VNE", kein Crash; Neustart nach Crash funktioniert', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  const tr = trimAircraft(ac, { x: 0, z: 0, alt: 1500, heading: 270, kias: 170, flapsDeg: 0, throttle: 1 }, ctl);
  assert.ok(tr.converged);
  let seen = false;
  run(ac, ctl, 3, (s) => {
    if (s.warnings.includes('VNE')) seen = true;
  });
  assert.ok(s.ias_kt > 158);
  assert.ok(seen && s.warnings.includes('VNE'), `Warnungen: ${s.warnings}`);
  assert.equal(s.crashed, false);
  // Crash erzwingen (Überlast) und neu starten
  ctl.elevator = 1;
  run(ac, ctl, 5, (s) => s.crashed);
  assert.equal(s.crashed, true);
  assert.equal(s.crashReason, 'overload');
  applyScenario(ac, 'runway', ctl);
  assert.equal(s.crashed, false);
  assert.equal(s.crashReason, null);
});

test('AK-15 Neustart: nach Crash liefert reset einen sauberen Zustand', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  s.p[1] += 3;
  s.v[1] = -8;
  run(ac, ctl, 2, (s) => s.crashed);
  assert.equal(s.crashed, true);
  const info = applyScenario(ac, 'runway', ctl);
  assert.equal(info.id, 'runway');
  assert.equal(s.crashed, false);
  run(ac, ctl, 2);
  assert.equal(s.crashed, false);
  assert.ok(s.onGround && s.rpm > 500);
});

// ------------------------------------------------------------------------------------------ Umwelt
test('AK-16 Wind: 20 kt aus 270° → IAS im Stand ≈ 20 kt; Horizontalflug GS ≈ TAS − Gegenwind (±3 kt)', () => {
  const { ac, ctl, s } = setup({ atm: { windDir: 270, windKt: 20 } });
  applyScenario(ac, 'runway', ctl);
  run(ac, ctl, 3);
  report('AK-16a', { ias: s.ias_kt });
  assert.ok(Math.abs(s.ias_kt - 20) <= 3, `IAS im Stand ${s.ias_kt.toFixed(2)}`);
  assert.ok(Math.hypot(s.v[0], s.v[2]) < 0.05, 'Flugzeug muss stehen');

  const f = setup({ ground: flatGround(0), atm: { windDir: 270, windKt: 20 } });
  const tr = trimAircraft(f.ac, { x: 0, z: 0, alt: 3000 * FT, heading: 270, kias: 100, flapsDeg: 0, gammaDeg: 0 }, f.ctl);
  assert.ok(tr.converged);
  const p = createPilot({ alt: 3000 * FT, heading: 270, ball: true });
  const err = [];
  run(f.ac, f.ctl, 60, (s, t) => {
    p.update(s, f.ctl);
    if (t > 30) {
      const w = windAt(f.ac.atm, s.agl);
      const hdg = [Math.sin(s.heading_deg * DEG), 0, -Math.cos(s.heading_deg * DEG)];
      const head = -(w[0] * hdg[0] + w[2] * hdg[2]) / KT;
      err.push(s.gs_kt - (s.tas_kt - head));
    }
  });
  report('AK-16b', { err: mean(err) });
  assert.ok(Math.abs(mean(err)) <= 3 && Math.max(...err.map(Math.abs)) <= 3, `GS-Fehler ${mean(err).toFixed(2)} kt`);
});

test('AK-17 Turbulenz: 100 % → σ(n) > 0,1 g; 0 % → σ(n) < 0,02 g (Horizontalflug, 30 s)', () => {
  const sigma = (turb) => {
    const { ac, ctl, s } = setup({ atm: { turbulence: turb } });
    applyScenario(ac, 'cruise', ctl);
    const g = [];
    run(ac, ctl, 30, (s) => {
      g.push(s.g);
    });
    assert.ok(!s.crashed);
    return std(g);
  };
  const high = sigma(1), low = sigma(0);
  report('AK-17', { high, low });
  assert.ok(high > 0.1, `σ(n) bei 100 %: ${high.toFixed(3)} g`);
  assert.ok(low < 0.02, `σ(n) bei 0 %: ${low.toFixed(4)} g`);
});

// ------------------------------------------------------------------------------------------ Motor
test('AK-18 Motorstart: OFF → 0 RPM in 10 s; START + 10 % Gas → > 500 RPM in 3 s; Windmilling im Gleitflug', () => {
  const { ac, ctl, s } = setup();
  applyScenario(ac, 'runway', ctl);
  assert.ok(ctl.parkingBrake && s.rpm > 500);
  ctl.ignition = 'OFF';
  let tZero = null;
  run(ac, ctl, 10, (s, t) => {
    if (tZero === null && s.rpm === 0) tZero = t;
  });
  assert.ok(tZero !== null && s.rpm === 0, `RPM nach 10 s: ${s.rpm}`);
  ctl.throttle = 0.1;
  ctl.ignition = 'START';
  let crank = 0, tRun = null;
  run(ac, ctl, 3, (s, t) => {
    if (s.rpm > crank && !s.engineRunning) crank = s.rpm;
    if (tRun === null && s.rpm > 500) tRun = t;
  });
  assert.ok(tRun !== null, `Motor läuft nicht an (RPM ${s.rpm.toFixed(0)})`);
  report('AK-18', { tZero, tRun, crank });
  inRange(crank, 150, 250, 'Anlasserdrehzahl');
  ctl.ignition = 'BOTH';
  run(ac, ctl, 5);
  assert.ok(s.engineRunning && s.rpm > 500, 'Motor läuft nach dem Loslassen weiter');

  const f = setup({ ground: flatGround(0) });
  const tr = trimAircraft(f.ac, { x: 0, z: 0, alt: 1500, heading: 270, kias: 80, flapsDeg: 0, throttle: 0 }, f.ctl);
  assert.ok(tr.converged);
  f.ctl.ignition = 'OFF';
  const p = createPilot({ speed: 80, heading: 270 });
  run(f.ac, f.ctl, 20, (s) => p.update(s, f.ctl));
  assert.ok(!f.s.engineRunning);
  assert.ok(Math.abs(f.s.ias_kt - 80) < 2);
  report('AK-18b', { windmillRpm: f.s.rpm });
  assert.ok(f.s.rpm > 500, `Windmilling-RPM ${f.s.rpm.toFixed(0)}`);
});

// ------------------------------------------------------------------------------------------ Grundlagen
test('Stabilitätsvorzeichen: Cmα < 0 stellt zurück, Querruder rechts rollt rechts, Seitenruder rechts giert rechts', () => {
  const { ac, ctl, s } = setup({ ground: flatGround(0) });
  trimAircraft(ac, { x: 0, z: 0, alt: 1000, heading: 0, kias: 100, flapsDeg: 0, gammaDeg: 0 }, ctl);
  const base = evalAirborne(ac, ctl).qdot;
  // Nase hoch drehen bei gleicher Bahn → Anstellwinkel größer → Nickmoment muss nach unten zeigen
  const q0 = s.q.slice();
  s.q = qFromEuler(0, (s.pitch_deg + 2) * DEG, 0);
  assert.ok(evalAirborne(ac, ctl).qdot < base - 0.1, 'Cmα muss rückstellend sein');
  s.q = q0;
  ctl.aileron = 1;
  assert.ok(evalAirborne(ac, ctl).pdot > 0.5, 'Querruder rechts → Rollen rechts');
  ctl.aileron = 0;
  ctl.rudder = 1;
  assert.ok(evalAirborne(ac, ctl).rdot > 0.05, 'Seitenruder rechts → Gieren rechts');
  ctl.rudder = 0;
  ctl.elevator = 1;
  assert.ok(evalAirborne(ac, ctl).qdot > 0.5, 'Ziehen → Nase hoch');
});

test('Szenarien: runway steht, final/cruise sind getrimmt und entsprechen der Spezifikation', () => {
  const { ac, ctl, s } = setup({ mass: 1000 });
  applyScenario(ac, 'runway', ctl);
  assert.ok(s.onGround && ctl.parkingBrake && ctl.flapsCmd === 0 && ctl.throttle === 0);
  assert.equal(s.heading_deg.toFixed(0), '270');
  assert.ok(isRunway(s.p[0], s.p[2]) && s.p[0] > 500, 'am Pistenanfang 27');
  assert.ok(s.rpm > 550 && s.rpm < 850, `Leerlauf ${s.rpm}`);
  const fin = applyScenario(ac, 'final', ctl);
  assert.ok(fin.converged);
  assert.ok(Math.abs(s.ias_kt - 70) < 0.5 && s.flapsDeg === 20 && ctl.flapsCmd === 2);
  assert.ok(Math.abs(s.agl_ft - 1000) < 60, `final AGL ${s.agl_ft}`);
  assert.ok(Math.abs(s.p[0] - AIRPORT.runway.x1 - 3 * 1852) < 1);
  const cr = applyScenario(ac, 'cruise', ctl);
  assert.ok(cr.converged);
  assert.ok(Math.abs(s.alt_ft - 4500) < 1 && Math.abs(s.ias_kt - 105) < 0.5 && Math.abs(s.heading_deg - 270) < 0.01);
  report('Szenarien', { idle: 0, cruiseRpm: s.rpm, finalThr: fin.throttle, cruiseThr: cr.throttle });
  assert.ok(Math.abs(s.rpm - 2400) < 100, `Reiseflug-RPM ${s.rpm.toFixed(0)}`);
});

test('Performance: ein Physikschritt ≤ 0,3 ms (Median, am Boden mit Kontaktpunkten)', () => {
  const { ac, ctl } = setup();
  applyScenario(ac, 'runway', ctl);
  ctl.throttle = 0.5;
  const times = [];
  for (let k = 0; k < 20; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) stepAircraft(ac, ctl, DT);
    times.push((performance.now() - t0) / 120);
  }
  times.sort((a, b) => a - b);
  report('N3', { msPerStep: times[10] });
  assert.ok(times[10] <= 0.3, `Median ${times[10].toFixed(4)} ms/Schritt`);
});

