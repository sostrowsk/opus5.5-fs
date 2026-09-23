// 6-DOF-Starrkörpermodell der C172: Aerodynamik, Motor/Propeller, Fahrwerk/Boden, Integration, Crash.
// Ohne three, ohne DOM – läuft unter Node (node --test) und im Browser.
//
// Vorzeichen der Steuerbefehle (controls):
//   elevator  +1 = ziehen (Nase hoch), −1 = drücken       aileron +1 = Rollen rechts
//   rudder    +1 = rechtes Pedal (Nase rechts)            trim    +1 = Nase hoch trimmen
//   throttle  0..1, flapsCmd 0..3 (0/10/20/30°), brakeL/brakeR 0..1, parkingBrake bool,
//   ignition  'OFF' | 'BOTH' | 'START'
// Zustands-Ausgaben: elevatorDeg/trimDeg positiv = Nase-hoch-Richtung (Höhenruder-Hinterkante hoch).
import {
  DEG, RAD, KT, FT, G0, clamp, lerp, smoothstep, interp, interpExtrap,
  cross, qIntegrate, qToEuler, bodyToThree, threeToBody, wrap360,
} from './math.js';
import { C172 } from './c172.js';
import { isa, casFromTas, windAt, updateGusts, createAtmosphere, pressureAltitude } from './atmosphere.js';

export const CRASH_TEXT = {
  gear: 'Fahrwerk gebrochen – zu harte Landung',
  structure: 'Strukturteil hat den Boden berührt',
  water: 'Wasserkontakt',
  overload: 'Strukturversagen – Bruchlast überschritten',
  prop: 'Propeller hat den Boden berührt – Motor ausgefallen',
};

export function createControls() {
  return {
    elevator: 0,
    aileron: 0,
    rudder: 0,
    throttle: 0,
    trim: 0,
    flapsCmd: 0,
    brakeL: 0,
    brakeR: 0,
    parkingBrake: false,
    ignition: 'BOTH',
  };
}

function createState() {
  return {
    // Kernzustand
    p: [0, 0, 0], // Weltposition (Three: x Ost, y oben, z Süd) m
    v: [0, 0, 0], // Weltgeschwindigkeit m/s
    q: [1, 0, 0, 0], // Body → NED
    w: [0, 0, 0], // Drehraten Body (p, q, r) rad/s
    rpm: 0,
    engineRunning: false,
    propBroken: false,
    catchRevs: 0,
    thrEff: 0,
    propAngle: 0,
    flapsDeg: 0,
    act: [0, 0, 0], // tatsächliche Stellung Höhen-/Quer-/Seitenruder (normiert −1..1, ratenbegrenzt)
    stallL: 0,
    stallR: 0,
    stallTgtL: 0,
    stallTgtR: 0,
    time: 0,
    crashed: false,
    crashReason: null,
    gearCompression: [0, 0, 0],
    wheelSpin: [0, 0, 0],
    wheelContact: [false, false, false],
    // abgeleitete Anzeigewerte
    ias_kt: 0,
    cas_kt: 0,
    tas_kt: 0,
    gs_kt: 0,
    alt_ft: 0,
    agl_ft: 0,
    agl: 0,
    vs_fpm: 0,
    pitch_deg: 0,
    bank_deg: 0,
    heading_deg: 0,
    aoa_deg: 0,
    beta_deg: 0,
    flaps_deg: 0,
    elevatorDeg: 0,
    aileronDeg: 0,
    rudderDeg: 0,
    trimDeg: 0,
    thrust: 0,
    onGround: false,
    stalled: false,
    stallWarning: false,
    g: 1,
    ay_g: 0,
    warnings: [],
    pressureAlt_ft: 0,
    staticPressure: 101325,
    surface: 'grass',
  };
}

/**
 * Flugzeug erzeugen. opts: { mass, ground (Bodenanbieter, s. heightfield.js), atmosphere, cfg }.
 */
export function createAircraft(opts = {}) {
  const cfg = opts.cfg || C172;
  const ac = {
    cfg,
    mass: cfg.massDefault,
    I: [0, 0, 0],
    staticLoad: [0, 0, 0],
    ground: opts.ground,
    atm: opts.atmosphere || createAtmosphere(),
    state: createState(),
    wheels: cfg.gear.map(() => ({ lon: 0, lat: 0 })),
    // Arbeitsspeicher (vermeidet Allokationen pro Schritt)
    _gs: { h: 0, nx: 0, ny: 1, nz: 0 },
    _gs2: { h: 0, nx: 0, ny: 1, nz: 0 },
    _wind: [0, 0, 0],
    _o: {},
    _eff: {},
  };
  if (!ac.ground) throw new Error('createAircraft: ground provider fehlt');
  setMass(ac, opts.mass ?? cfg.massDefault);
  return ac;
}

/** Masse setzen (kg); Trägheitsmomente und statische Radlasten werden mitgeführt. */
export function setMass(ac, mass) {
  const cfg = ac.cfg;
  ac.mass = clamp(mass, cfg.massMin, cfg.massMax);
  const f = 0.7 + (0.3 * ac.mass) / cfg.massRef; // Leermasse dominiert die Trägheit
  ac.I = cfg.inertia.map((x) => x * f);
  const xn = cfg.gear[0].pos[0];
  const xm = -cfg.gear[1].pos[0];
  const W = ac.mass * G0;
  const nose = (W * xm) / (xn + xm);
  ac.staticLoad = [nose, (W - nose) / 2, (W - nose) / 2];
}

// ---------------------------------------------------------------- Kalibrierung Fahrtmesser
function calTable(t, kcas, lower) {
  const k0 = t.kcas[0];
  if (kcas >= k0) return interpExtrap(t.kcas, t.kias, kcas);
  if (kcas <= lower) return kcas;
  // unterhalb der Tabelle: weich von der Tabelle zur Identität bei `lower` überblenden
  const w = (kcas - lower) / (k0 - lower);
  return kcas + w * (t.kias[0] - k0);
}
/** KCAS → KIAS gemäß POH-naher Tabelle (Klappen 0…30 interpoliert). */
export function kcasToKias(kcas, flapsDeg = 0, cfg = C172) {
  const a = cfg.asi;
  const f = clamp(flapsDeg / 30, 0, 1);
  const k0 = calTable(a.flaps0, kcas, a.lowerKcas);
  const k30 = calTable(a.flaps30, kcas, a.lowerKcas);
  return Math.max(0, lerp(k0, k30, f));
}
/** KIAS → KCAS (Umkehrung per Bisektion). */
export function kiasToKcas(kias, flapsDeg = 0, cfg = C172) {
  let lo = 0, hi = 400;
  for (let i = 0; i < 60; i++) {
    const m = 0.5 * (lo + hi);
    if (kcasToKias(m, flapsDeg, cfg) < kias) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------- Propeller
function propCoeffs(P, J) {
  const n = P.J.length;
  const Jl = P.J[n - 1];
  if (J <= Jl) return [interp(P.J, P.CT, J), interp(P.J, P.CP, J)];
  const f = (J / Jl) * (J / Jl);
  return [P.CT[n - 1] * f, P.CP[n - 1] * f];
}
/** Schub (N) und Wellenmoment (N·m, positiv = Propeller nimmt Leistung auf). Vax: axiale Anströmung m/s. */
export function propellerForces(P, rho, Vax, rpm, out) {
  const D = P.D;
  const n = Math.max(0, rpm) / 60;
  const nL = P.J.length - 1;
  const cTs = P.CT[nL] / (P.J[nL] * P.J[nL]);
  const cPs = P.CP[nL] / (P.J[nL] * P.J[nL]);
  const VV = Vax * Math.abs(Vax);
  // Stand-/Anlaufbereich (kein J): Schub ∝ n², Windmilling-Moment aus der Anströmung
  const Tlow = rho * D ** 4 * P.CT[0] * n * n + cTs * rho * D * D * VV;
  const Qlow = (rho * D ** 5 * P.CP[0] * n * n + cPs * rho * D ** 3 * VV) / (2 * Math.PI);
  if (rpm <= P.lowRpm) {
    out.T = Tlow;
    out.Q = Qlow;
    return out;
  }
  const J = Math.max(0, Vax) / (n * D);
  const [ct, cp] = propCoeffs(P, J);
  let T = ct * rho * n * n * D ** 4;
  let Q = (cp * rho * n * n * D ** 5) / (2 * Math.PI);
  if (Vax < 0) {
    // Rückenwind: zusätzlicher Anströmungsanteil wie im Stand-Bereich
    T += cTs * rho * D * D * VV;
    Q += (cPs * rho * D ** 3 * VV) / (2 * Math.PI);
  }
  if (rpm < P.blendRpm) {
    const w = (rpm - P.lowRpm) / (P.blendRpm - P.lowRpm);
    T = lerp(Tlow, T, w);
    Q = lerp(Qlow, Q, w);
  }
  out.T = T;
  out.Q = Q;
  return out;
}

/** Motormoment (N·m) aus Verbrennung + Anlasser, ohne Reibung. */
function engineTorque(ac, ctl, sigma) {
  const E = ac.cfg.engine;
  const s = ac.state;
  let Q = 0;
  if (s.engineRunning) {
    const x = s.rpm / E.rpmRated;
    const Qrated = E.powerRated / ((E.rpmRated * 2 * Math.PI) / 60);
    const Qmax = Qrated + E.fricA + E.fricB * E.rpmRated;
    const shape = 1 - E.torqueCurve * (x - 1) * (x - 1);
    // Leerlauf-Luftmenge ist konstant → Moment je Umdrehung fällt mit steigender Drehzahl
    const t = Math.pow(clamp(s.thrEff, 0, 1), E.throttleExp);
    const thr = t + (1 - t) * E.idleFrac * Math.min(1, E.idleRpm / Math.max(s.rpm, 1));
    Q += Qmax * shape * Math.pow(sigma, E.densityExp) * thr;
  }
  if (ctl.ignition === 'START' && !s.propBroken) {
    Q += E.starterTorque * Math.max(0, 1 - s.rpm / E.starterFreeRpm);
  }
  return Q;
}

// ---------------------------------------------------------------- Aerodynamik + Propeller
/**
 * Kräfte (Body, ohne Schwerkraft) und Momente (Body) aus Luft und Propeller.
 * Liest den Zustand, verändert ihn nicht. Ergebnis in o.
 */
function aeroProp(ac, ctl, air, wind, gust, gustP, hWing, o) {
  const s = ac.state;
  const cfg = ac.cfg;
  const A = cfg.aero;
  const P = cfg.prop;
  const F = cfg.flaps;
  const C = cfg.controls;
  const S = cfg.S, b = cfg.b, c = cfg.c;

  // Anströmung im Body-System
  const vb = threeToBody(s.q, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);
  const u = vb[0] - gust[0];
  const vv = vb[1] - gust[1];
  const ww = vb[2] - gust[2];
  const V = Math.hypot(u, vv, ww);
  const Vxz = Math.hypot(u, ww);
  const rho = air.rho;
  const qbar = 0.5 * rho * V * V;
  const alpha = V > 0.5 ? Math.atan2(ww, u) : 0;
  const beta = V > 0.5 ? Math.asin(clamp(vv / V, -1, 1)) : 0;
  const Vn = Math.max(V, 10);
  const pw = s.w[0] - gustP;
  const ph = (pw * b) / (2 * Vn);
  const qh = (s.w[1] * c) / (2 * Vn);
  const rh = (s.w[2] * b) / (2 * Vn);

  // Ruderausschläge (rad); δe positiv = Hinterkante unten
  const e = clamp(ctl.elevator, -1, 1);
  const trim = clamp(ctl.trim, -1, 1);
  let deDeg = (e > 0 ? -e * C.elevUp : -e * C.elevDown) - trim * C.trimFloat;
  deDeg = clamp(deDeg, -C.elevUp, C.elevDown);
  const de = deDeg * DEG;
  const da = clamp(ctl.aileron, -1, 1) * C.aileron * DEG;
  const dr = clamp(ctl.rudder, -1, 1) * C.rudder * DEG;

  // Propeller
  propellerForces(P, rho, u, s.rpm, o);
  const T = o.T;
  const Qp = o.Q;
  const Tpos = Math.max(0, T);
  const qSlip = Tpos / P.diskArea;
  const qH = qbar + P.slipH * qSlip; // Staudruck am Höhenleitwerk
  const qV = qbar + P.slipV * qSlip; // … am Seitenleitwerk

  // Klappen & Bodeneffekt
  const fd = s.flapsDeg;
  const dCLf = interp(F.deg, F.dCL, fd);
  const dCDf = interp(F.deg, F.dCD, fd);
  const dCmf = interp(F.deg, F.dCm, fd);
  const hb = Math.max(0, hWing) / b;
  const kCDi = interp(cfg.groundEffect.hb, cfg.groundEffect.kCDi, hb);
  const kCL = interp(cfg.groundEffect.hb, cfg.groundEffect.kCL, hb);

  // Auftrieb je Flügelhälfte mit eigenem Strömungsabriss
  const aCrit = lerp(A.alphaCrit0, A.alphaCrit30, clamp(fd / 30, 0, 1));
  const aNeg = A.alphaCritNeg;
  const dAr = (pw * b) / (4 * Vn);
  const aL = alpha - dAr - A.dropBeta * beta + A.dropAsym;
  const aR = alpha + dAr + A.dropBeta * beta;
  const CLlinRaw = (a) => A.CL0 + A.CLa * a + dCLf;
  const CLlin = (a) => CLlinRaw(clamp(a, aNeg - 6 * DEG, aCrit + 6 * DEG));
  const CLmaxP = CLlinRaw(aCrit) * A.postStallCL;
  const CLminP = CLlinRaw(aNeg) * A.postStallCL;
  const CLpost = (a) => {
    if (Math.abs(a) > Math.PI / 2) return 0.8 * Math.sin(2 * a);
    const flat = 1.15 * Math.sin(2 * a);
    if (a >= 0) return Math.min(CLlin(a), Math.max(CLmaxP - A.postStallSlope * (a - aCrit), flat));
    return Math.max(CLlin(a), Math.min(CLminP + A.postStallSlope * (aNeg - a), flat));
  };
  const CLLlin = CLlin(aL), CLRlin = CLlin(aR);
  const CLL = (1 - s.stallL) * CLLlin + s.stallL * CLpost(aL);
  const CLR = (1 - s.stallR) * CLRlin + s.stallR * CLpost(aR);
  const stallAvg = 0.5 * (s.stallL + s.stallR);
  const CLw = 0.5 * (CLL + CLR) * kCL + A.CLq * qh;
  // Rollmoment aus ungleichem Abriss (nur der nichtlineare Anteil; linear steckt in Clp)
  const dClStall = clamp(A.dropGain * (CLL - CLR - (CLLlin - CLRlin)), -A.dropMax, A.dropMax);

  // Widerstand
  const AR = (b * b) / S;
  const k = 1 / (Math.PI * A.e * AR);
  const sa = Math.sin(alpha);
  const CD = A.CD0 + dCDf + k * kCDi * CLw * CLw + stallAvg * A.stallDrag * sa * sa + A.CDbeta * Math.abs(beta);
  const CY = A.CYb * beta + A.CYp * ph + A.CYr * rh;

  // Momentenbeiwerte (Staudruck qbar); Leitwerksruder mit Slipstream-Staudruck
  const Cm = A.Cm0 + A.Cma * sa + A.Cmq * qh + dCmf + A.stallCm * stallAvg;
  const Clr = clamp(A.ClrPerCL * CLw, -0.1, 0.5);
  const Cl = A.Clb * beta + A.Clp * ph + Clr * rh + A.Clda * da + dClStall + A.ClRig;
  const Cnp = -CLw / 10;
  const Cn = A.Cnb * Math.sin(beta) + Cnp * ph + A.Cnr * rh + A.Cnda * da + A.CnRig;

  // Kräfte im Body-System
  const L = qbar * S * CLw + qH * S * A.CLde * de;
  const Dg = qbar * S * CD;
  const Y = qbar * S * CY + qV * S * A.CYdr * dr;
  let lx = 0, lz = -1, ex = 0, ey = 0, ez = 0;
  if (V > 0.5) {
    ex = u / V;
    ey = vv / V;
    ez = ww / V;
  }
  if (Vxz > 0.5) {
    lx = ww / Vxz;
    lz = -u / Vxz;
  }
  const Fb = o.F || (o.F = [0, 0, 0]);
  Fb[0] = -Dg * ex + L * lx + T;
  Fb[1] = -Dg * ey + Y;
  Fb[2] = -Dg * ez + L * lz;

  // Momente
  const Mb = o.M || (o.M = [0, 0, 0]);
  const aP = clamp(alpha, -0.35, 0.35);
  Mb[0] = qbar * S * b * Cl + qV * S * b * A.Cldr * dr - P.torqueRoll * Qp;
  Mb[1] = qbar * S * c * Cm + qH * S * c * A.Cmde * de + P.thrustZ * T;
  Mb[2] = qbar * S * b * Cn + qV * S * b * A.Cndr * dr - P.pFactor * Tpos * aP - P.swirl * Math.max(0, Qp);

  // Diagnose für Zustand/Stall-Logik
  o.V = V;
  o.u = u;
  o.qbar = qbar;
  o.alpha = alpha;
  o.beta = beta;
  o.aL = aL;
  o.aR = aR;
  o.aCrit = aCrit;
  o.aNeg = aNeg;
  o.CL = CLw;
  o.T = T;
  o.Qp = Qp;
  o.deDeg = deDeg;
  o.daDeg = da * RAD;
  o.drDeg = dr * RAD;
  return o;
}

// ---------------------------------------------------------------- Fahrwerk & Boden
const SURF_DEFAULT = { mu: 0.8, roll: 0.02 };

/**
 * Bodenkräfte (Welt, Fw) und -momente (Body, Mb) aufsummieren. Aktualisiert Radzustände.
 * Rückgabe: Crash-Grund oder null.
 */
function groundContact(ac, ctl, dt, Fw, Mb) {
  const s = ac.state;
  const cfg = ac.cfg;
  const tire = cfg.tire;
  const gnd = ac.ground;
  const gs = ac._gs2;
  const wl = gnd.waterLevel;
  let crash = null;
  let onGround = false;

  // --- Räder
  for (let i = 0; i < cfg.gear.length; i++) {
    const g = cfg.gear[i];
    const wst = ac.wheels[i];
    const r = g.pos;
    const rw = bodyToThree(s.q, r);
    const P = [s.p[0] + rw[0], s.p[1] + rw[1], s.p[2] + rw[2]];
    gnd.sample(P[0], P[2], gs);
    if (gs.h < wl && P[1] < wl) {
      crash = crash || 'water';
    }
    const d = (gs.h - P[1]) * gs.ny;
    if (d <= 0) {
      s.gearCompression[i] = 0;
      s.wheelContact[i] = false;
      wst.lon = 0;
      wst.lat = 0;
      continue;
    }
    onGround = true;
    s.wheelContact[i] = true;
    const n = [gs.nx, gs.ny, gs.nz];
    // Geschwindigkeit des Kontaktpunkts (Welt)
    const wr = bodyToThree(s.q, cross(s.w, r));
    const vc = [s.v[0] + wr[0], s.v[1] + wr[1], s.v[2] + wr[2]];
    const vn = vc[0] * n[0] + vc[1] * n[1] + vc[2] * n[2];
    const dRate = -vn; // Einfedergeschwindigkeit
    const comp = Math.min(d, g.travel);
    const bump = Math.max(0, d - g.travel);
    let Fn = g.k * comp + g.k * cfg.gearBumpFactor * bump + g.c * dRate;
    if (Fn < 0) Fn = 0;
    s.gearCompression[i] = Math.min(d, g.travel);
    // Crash: Endanschlag mit hoher Sinkgeschwindigkeit oder Überlast
    if ((d >= g.travel && dRate > cfg.limits.gearCrashSpeed) || Fn > cfg.limits.gearForceFactor * ac.staticLoad[i]) {
      crash = crash || 'gear';
    }

    // Radrichtung (Bugrad gelenkt) in der Bodenebene
    // Bugradlenkung über Federn (Bungee): mit zunehmender Rollgeschwindigkeit begrenzt die Seitenlast den
    // Lenkeinschlag auf eine Querbeschleunigung von ≈ steerMaxG (verhindert Umkippen bei schnellen Kurven)
    let steer = 0;
    if (g.steer) {
      const v2 = s.v[0] * s.v[0] + s.v[2] * s.v[2];
      const lim = Math.min(cfg.controls.noseSteer * DEG, Math.atan((cfg.controls.steerMaxG * G0 * (g.pos[0] - cfg.gear[1].pos[0])) / Math.max(v2, 1e-6)));
      steer = clamp(ctl.rudder, -1, 1) * lim;
    }
    const fb = bodyToThree(s.q, [Math.cos(steer), Math.sin(steer), 0]);
    const fn = fb[0] * n[0] + fb[1] * n[1] + fb[2] * n[2];
    let f = [fb[0] - fn * n[0], fb[1] - fn * n[1], fb[2] - fn * n[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    f = [f[0] / fl, f[1] / fl, f[2] / fl];
    const sd = [f[1] * n[2] - f[2] * n[1], f[2] * n[0] - f[0] * n[2], f[0] * n[1] - f[1] * n[0]]; // f × n = rechts
    const vf = vc[0] * f[0] + vc[1] * f[1] + vc[2] * f[2];
    const vs = vc[0] * sd[0] + vc[1] * sd[1] + vc[2] * sd[2];

    const surfName = gnd.surface(P[0], P[2]);
    const surf = cfg.surfaces[surfName] || SURF_DEFAULT;
    if (i === 1) s.surface = surfName;
    const mu = surf.mu;

    // Längs: elastoplastische Haftreibung (Rollwiderstand + Bremse), hält im Stand exakt
    let brake = 0;
    if (g.brake) {
      brake = g.brake === 'L' ? ctl.brakeL : ctl.brakeR;
      if (ctl.parkingBrake) brake = 1;
      brake = clamp(brake, 0, 1);
    }
    const capL = Math.min(mu, surf.roll + tire.brakeMu * brake) * Fn;
    const kL = tire.lonStiff * Fn;
    const cL = tire.lonDamp * Fn;
    wst.lon += vf * dt;
    if (Math.abs(kL * wst.lon) > capL) wst.lon = (Math.sign(wst.lon) * capL) / Math.max(kL, 1e-6);
    let FL = clamp(-(kL * wst.lon + cL * vf), -capL, capL);

    // Quer: Reifen mit Einlauflänge (linear bis zur Haftgrenze, hält im Stand)
    const kS = (Fn * mu) / (tire.slipSat * tire.relaxLen);
    const cS = kS * 0.02;
    wst.lat = (wst.lat + vs * dt) / (1 + (Math.abs(vf) * dt) / tire.relaxLen);
    const capS = mu * Fn;
    if (Math.abs(kS * wst.lat) > capS) wst.lat = (Math.sign(wst.lat) * capS) / Math.max(kS, 1e-6);
    let FS = clamp(-(kS * wst.lat + cS * vs), -capS, capS);

    // Reibkreis
    const Ft = Math.hypot(FL, FS);
    if (Ft > mu * Fn && Ft > 0) {
      const sc = (mu * Fn) / Ft;
      FL *= sc;
      FS *= sc;
    }

    const F = [
      n[0] * Fn + f[0] * FL + sd[0] * FS,
      n[1] * Fn + f[1] * FL + sd[1] * FS,
      n[2] * Fn + f[2] * FL + sd[2] * FS,
    ];
    Fw[0] += F[0];
    Fw[1] += F[1];
    Fw[2] += F[2];
    const Fb = threeToBody(s.q, F);
    const m = cross(r, Fb);
    Mb[0] += m[0];
    Mb[1] += m[1];
    Mb[2] += m[2];

    // Radrotation (Animation): Rollen, außer bei blockierender Bremse
    const locked = brake > 0.95 && Math.abs(FL) >= capL * 0.999 && Math.abs(vf) > 0.3;
    if (!locked) s.wheelSpin[i] = (s.wheelSpin[i] + (vf / g.radius) * dt) % (2 * Math.PI);
  }

  // --- Strukturpunkte
  for (const sp of cfg.structure) {
    const rw = bodyToThree(s.q, sp.pos);
    const x = s.p[0] + rw[0], y = s.p[1] + rw[1], z = s.p[2] + rw[2];
    gnd.sample(x, z, gs);
    if (gs.h < wl && y < wl) crash = crash || 'water';
    if (y < gs.h) crash = crash || 'structure';
  }
  // --- Propellerspitze (tiefster Punkt der Propellerkreisscheibe)
  if (!s.propBroken) {
    const P = cfg.prop;
    const down = threeToBody(s.q, [0, -1, 0]);
    const dl = Math.hypot(down[1], down[2]);
    const tip = dl > 1e-6
      ? [P.center[0], P.center[1] + (P.radius * down[1]) / dl, P.center[2] + (P.radius * down[2]) / dl]
      : [P.center[0], P.center[1], P.center[2] + P.radius];
    const rw = bodyToThree(s.q, tip);
    const x = s.p[0] + rw[0], y = s.p[1] + rw[1], z = s.p[2] + rw[2];
    gnd.sample(x, z, gs);
    if (gs.h < wl && y < wl) crash = crash || 'water';
    if (y < gs.h) {
      s.propBroken = true;
      s.engineRunning = false;
      s.rpm = 0;
      crash = crash || 'prop';
    }
  }
  s.onGround = onGround;
  return crash;
}

/** Höhe der Oberfläche unter (x, z): Gelände oder – über Seen – der Wasserspiegel (Bezug für AGL/Bodeneffekt). */
function surfaceHeight(ac, x, z) {
  const h = ac.ground.sample(x, z, ac._gs).h;
  const wl = ac.ground.waterLevel;
  return wl !== undefined && h < wl ? wl : h;
}

// ---------------------------------------------------------------- Integration
const EMPTY3 = [0, 0, 0];

/** Einen Physikschritt dt (s) rechnen. */
export function stepAircraft(ac, ctl, dt) {
  const s = ac.state;
  if (s.crashed) return s;
  const cfg = ac.cfg;
  const E = cfg.engine;

  // Stellglieder: Klappenmotor, Saugrohrdruck
  const fl = cfg.flaps;
  const fTarget = fl.detents[clamp(Math.round(ctl.flapsCmd), 0, fl.detents.length - 1)];
  const fStep = fl.rate * dt;
  s.flapsDeg += clamp(fTarget - s.flapsDeg, -fStep, fStep);
  s.thrEff += (clamp(ctl.throttle, 0, 1) - s.thrEff) * Math.min(1, dt / E.throttleTau);

  // Ruderflächen folgen der Eingabe mit begrenzter Stellrate (≈ 90°/s); Aerodynamik, Bugradlenkung und
  // Animation sehen die tatsächliche Stellung
  const C = cfg.controls;
  const eff = Object.assign(ac._eff, ctl);
  const lim = [C.surfaceRate / Math.max(C.elevUp, C.elevDown), C.surfaceRate / C.aileron, C.surfaceRate / C.rudder];
  const dem = [ctl.elevator, ctl.aileron, ctl.rudder];
  for (let k = 0; k < 3; k++) {
    const d = clamp(dem[k], -1, 1) - s.act[k];
    s.act[k] += clamp(d, -lim[k] * dt, lim[k] * dt);
  }
  eff.elevator = s.act[0];
  eff.aileron = s.act[1];
  eff.rudder = s.act[2];

  // Umgebung
  const air = isa(s.p[1], ac.atm.qnh);
  const cgHeight = s.p[1] - surfaceHeight(ac, s.p[0], s.p[2]);
  const agl = cgHeight - cfg.cgRestHeight;
  windAt(ac.atm, agl, ac._wind);
  updateGusts(ac.atm, dt, s.tas_kt * KT, agl);

  // Kräfte
  const o = aeroProp(ac, eff, air, ac._wind, ac.atm.gust, ac.atm.gustP, cgHeight + cfg.wingHeight, ac._o);
  const Fg = [0, 0, 0];
  const Mg = [0, 0, 0];
  let crash = null;
  if (cgHeight < 25) crash = groundContact(ac, eff, dt, Fg, Mg);
  else {
    s.onGround = false;
    s.wheelContact.fill(false);
    s.gearCompression.fill(0);
    for (const w of ac.wheels) w.lon = w.lat = 0;
  }

  const m = ac.mass;
  const Fa = bodyToThree(s.q, o.F);
  const fx = (Fa[0] + Fg[0]) / m, fy = (Fa[1] + Fg[1]) / m, fz = (Fa[2] + Fg[2]) / m;
  // Lastvielfaches (spezifische Kraft im Body-System)
  const fb = threeToBody(s.q, [fx, fy, fz]);
  const nz = -fb[2] / G0;
  const ny = fb[1] / G0;

  // Translation (semi-implizit)
  s.v[0] += fx * dt;
  s.v[1] += (fy - G0) * dt;
  s.v[2] += fz * dt;
  s.p[0] += s.v[0] * dt;
  s.p[1] += s.v[1] * dt;
  s.p[2] += s.v[2] * dt;

  // Rotation: I·ω̇ = M − ω × (I·ω + H_prop)
  const I = ac.I;
  const w = s.w;
  const H = (cfg.prop.inertiaProp * s.rpm * 2 * Math.PI) / 60;
  const Iw = [I[0] * w[0] + H, I[1] * w[1], I[2] * w[2]];
  const gyro = cross(w, Iw);
  const M = [o.M[0] + Mg[0] - gyro[0], o.M[1] + Mg[1] - gyro[1], o.M[2] + Mg[2] - gyro[2]];
  for (let k = 0; k < 3; k++) w[k] = clamp(w[k] + (M[k] / I[k]) * dt, -8, 8);
  qIntegrate(s.q, w, dt);

  // Motor/Propeller-Drehzahl: I·dω/dt = Q_Motor − Q_Prop − Q_Reibung
  if (!s.propBroken) {
    const Qe = engineTorque(ac, ctl, air.sigma);
    const net = Qe - o.Qp;
    const fric = E.fricA + E.fricB * s.rpm;
    if (s.rpm <= 0.5 && net <= E.fricA) {
      s.rpm = 0;
    } else {
      const rpmDot = ((net - fric) / E.inertia) * (60 / (2 * Math.PI));
      s.rpm = clamp(s.rpm + rpmDot * dt, 0, E.rpmMax);
    }
    // Zündung / Motorlauf
    if (s.engineRunning) {
      if (ctl.ignition === 'OFF' || s.rpm < E.dieRpm) s.engineRunning = false;
    } else if (ctl.ignition !== 'OFF' && s.rpm > E.fireRpm) {
      s.catchRevs += (s.rpm / 60) * dt;
      if (s.catchRevs >= E.catchRevs) s.engineRunning = true;
    } else {
      s.catchRevs = 0;
    }
    s.propAngle = (s.propAngle + (s.rpm / 60) * 2 * Math.PI * dt) % (2 * Math.PI);
  }

  // Strömungsabriss-Zustand je Flügelhälfte (Hysterese + Zeitkonstante)
  const A = cfg.aero;
  const tgt = (a, prev) => {
    if (a > o.aCrit || a < o.aNeg) return 1;
    if (a < o.aCrit - A.stallHyst && a > o.aNeg + A.stallHyst) return 0;
    return prev;
  };
  const live = o.V > 8;
  s.stallTgtL = live ? tgt(o.aL, s.stallTgtL) : 0;
  s.stallTgtR = live ? tgt(o.aR, s.stallTgtR) : 0;
  const ks = Math.min(1, dt / A.stallTau);
  s.stallL += (s.stallTgtL - s.stallL) * ks;
  s.stallR += (s.stallTgtR - s.stallR) * ks;

  s.time += dt;

  // Strukturelle Überlast
  if (!crash && (nz > cfg.limits.gMax || nz < cfg.limits.gMin)) crash = 'overload';
  if (crash) {
    s.crashed = true;
    s.crashReason = crash;
    s.engineRunning = false; // Zustand bleibt im Aufprallmoment eingefroren
  }

  updateOutputs(ac, ctl, o, air, agl, nz, ny);
  return s;
}

/** Abgeleitete Anzeigewerte aus dem Zustand berechnen. */
function updateOutputs(ac, ctl, o, air, agl, nz, ny) {
  const s = ac.state;
  const cfg = ac.cfg;
  const e = qToEuler(s.q);
  const V = o.V;
  // CAS aus der Gesamtanströmung; der Pitot verliert erst bei großem Schräganströmwinkel (> 30°) die Anzeige
  const pitotV = o.V > 0.1 && o.u > 0 ? o.V * smoothstep(0, 0.87, o.u / o.V) : 0;
  const casMs = casFromTas(pitotV, air);
  s.tas_kt = V / KT;
  s.cas_kt = casMs / KT;
  s.ias_kt = kcasToKias(s.cas_kt, s.flapsDeg, cfg);
  s.gs_kt = Math.hypot(s.v[0], s.v[2]) / KT;
  s.alt_ft = s.p[1] / FT;
  s.agl = agl;
  s.agl_ft = agl / FT;
  s.vs_fpm = (s.v[1] / FT) * 60;
  s.pitch_deg = e.theta * RAD;
  s.bank_deg = e.phi * RAD;
  s.heading_deg = wrap360(e.psi * RAD);
  s.aoa_deg = o.alpha * RAD;
  s.beta_deg = o.beta * RAD;
  s.flaps_deg = s.flapsDeg;
  s.elevatorDeg = -o.deDeg;
  s.aileronDeg = o.daDeg;
  s.rudderDeg = o.drDeg;
  s.trimDeg = clamp(ctl.trim, -1, 1) * cfg.controls.trimTab;
  s.thrust = o.T;
  s.g = nz;
  s.ay_g = ny;
  s.staticPressure = air.p;
  s.pressureAlt_ft = pressureAltitude(air.p) / FT;
  const live = V > 10;
  s.stalled = live && Math.max(s.stallL, s.stallR) > 0.5;
  const hornMargin = lerp(cfg.aero.stallHornMargin0, cfg.aero.stallHornMargin30, clamp(s.flapsDeg / 30, 0, 1));
  s.stallWarning = live && (s.stalled || Math.max(o.aL, o.aR) > o.aCrit - hornMargin);
  const warn = [];
  if (s.ias_kt > cfg.limits.vneKias) warn.push('VNE');
  if (s.rpm > cfg.limits.rpmRedline + 5) warn.push('RPM');
  if (s.stallWarning) warn.push('STALL');
  s.warnings = warn;
}

/**
 * Auswertung ohne Integration (für Trimmrechnung): Beschleunigungen im Body-System inkl. Schwerkraft,
 * Nickbeschleunigung und Drehzahländerung. Kein Bodenkontakt, keine Böen.
 */
export function evalAirborne(ac, ctl) {
  const s = ac.state;
  const cfg = ac.cfg;
  const E = cfg.engine;
  const air = isa(s.p[1], ac.atm.qnh);
  const cgHeight = s.p[1] - surfaceHeight(ac, s.p[0], s.p[2]);
  windAt(ac.atm, cgHeight - cfg.cgRestHeight, ac._wind);
  const o = aeroProp(ac, ctl, air, ac._wind, EMPTY3, 0, cgHeight + cfg.wingHeight, ac._o);
  const gb = threeToBody(s.q, [0, -G0, 0]);
  const m = ac.mass;
  const Qe = engineTorque(ac, ctl, air.sigma);
  const rpmDot = ((Qe - o.Qp - (E.fricA + E.fricB * s.rpm)) / E.inertia) * (60 / (2 * Math.PI));
  return {
    ax: o.F[0] / m + gb[0],
    ay: o.F[1] / m + gb[1],
    az: o.F[2] / m + gb[2],
    pdot: o.M[0] / ac.I[0],
    qdot: o.M[1] / ac.I[1],
    rdot: o.M[2] / ac.I[2],
    rpmDot,
    o,
    air,
  };
}

/** Zustand vollständig zurücksetzen (Position/Lage setzt der Aufrufer, z. B. scenarios.js). */
export function resetState(ac) {
  const keep = ac.state;
  const s = createState();
  ac.state = Object.assign(keep, s);
  for (const w of ac.wheels) w.lon = w.lat = 0;
  return ac.state;
}

/** Abgeleitete Werte ohne Zeitschritt aktualisieren (z. B. nach einem Reset). */
export function refreshOutputs(ac, ctl) {
  ac.state.act = [clamp(ctl.elevator, -1, 1), clamp(ctl.aileron, -1, 1), clamp(ctl.rudder, -1, 1)]; // Stellglieder = Eingabe
  const s = ac.state;
  const air = isa(s.p[1], ac.atm.qnh);
  const cgHeight = s.p[1] - surfaceHeight(ac, s.p[0], s.p[2]);
  windAt(ac.atm, cgHeight - ac.cfg.cgRestHeight, ac._wind);
  const o = aeroProp(ac, ctl, air, ac._wind, EMPTY3, 0, cgHeight + ac.cfg.wingHeight, ac._o);
  updateOutputs(ac, ctl, o, air, cgHeight - ac.cfg.cgRestHeight, s.g, s.ay_g);
  return s;
}
