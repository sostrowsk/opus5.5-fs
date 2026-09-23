// Startzustände (runway / final / cruise) und Trimmrechnung. Ohne three, ohne DOM.
import { DEG, KT, FT, clamp, qFromEuler, bodyToThree } from './math.js';
import { isa, tasFromCas, windAt, resetGusts } from './atmosphere.js';
import { evalAirborne, resetState, stepAircraft, kiasToKcas, refreshOutputs } from './aircraft.js';
import { AIRPORT } from '../world/heightfield.js';

const NM = 1852;
const RWY = AIRPORT.runway;

export const SCENARIOS = {
  runway: { id: 'runway', name: 'Startbereit Piste 27', desc: 'Pistenanfang 27, Motor im Leerlauf, Parkbremse gesetzt' },
  final: { id: 'final', name: 'Endanflug Piste 27', desc: '3 NM Final, 1000 ft über Grund, 70 KIAS, Klappen 20' },
  cruise: { id: 'cruise', name: 'Reiseflug', desc: '4500 ft MSL, 105 KIAS, Kurs 270' },
};

/** Löst ein lineares Gleichungssystem A·x = b (Gauß mit Pivotsuche). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-14) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Stationären, symmetrischen Flug trimmen (Flügel horizontal, β = 0, keine Drehraten).
 * spec: { x, z, alt (m MSL), heading (°), kias, flapsDeg, ignition,
 *         gammaDeg (vorgegebener Bahnwinkel → Gas wird gesucht) ODER throttle (vorgegeben → Bahnwinkel gesucht),
 *         pitchCtl: 'trim' (Standard, Yoke 0) | 'elevator' (Trimmung fest = spec.trim) }
 * Setzt den Zustand des Flugzeugs und ctl. Rückgabe { converged, alpha, gamma, throttle, trim, elevator, rpm }.
 */
export function trimAircraft(ac, spec, ctl) {
  const s = resetState(ac);
  const flapsDeg = spec.flapsDeg ?? 0;
  const fIdx = ac.cfg.flaps.detents.indexOf(flapsDeg);
  ctl.flapsCmd = fIdx >= 0 ? fIdx : 0;
  ctl.elevator = 0;
  ctl.aileron = 0;
  ctl.rudder = 0;
  ctl.brakeL = ctl.brakeR = 0;
  ctl.parkingBrake = false;
  ctl.ignition = spec.ignition ?? 'BOTH';
  if (spec.pitchCtl === 'elevator') ctl.trim = spec.trim ?? 0;
  s.flapsDeg = flapsDeg;
  s.engineRunning = ctl.ignition !== 'OFF';
  const heading = (spec.heading ?? 0) * DEG;
  s.p = [spec.x ?? 0, spec.alt, spec.z ?? 0];
  const air = isa(spec.alt, ac.atm.qnh);
  const V = tasFromCas(kiasToKcas(spec.kias, flapsDeg, ac.cfg) * KT, air);
  const gammaFixed = spec.gammaDeg !== undefined;

  // Unbekannte: [α, Nicksteuerung, Gas bzw. γ, rpm]
  const x = [4 * DEG, 0, gammaFixed ? 0.5 : 0, 2000];
  const apply = (xv) => {
    const alpha = xv[0];
    const gamma = gammaFixed ? spec.gammaDeg * DEG : xv[2];
    const thr = gammaFixed ? xv[2] : spec.throttle;
    s.q = qFromEuler(heading, alpha + gamma, 0);
    const vAir = bodyToThree(s.q, [V * Math.cos(alpha), 0, V * Math.sin(alpha)]);
    const gh = ac.ground.sample(s.p[0], s.p[2], {}).h;
    const surf = ac.ground.waterLevel !== undefined ? Math.max(gh, ac.ground.waterLevel) : gh;
    const wind = windAt(ac.atm, s.p[1] - surf - ac.cfg.cgRestHeight);
    s.v = [vAir[0] + wind[0], vAir[1] + wind[1], vAir[2] + wind[2]];
    s.w = [0, 0, 0];
    s.rpm = Math.max(0, xv[3]);
    ctl.throttle = clamp(thr, 0, 1);
    s.thrEff = ctl.throttle;
    if (spec.pitchCtl === 'elevator') ctl.elevator = xv[1];
    else ctl.trim = xv[1];
  };
  const resid = (xv) => {
    apply(xv);
    const r = evalAirborne(ac, ctl);
    return [r.ax, r.az, r.qdot, r.rpmDot / 100];
  };

  let converged = false;
  let r = resid(x);
  const h = [1e-5, 1e-5, 1e-5, 0.5];
  for (let it = 0; it < 60; it++) {
    const err = Math.hypot(...r);
    if (err < 1e-7) {
      converged = true;
      break;
    }
    const J = [[], [], [], []];
    for (let j = 0; j < 4; j++) {
      // Gas an der Obergrenze: einseitige Differenz nach innen (apply() begrenzt auf 0..1 → sonst Nullspalte)
      const hj = gammaFixed && j === 2 && x[2] + h[j] > 1 ? -h[j] : h[j];
      const xp = x.slice();
      xp[j] += hj;
      const rp = resid(xp);
      for (let i = 0; i < 4; i++) J[i][j] = (rp[i] - r[i]) / hj;
    }
    const dx = solve(J, r.map((v) => -v));
    if (!dx) break;
    // Schrittweite begrenzen
    const lim = [3 * DEG, 0.2, 0.2, 400];
    let sc = 1;
    for (let j = 0; j < 4; j++) sc = Math.min(sc, lim[j] / Math.max(Math.abs(dx[j]), 1e-12));
    for (let j = 0; j < 4; j++) x[j] += dx[j] * sc;
    if (gammaFixed) x[2] = clamp(x[2], 0, 1); // projiziertes Newton-Verfahren: Gas bleibt im gültigen Bereich
    r = resid(x);
  }
  apply(x);
  const res = {
    converged,
    alpha: x[0],
    gamma: gammaFixed ? spec.gammaDeg * DEG : x[2],
    throttle: ctl.throttle,
    trim: ctl.trim,
    elevator: ctl.elevator,
    rpm: s.rpm,
    tas: V,
    residual: Math.hypot(...r),
  };
  const pc = x[1];
  if (Math.abs(pc) > 1.0001 || (gammaFixed && (x[2] < -1e-3 || x[2] > 1.001))) res.converged = false;
  // Gefordertes Gleichgewicht mit Vollgas nicht erreichbar: stationärer Flug mit Vollgas und freiem Bahnwinkel
  if (gammaFixed && !res.converged && x[2] >= 0.999 && !spec.noFallback) {
    return trimAircraft(ac, { ...spec, gammaDeg: undefined, throttle: 1, noFallback: true }, ctl);
  }
  resetGusts(ac.atm);
  refreshOutputs(ac, ctl);
  return res;
}

/** Trimmstellung für den Start (Steigflug 75 KIAS, Vollgas) – wird für das runway-Szenario benutzt. */
function takeoffTrim(ac, ctl) {
  const r = trimAircraft(ac, { x: 0, z: 0, alt: AIRPORT.elevation + 300, heading: 270, kias: 75, flapsDeg: 0, throttle: 1 }, ctl);
  return clamp(r.trim, -1, 1);
}

/**
 * Szenario anwenden: Flugzeugzustand setzen und ctl (in place) anpassen.
 * Masse und Umgebung (ac.atm) werden vorher vom Aufrufer gesetzt.
 */
export function applyScenario(ac, id, ctl) {
  const sc = SCENARIOS[id] ? id : 'runway';
  ctl.elevator = ctl.aileron = ctl.rudder = 0;
  ctl.brakeL = ctl.brakeR = 0;
  let info;
  if (sc === 'runway') {
    const trim = takeoffTrim(ac, ctl);
    const s = resetState(ac);
    const x = RWY.x1 - 15;
    const g = ac.ground.sample(x, 0, {});
    s.p = [x, g.h + ac.cfg.cgRestHeight + 0.02, 0];
    s.q = qFromEuler(270 * DEG, 0, 0);
    s.rpm = 700;
    s.engineRunning = true;
    Object.assign(ctl, { throttle: 0, trim, flapsCmd: 0, parkingBrake: true, ignition: 'BOTH' });
    // einschwingen lassen (Federn, Leerlaufdrehzahl) – in ruhiger Luft, damit starker Wind den Startzustand
    // nicht schon vor der ersten Eingabe kippt/beschädigt
    const atm = ac.atm;
    const wx = { windKt: atm.windKt, turbulence: atm.turbulence, extraTurbulence: atm.extraTurbulence };
    atm.windKt = atm.turbulence = atm.extraTurbulence = 0;
    for (let i = 0; i < 360; i++) stepAircraft(ac, ctl, 1 / 120);
    Object.assign(atm, wx);
    s.v = [0, 0, 0];
    s.w = [0, 0, 0];
    s.time = 0;
    s.wheelSpin = [0, 0, 0];
    s.propAngle = 0;
    info = { trim };
  } else if (sc === 'final') {
    const dist = 3 * NM;
    info = trimAircraft(
      ac,
      { x: RWY.x1 + dist, z: 0, alt: AIRPORT.elevation + 1000 * FT, heading: 270, kias: 70, flapsDeg: 20, gammaDeg: -3 },
      ctl,
    );
  } else {
    info = trimAircraft(ac, { x: 12000, z: 0, alt: 4500 * FT, heading: 270, kias: 105, flapsDeg: 0, gammaDeg: 0 }, ctl);
  }
  resetGusts(ac.atm);
  refreshOutputs(ac, ctl);
  return { id: sc, ...info };
}
