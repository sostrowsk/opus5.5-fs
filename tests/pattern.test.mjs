// AK-39 Kompletter Ablauf: skriptgesteuerter Testflug (einfacher Regler) – `runway` → Start → Platzrunde
// (Linksplatzrunde 27, 1000 ft über Grund) → Endanflug → Landung → Ausrollen bis Stillstand → Zurückrollen zum
// Pistenanfang → nächster Start. Drei Landungen hintereinander ohne Neustart, ohne Crash und ohne
// Bodendurchdringung > 5 cm (Radaufstandspunkt über den Federweg hinaus bzw. Strukturpunkt unter Grund).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG, FT, clamp, wrapPi, bodyToThree } from '../js/sim/math.js';
import { stepAircraft } from '../js/sim/aircraft.js';
import { applyScenario } from '../js/sim/scenarios.js';
import { AIRPORT, isRunway } from '../js/world/heightfield.js';
import { setup, createPilot, DT } from './pilot.mjs';

const report = (ak, values) => {
  if (process.env.AK_REPORT) console.log(`[${ak}]`, JSON.stringify(values, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
};
const RWY = AIRPORT.runway;
const ELEV = AIRPORT.elevation;
const hdgErr = (target, h) => wrapPi((target - h) * DEG) / DEG;

/** Größte Eindringtiefe unter den Boden: Räder über den Federweg hinaus, Strukturpunkte überhaupt. */
function penetration(ac) {
  const s = ac.state;
  const cfg = ac.cfg;
  let worst = 0;
  const probe = (r, allow) => {
    const w = bodyToThree(s.q, r);
    const x = s.p[0] + w[0], y = s.p[1] + w[1], z = s.p[2] + w[2];
    const d = ac.ground.height(x, z) - y - allow;
    if (d > worst) worst = d;
  };
  for (const g of cfg.gear) probe(g.pos, g.travel);
  for (const p of cfg.structure || []) probe(p.pos || p, 0);
  return worst;
}

/**
 * Platzrunden-Pilot als Zustandsautomat. Phasen:
 *   takeoff → climb → crosswind → downwind → base → final → flare → rollout → turnback → backtrack → lineup → takeoff …
 */
function createPatternPilot(ac, ctl) {
  const s = ac.state;
  const p = createPilot({ ball: false });
  const PATTERN_ALT = ELEV + 1000 * FT; // m MSL
  const DOWNWIND_Z = 1300; // m südlich der Pistenachse (Linksplatzrunde 27)
  const BASE_X = RWY.x1 + 2600; // Queranflug 2,6 km hinter der Schwelle
  const AIM_X = RWY.x1 - 150; // Aufsetzpunkt
  const st = { phase: 'takeoff', t: 0, landings: 0, touchdowns: [], log: [], rotated: false };
  const setPhase = (ph) => {
    st.log.push(`${ph}@${s.time.toFixed(0)}s`);
    st.phase = ph;
    st.t = 0;
    st.pBase = st.iSp = st.iX = undefined;
    p.reset();
  };
  // Querneigungsziel für einen Kurs (Links-/Rechtskurve nach kürzestem Weg), max. 25°
  const heading = (h, maxBank = 25) => {
    p.heading = null;
    p.bank = clamp(1.6 * hdgErr(h, s.heading_deg), -maxBank, maxBank);
  };
  // Linie verfolgen: Kurs = Linienkurs + Korrektur nach Querablage (m) und Quergeschwindigkeit (m/s)
  // (mit Integralanteil für den Vorhaltewinkel bei Seitenwind)
  const track = (lineHdg, xte, xteRate, maxCorr = 30) => {
    st.iX = clamp((st.iX ?? 0) + xte * DT * 0.02, -15, 15);
    heading(lineHdg + clamp(0.3 * xte + 2.0 * xteRate + st.iX, -maxCorr, maxCorr));
  };
  // Fahrt über die Nicklage (PI auf gefilterte IAS – Böen sollen nicht direkt aufs Höhenruder durchschlagen)
  const speedPitch = (kt) => {
    st.iasF = st.iasF === undefined ? s.ias_kt : st.iasF + (s.ias_kt - st.iasF) * (DT / 1.2);
    if (st.pBase === undefined) st.pBase = s.pitch_deg;
    const e = st.iasF - kt; // zu schnell → Nase hoch
    st.iSp = clamp((st.iSp ?? 0) + e * DT * 0.06, -10, 10);
    p.speed = null;
    p.alt = null;
    p.vs = null;
    p.pitch = clamp(st.pBase + 0.5 * e + st.iSp, -10, 14);
  };
  const coordinate = () => {
    ctl.rudder = clamp(0.06 * s.beta_deg + 0.25 * ctl.aileron, -1, 1);
  };
  // Bodenlenkung: Seitenruder (Bugrad) + Differenzialbremse bei großen Kursfehlern
  const steer = (h, diffBrake = false) => {
    const e = hdgErr(h, s.heading_deg);
    ctl.rudder = clamp(0.12 * e - 0.05 * s.w[2] / DEG, -1, 1);
    ctl.brakeL = ctl.brakeR = 0;
    if (diffBrake && Math.abs(e) > 20) {
      if (e > 0) ctl.brakeR = 0.35;
      else ctl.brakeL = 0.35;
    }
  };
  const taxiSpeed = (kt) => {
    const e = kt - s.gs_kt;
    st.iTaxi = clamp((st.iTaxi ?? 0.1) + e * DT * 0.02, 0, 0.5);
    ctl.throttle = clamp(st.iTaxi + 0.03 * e, 0, 0.6);
    if (e < -3) ctl.brakeL = ctl.brakeR = Math.max(ctl.brakeL, ctl.brakeR, 0.4);
  };

  function update() {
    st.t += DT;
    const vz = s.v[2];
    switch (st.phase) {
      case 'takeoff': {
        ctl.parkingBrake = false;
        ctl.flapsCmd = 0;
        ctl.throttle = 1;
        ctl.aileron = 0;
        steer(270);
        ctl.brakeL = ctl.brakeR = 0;
        if (s.ias_kt < 55 && !st.rotated) ctl.elevator = -0.1;
        else {
          st.rotated = true;
          p.speed = null;
          p.pitch = Math.min(8, (p.pitch ?? s.pitch_deg) + 5 * DT);
          p.update(s, ctl);
        }
        if (!s.onGround && s.agl > 15) {
          setPhase('climb');
          st.rotated = false;
        }
        break;
      }
      case 'climb':
        ctl.throttle = 1;
        speedPitch(75);
        track(270, s.p[2], vz);
        p.update(s, ctl);
        coordinate();
        if (s.p[1] > ELEV + 700 * FT) setPhase('crosswind');
        break;
      case 'crosswind':
        if (s.p[1] < PATTERN_ALT - 20) speedPitch(75);
        else {
          p.pitch = null;
          p.alt = PATTERN_ALT;
        }
        ctl.throttle = s.p[1] < PATTERN_ALT - 20 ? 1 : 0.62;
        heading(180);
        p.update(s, ctl);
        coordinate();
        if (s.p[2] > DOWNWIND_Z - 450) setPhase('downwind');
        break;
      case 'downwind': {
        p.speed = p.pitch = null;
        p.alt = PATTERN_ALT;
        const abeam = s.p[0] > RWY.x1;
        ctl.flapsCmd = abeam ? 1 : 0;
        ctl.throttle = abeam ? 0.5 : 0.62;
        // Kurs 090, Linie z = DOWNWIND_Z (südlich zu weit → nach Norden = kleinerer Kurs)
        track(90, -(s.p[2] - DOWNWIND_Z), -vz);
        p.update(s, ctl);
        coordinate();
        if (s.p[0] > BASE_X) setPhase('base');
        break;
      }
      case 'base':
        ctl.flapsCmd = 2;
        speedPitch(70);
        ctl.throttle = s.p[1] > ELEV + 700 * FT ? 0.25 : 0.45;
        heading(0);
        p.update(s, ctl);
        coordinate();
        if (s.p[2] < 420) setPhase('final');
        break;
      case 'final': {
        ctl.flapsCmd = st.t > 8 ? 3 : 2;
        speedPitch(st.t > 8 ? 63 : 68);
        // Gleitpfad 3° auf den Aufsetzpunkt: Gas nach Höhenfehler, Fahrt über die Nicklage
        const dist = s.p[0] - AIM_X;
        const hGs = ELEV + ac.cfg.cgRestHeight + Math.tan(3 * DEG) * Math.max(0, dist);
        const e = hGs - s.p[1];
        st.iThr = clamp((st.iThr ?? 0.3) + e * DT * 0.004, 0.05, 0.7);
        ctl.throttle = clamp(st.iThr + 0.03 * e - 0.08 * s.v[1] - 0.25, 0, 1);
        track(270, s.p[2], vz, 25);
        p.update(s, ctl);
        coordinate();
        if (s.agl < 7) {
          setPhase('flare');
          st.iThr = undefined;
        }
        break;
      }
      case 'flare': {
        // Abfangen: Nicklage so führen, dass die Sinkrate mit der Höhe gegen ≈ 0,3 m/s geht
        ctl.throttle = 0;
        p.speed = p.alt = p.vs = null;
        const vsT = -(0.3 + 0.2 * Math.max(0, s.agl));
        const e = vsT - s.v[1];
        st.fp = clamp((st.fp ?? s.pitch_deg) + e * DT * 4, -6, 9);
        p.pitch = clamp(st.fp + 2.5 * e, -6, 10);
        track(270, s.p[2], vz, 15);
        p.update(s, ctl);
        ctl.rudder = clamp(0.1 * hdgErr(270, s.heading_deg) + 0.06 * s.beta_deg, -1, 1);
        if (s.onGround) {
          st.touchdowns.push({ vs: s.vs_fpm, x: s.p[0], z: s.p[2], ias: s.ias_kt, onRunway: isRunway(s.p[0], s.p[2]) });
          st.landings++;
          st.fp = undefined;
          setPhase('rollout');
        }
        break;
      }
      case 'rollout':
        ctl.throttle = 0;
        ctl.aileron = 0;
        ctl.flapsCmd = 0;
        ctl.elevator = 0;
        steer(270);
        ctl.brakeL = ctl.brakeR = st.t > 2 ? 0.8 : 0;
        if (s.gs_kt < 0.3) setPhase(st.landings >= 3 ? 'done' : 'turnback');
        break;
      case 'turnback':
        // Kehrtwende nach rechts auf der Piste (Bugrad + Differenzialbremse)
        ctl.elevator = 0;
        steer(hdgErr(90, s.heading_deg) > 0 ? s.heading_deg + 60 : 90, true);
        if (Math.abs(hdgErr(90, s.heading_deg)) > 20) ctl.rudder = 1;
        taxiSpeed(5);
        if (Math.abs(hdgErr(90, s.heading_deg)) < 10) setPhase('backtrack');
        break;
      case 'backtrack': {
        // Kurs 090, Linie z = 0 (südlich zu weit → nach Norden = kleinerer Kurs)
        const h = 90 + clamp(-0.8 * s.p[2] - 4 * vz, -25, 25);
        steer(h, false);
        taxiSpeed(s.p[0] > RWY.x1 - 90 ? 5 : 14);
        if (s.p[0] > RWY.x1 - 45) setPhase('lineup');
        break;
      }
      case 'lineup':
        steer(hdgErr(270, s.heading_deg) > 0 ? s.heading_deg + 60 : 270, true);
        if (Math.abs(hdgErr(270, s.heading_deg)) > 20) ctl.rudder = 1;
        taxiSpeed(5);
        if (Math.abs(hdgErr(270, s.heading_deg)) < 5) {
          ctl.brakeL = ctl.brakeR = 1;
          ctl.throttle = 0;
          if (s.gs_kt < 0.2) setPhase('takeoff');
        }
        break;
      default:
        break;
    }
  }
  return { st, update };
}

function flyPattern(atm) {
  const { ac, ctl, s } = setup({ mass: 1000, atm });
  applyScenario(ac, 'runway', ctl);
  const pilot = createPatternPilot(ac, ctl);
  let maxPen = 0, minAglAir = Infinity, maxG = 1, minG = 1;
  const limit = Math.round(1800 / DT); // höchstens 30 min Simulationszeit
  let i = 0;
  for (; i < limit && pilot.st.phase !== 'done'; i++) {
    pilot.update();
    stepAircraft(ac, ctl, DT);
    if (process.env.PATTERN_DEBUG && (i % 120 === 0 || s.crashed)) {
      console.log(pilot.st.phase, s.time.toFixed(1), 'x', s.p[0].toFixed(0), 'z', s.p[2].toFixed(1), 'agl', s.agl.toFixed(1), 'ias', s.ias_kt.toFixed(0), 'gs', s.gs_kt.toFixed(1), 'vs', s.vs_fpm.toFixed(0), 'hdg', s.heading_deg.toFixed(0), 'pitch', s.pitch_deg.toFixed(1), 'bank', s.bank_deg.toFixed(1), 'thr', ctl.throttle.toFixed(2), 'el', ctl.elevator.toFixed(2), 'ail', ctl.aileron.toFixed(2), 'rud', ctl.rudder.toFixed(2), 'g', s.g.toFixed(2), s.crashReason || '');
    }
    if (s.crashed) break;
    maxPen = Math.max(maxPen, penetration(ac));
    if (['crosswind', 'downwind', 'base'].includes(pilot.st.phase)) minAglAir = Math.min(minAglAir, s.agl);
    maxG = Math.max(maxG, s.g);
    minG = Math.min(minG, s.g);
  }
  return { s, pilot, time: i * DT, maxPen, minAglAir, g: [minG, maxG] };
}

function checkPattern(ak, r) {
  const { s, pilot } = r;
  report(ak, {
    time_s: r.time,
    landings: pilot.st.landings,
    touchdowns: pilot.st.touchdowns,
    maxPenetration_m: r.maxPen,
    minPatternAgl_m: r.minAglAir,
    g: r.g,
    phases: pilot.st.log.join(' '),
  });
  assert.ok(!s.crashed, `Crash (${s.crashReason}) in Phase ${pilot.st.phase}: ${pilot.st.log.slice(-4).join(' ')}`);
  assert.equal(pilot.st.landings, 3, `nur ${pilot.st.landings} Landungen: ${pilot.st.log.join(' ')}`);
  assert.equal(pilot.st.phase, 'done');
  for (const td of pilot.st.touchdowns) {
    assert.ok(td.onRunway, `Aufsetzen neben der Piste (${td.x.toFixed(0)}, ${td.z.toFixed(1)})`);
    assert.ok(-td.vs <= 300, `Sinkrate beim Aufsetzen ${(-td.vs).toFixed(0)} ft/min`);
  }
  assert.ok(r.maxPen <= 0.05, `Bodendurchdringung ${(r.maxPen * 100).toFixed(1)} cm`);
  assert.ok(s.gs_kt < 0.3, 'am Ende im Stillstand');
}

test('AK-39 Kompletter Ablauf: drei Platzrunden mit Landung und Ausrollen ohne Neustart (ruhige Luft)', () => {
  checkPattern('AK-39', flyPattern({}));
});

test('AK-39 Kompletter Ablauf auch bei Standardwetter (8 kt aus 240°, Böigkeit 20 %)', () => {
  checkPattern('AK-39w', flyPattern({ windDir: 240, windKt: 8, turbulence: 0.2 }));
});
