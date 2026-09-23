// Einfache Test-Piloten (Regler) für die headless Physiktests. Kein Testfile – wird importiert.
import { DEG, clamp, wrapPi } from '../js/sim/math.js';
import { createAircraft, createControls, stepAircraft } from '../js/sim/aircraft.js';
import { createAtmosphere } from '../js/sim/atmosphere.js';
import { worldGround } from '../js/world/heightfield.js';

export const DT = 1 / 120;

/** Flugzeug + Controls mit Test-Standardwerten (1089 kg, ISA, kein Wind, Turbulenz 0). */
export function setup({ mass = 1089, ground = worldGround, atm = {} } = {}) {
  const atmosphere = createAtmosphere({ windDir: 0, windKt: 0, turbulence: 0, ...atm });
  const ac = createAircraft({ mass, ground, atmosphere });
  const ctl = createControls();
  return { ac, ctl, s: ac.state };
}

/** n Schritte simulieren; cb(s, t) wird vor jedem Schritt aufgerufen (Rückgabe true = abbrechen). */
export function run(ac, ctl, seconds, cb) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (cb && cb(ac.state, i * DT) === true) return i * DT;
    stepAircraft(ac, ctl, DT);
  }
  return seconds;
}

/**
 * Autopilot-ähnlicher Testpilot. Modi (alle optional, kombinierbar):
 *   pitch: Ziel-Nicklage (°) | speed: Ziel-IAS (kt, über Nicklage) | alt: Zielhöhe (m, über Nicklage)
 *   vs: Ziel-Vario (m/s, über Nicklage)
 *   heading: Zielkurs (°, über Querneigung) | bank: Ziel-Querneigung (°) | ball: Schiebewinkel ausregeln
 *   rpm: Zieldrehzahl (über Gas)
 * Der Pilot schreibt nur die jeweils zuständigen Controls.
 */
export function createPilot(opts = {}) {
  const st = { iPitch: 0, iSpeed: 0, iAlt: 0, iRpm: 0, iBank: 0, prevIas: null, theta0: null };
  const pilot = { ...opts };
  pilot.update = (s, ctl, dt = DT) => {
    // ---- Längs
    let thetaT = null;
    const theta = s.pitch_deg * DEG;
    if (st.theta0 === null) st.theta0 = theta;
    if (pilot.speed !== undefined && pilot.speed !== null) {
      const e = s.ias_kt - pilot.speed; // zu schnell → Nase hoch
      st.iSpeed = clamp(st.iSpeed + e * dt * 0.004, -0.4, 0.4);
      const dIas = st.prevIas === null ? 0 : (s.ias_kt - st.prevIas) / dt;
      thetaT = st.theta0 + 0.012 * e + st.iSpeed + 0.03 * dIas;
    } else if (pilot.alt !== undefined && pilot.alt !== null) {
      const e = pilot.alt - s.p[1];
      st.iAlt = clamp(st.iAlt + e * dt * 0.0004, -0.15, 0.15);
      thetaT = st.theta0 + clamp(0.004 * e - 0.02 * s.v[1] + st.iAlt, -0.25, 0.25);
    } else if (pilot.vs !== undefined && pilot.vs !== null) {
      const e = pilot.vs - s.v[1];
      st.iAlt = clamp(st.iAlt + e * dt * 0.02, -0.3, 0.3);
      thetaT = st.theta0 + clamp(0.03 * e + st.iAlt, -0.3, 0.3);
    } else if (pilot.pitch !== undefined && pilot.pitch !== null) {
      thetaT = pilot.pitch * DEG;
    }
    st.prevIas = s.ias_kt;
    if (thetaT !== null) {
      const e = thetaT - theta;
      st.iPitch = clamp(st.iPitch + e * dt * 1.5, -0.6, 0.6);
      ctl.elevator = clamp(3.0 * e + st.iPitch - 0.6 * s.w[1], -1, 1);
    }
    // ---- Quer/Seite
    let bankT = null;
    if (pilot.heading !== undefined && pilot.heading !== null) {
      const e = wrapPi((pilot.heading - s.heading_deg) * DEG);
      bankT = clamp(1.5 * e, -20 * DEG, 20 * DEG);
    } else if (pilot.bank !== undefined && pilot.bank !== null) bankT = pilot.bank * DEG;
    if (bankT !== null) {
      const e = bankT - s.bank_deg * DEG;
      st.iBank = clamp(st.iBank + e * dt * 0.5, -0.2, 0.2);
      ctl.aileron = clamp(2.0 * e + st.iBank - 0.5 * s.w[0], -1, 1);
    }
    if (pilot.ball) ctl.rudder = clamp(4 * s.beta_deg * DEG - 0.8 * s.w[2], -1, 1);
    // ---- Gas
    if (pilot.rpm !== undefined && pilot.rpm !== null) {
      st.iRpm = clamp(st.iRpm + (pilot.rpm - s.rpm) * dt * 0.0004, 0, 1);
      ctl.throttle = clamp(st.iRpm + 0.0005 * (pilot.rpm - s.rpm), 0, 1);
    }
  };
  pilot.reset = () => {
    st.iPitch = st.iSpeed = st.iAlt = st.iRpm = st.iBank = 0;
    st.prevIas = null;
    st.theta0 = null;
  };
  pilot.setRpmIntegrator = (v) => (st.iRpm = v);
  return pilot;
}

export const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
export const std = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
};
