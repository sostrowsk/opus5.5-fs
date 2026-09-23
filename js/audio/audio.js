// Synthetischer Klang per WebAudio (SPEC §3.8, PLAN §2.9) – keine Audiodateien.
//
// Motor (Lycoming O-320, 4 Zylinder, Viertakt): Ein Oszillator läuft mit der Arbeitsspiel-Frequenz
// f_c = RPM/120 (zwei Kurbelwellenumdrehungen) und trägt eine eigene PeriodicWave mit den vier Auslass-
// Druckstößen je Spiel (Zündfolge 1-3-2-4). Die Stöße unterscheiden sich leicht in Stärke, Zeitpunkt und
// Abklingen (ungleich lange Auspuffrohre der beiden Zylinderbänke) – dadurch entstehen neben der
// Zündfrequenz f_z = RPM/30 = 4·f_c auch die halben Ordnungen, die den typischen „bollernden“ Klang eines
// Flugmotors ausmachen. Last (Saugrohrdruck) macht die Stöße härter: Überblendung weiche → harte Welle,
// mehr Sättigung, höherer Tiefpass und lautere Auspuff-„Bellen“ (Rauschen, im Takt der Zündungen gepulst).
// Die Streuung von Arbeitsspiel zu Arbeitsspiel ist ein Sample-&-Hold-Rauschen, dessen Abspielrate der
// Zündfrequenz folgt – im Leerlauf stark (unrunder Leerlauf), unter Last dezenter. Eine langsame
// Drehzahl-Schwankung (±0,6 %) verhindert den sterilen Synth-Klang.
// Propeller: eigene Welle mit zwei (leicht ungleichen) Blattimpulsen pro Umdrehung → Blattfrequenz RPM/30,
// Helligkeit nach Blattspitzen-Machzahl, dazu blattfrequent moduliertes Rauschen.
// Alles läuft über einen gemeinsamen Kabinenfilter (Tiefpass ~4 kHz + Resonanz um 120 Hz).
//
// audioParams() ist eine reine Funktion (Zustand → Zielwerte) und wird unter Node getestet.
import { clamp } from '../sim/math.js';

const TAU = Math.PI * 2;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- Motor-/Propellerdaten
export const ENGINE_SOUND = {
  // Zylinder in Zündreihenfolge: relative Stärke, Zeitversatz (Anteil eines Zündabstands), Abkling-Faktor
  amp: [1.0, 0.86, 0.95, 0.8],
  shift: [0, 0.05, -0.035, 0.025],
  decay: [1.0, 1.2, 1.0, 1.15],
  propDiameter: 1.905,
  jitterBaseHz: 40, // Stufenrate des Sample-&-Hold-Puffers bei playbackRate 1
};

/** Fourier-Koeffizienten (für createPeriodicWave) einer periodischen Funktion f(u), u ∈ [0, 1). */
export function fourier(f, harmonics, N = 2048) {
  const x = new Float64Array(N);
  let mean = 0;
  for (let j = 0; j < N; j++) {
    x[j] = f(j / N);
    mean += x[j];
  }
  mean /= N;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    // Phasor-Rekursion statt cos/sin pro Sample
    const c = Math.cos((TAU * k) / N), s = Math.sin((TAU * k) / N);
    let pc = 1, ps = 0, a = 0, b = 0;
    for (let j = 0; j < N; j++) {
      const v = x[j] - mean;
      a += v * pc;
      b += v * ps;
      const npc = pc * c - ps * s;
      ps = pc * s + ps * c;
      pc = npc;
    }
    real[k] = (2 * a) / N;
    imag[k] = (2 * b) / N;
  }
  return { real, imag };
}

// Druckstoß: schneller Anstieg, exponentielles Abklingen (t in Zündabständen)
const g = (t, tau) => (t > 0 ? (t / tau) * Math.exp(1 - t / tau) : 0);

/** Eine Periode = ein Arbeitsspiel (720° KW) mit vier Zündungen; pulse(t, decayMul) je Zylinder. */
function cycleShape(pulse) {
  const E = ENGINE_SOUND;
  return (u) => {
    let x = 0;
    for (let k = 0; k < 4; k++) {
      let t = (u * 4 - k - E.shift[k]) % 4; // Zeit seit der Zündung von Zylinder k (in Zündabständen)
      if (t < 0) t += 4;
      x += E.amp[k] * pulse(t, E.decay[k]);
    }
    return x;
  };
}

/** Weiche Welle (Leerlauf, Teillast): runde Stöße mit Nachschwinger (Unterdruck im Auspuff). */
export const softPulse = (t, m) => g(t, 0.1 * m) - 0.38 * g(t - 0.2, 0.17 * m);
/** Harte Welle (Volllast): steile Flanke, Klingeln des Auspuffs, kräftiger Rückschwinger. */
export const hardPulse = (t, m) =>
  g(t, 0.035 * m) + (t > 0 ? 0.32 * Math.exp(-t / (0.1 * m)) * Math.sin(TAU * 5.5 * t) : 0) - 0.42 * g(t - 0.12, 0.13 * m);
/** Schmale Zündimpulse für die Amplitudenmodulation des Auspuff-Rauschens. */
const puffPulse = (t) => Math.exp(-(((t - 0.05) / 0.045) ** 2)) + Math.exp(-(((t - 4.05) / 0.045) ** 2));

/** Propeller: eine Periode = eine Umdrehung, zwei Blattimpulse (Spurlauf nie ganz gleich). */
function propShape(u) {
  const b = (d) => Math.exp(-((d / 0.075) ** 2));
  const d1 = ((u + 0.5) % 1) - 0.5, d2 = ((u + 1) % 1) - 0.5;
  return b(d1) + 0.93 * b(d2) - 0.25 * b((((u + 0.25) % 1) - 0.5) * 0.6);
}

export function engineWaves(harmonics = 192) {
  return {
    soft: fourier(cycleShape(softPulse), harmonics),
    hard: fourier(cycleShape(hardPulse), harmonics),
    puff: fourier(cycleShape(puffPulse), 96),
    prop: fourier(propShape, 64),
  };
}

// ---------------------------------------------------------------- Reine Parameter-Abbildung
/**
 * Zielwerte des Klangs aus dem Simulationszustand.
 * o: { external, paused, muted, volume (0..100), flapsMoving }
 */
export function audioParams(s, ctl = {}, o = {}) {
  const crashed = !!s.crashed;
  const rpm = crashed ? 0 : Math.max(0, s.rpm || 0);
  const running = !crashed && !!s.engineRunning;
  const thr = clamp(s.thrEff ?? ctl.throttle ?? 0, 0, 1);
  // Saugrohrdruck-Anteil wie im Motormodell (Leerlauf-Luftmenge konstant → sinkt mit der Drehzahl)
  const load = running ? clamp(thr + (1 - thr) * 0.128 * Math.min(1, 700 / Math.max(rpm, 1)), 0, 1) : 0;
  const rpmN = rpm / 2700;
  const cycleHz = rpm / 120;
  const firingHz = rpm / 30;
  const ext = !!o.external;

  // Motor
  const idleRough = 1 - smooth(650, 1500, rpm);
  const rough = running ? clamp(0.07 + 0.38 * idleRough + 0.12 * load, 0, 0.6) : 0;
  const engGain = running ? (0.34 + 0.5 * load) * (0.55 + 0.45 * Math.min(1, rpmN)) : 0;
  const hardMix = running ? smooth(0.12, 0.85, load) : 0;
  const drive = 0.35 + 0.7 * load;
  const engCutoff = 240 + 1900 * Math.pow(load, 1.3) + 0.35 * rpm;
  const puffGain = running ? (0.07 + 0.3 * load) * (ext ? 1.5 : 1) : 0;
  const puffCutoff = 650 + 2800 * load + 0.3 * rpm;
  const starter = !crashed && !s.propBroken && ctl.ignition === 'START';
  const cranking = !running && rpm > 15;
  const crankGain = cranking ? (starter ? 0.9 : 0.14) * Math.min(1, rpm / 180) : 0;
  const starterGain = starter ? 0.3 : 0;
  const starterHz = 620 + 1.5 * Math.min(rpm, 400);

  // Propeller: Blattspitzen-Machzahl bestimmt Pegel und Helligkeit
  const V = Math.max(0, s.tas_kt || 0) * 0.5144;
  const tip = Math.hypot((Math.PI * ENGINE_SOUND.propDiameter * rpm) / 60, rpm > 1 ? V : 0);
  const mach = tip / 340;
  const turning = rpm > 20;
  const propGain = turning ? (0.05 + 0.4 * smooth(0.25, 0.85, mach)) * (0.45 + 0.55 * load) * (ext ? 1.5 : 1) : 0;
  const propCutoff = 260 + 3300 * smooth(0.35, 0.9, mach);
  const propNoise = turning ? 0.22 * smooth(0.3, 0.9, mach) * (0.3 + 0.7 * load) : 0;

  // Fahrtwind ∝ IAS (Pegel quadratisch, Frequenz linear), mehr bei Schiebeflug
  const ias = crashed ? 0 : Math.max(0, s.ias_kt || 0);
  const beta = Math.min(20, Math.abs(s.beta_deg || 0));
  const w = ias / 100;
  const windGain = 0.3 * Math.min(2.2, w * w) * (1 + beta / 12) * (ext ? 0.35 : 1);
  const windHz = 180 + 7 * ias;
  const hissGain = 0.09 * smooth(55, 150, ias) * (1 + beta / 15) * (ext ? 0.3 : 1);

  // Überziehwarnung
  const hornGain = !crashed && s.stallWarning ? 0.2 : 0;

  // Reifen
  const contact = crashed ? 0 : (s.wheelContact || []).reduce((n, c) => n + (c ? 1 : 0), 0) / 3;
  const gsMs = Math.max(0, s.gs_kt || 0) * 0.5144;
  const grass = s.surface === 'grass';
  const rollGain = contact * (grass ? 0.14 : 0.2) * Math.pow(clamp(gsMs / 28, 0, 1.3), 1.2);
  const rollCutoff = (grass ? 260 : 380) + 28 * gsMs;
  const rumbleGain = contact * (grass ? 0.55 : 0.14) * clamp(gsMs / 15, 0, 1);

  // Klappenmotor & Warnton (VNE, Überdrehzahl)
  const flapGain = !crashed && o.flapsMoving ? 0.09 : 0;
  const flapHz = 105 * (1 - 0.12 * clamp(ias / 85, 0, 1));
  const warnGain = !crashed && (s.warnings || []).some((x) => x === 'VNE' || x === 'RPM') ? 0.09 : 0;

  const vol = clamp((o.volume ?? 70) / 100, 0, 1);
  return {
    rpm, running, load, cycleHz, firingHz, rough, jitterRate: firingHz / ENGINE_SOUND.jitterBaseHz,
    wander: cycleHz * 0.006,
    engGain, softGain: 1 - hardMix, hardGain: hardMix, drive, driveComp: 1 / (0.45 + 0.55 * drive), engCutoff,
    puffGain, puffCutoff, crankGain, starterGain, starterHz,
    propGain, propCutoff, propNoise, mach,
    windGain, windHz, hissGain, hornGain,
    rollGain, rollCutoff, rumbleGain, flapGain, flapHz, warnGain,
    cabinCutoff: ext ? 14000 : 4200, cabinBoom: ext ? 0 : 5,
    master: o.paused || o.muted ? 0 : 0.8 * vol * vol,
  };
}

// ---------------------------------------------------------------- Puffer (prozedural)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBuffer(ctx, seconds, fill) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  fill(d, ctx.sampleRate);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 1) for (let i = 0; i < n; i++) d[i] /= peak;
  return buf;
}

const whiteFill = (seed) => (d) => {
  const r = rng(seed);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
};
// Rosa Rauschen (Paul Kellet) – natürlicher für Wind und Propeller-Rauschen
const pinkFill = (seed) => (d) => {
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
};
// Streuung von Arbeitsspiel zu Arbeitsspiel: Stufen mit kurzer Überblendung (keine Klicks)
const jitterFill = (d, sr) => {
  const r = rng(172);
  const step = Math.round(sr / ENGINE_SOUND.jitterBaseHz);
  const fade = Math.round(step * 0.15);
  let prev = 0;
  for (let i = 0; i < d.length; i += step) {
    // gelegentlich ein deutlich schwächerer Takt (magerer/unvollständiger Verbrennungsablauf)
    const v = r() < 0.06 ? -0.9 - 0.1 * r() : r() * 2 - 1;
    for (let j = 0; j < step && i + j < d.length; j++) d[i + j] = j < fade ? prev + ((v - prev) * j) / fade : v;
    prev = v;
  }
  // Nahtlos loopen: Ende auf den Anfangswert überblenden
  for (let j = 0; j < fade && j < d.length; j++) {
    const k = d.length - fade + j;
    d[k] = d[k] + ((d[0] - d[k]) * j) / fade;
  }
};
// Langsames, glattes Zufallssignal (±1) für Drehzahl-Schwankung und Wind-Flattern
const wanderFill = (d, sr) => {
  const r = rng(1982);
  const seg = Math.round(sr * 0.45);
  const pts = Array.from({ length: Math.ceil(d.length / seg) + 1 }, () => r() * 2 - 1);
  pts[pts.length - 1] = pts[0];
  for (let i = 0; i < d.length; i++) {
    const k = Math.floor(i / seg), u = (i % seg) / seg;
    const s = u * u * (3 - 2 * u);
    d[i] = pts[k] + (pts[k + 1] - pts[k]) * s;
  }
};
// Reifenquietschen beim Aufsetzen: drei gleitende Teiltöne + Rauschanteil
const screechFill = (d, sr) => {
  const r = rng(7);
  const parts = [[1180, 1], [1730, 0.55], [2460, 0.3]];
  const ph = [0, 0, 0];
  let lp = 0, hp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.008) * (0.75 * Math.exp(-t / 0.16) + 0.25 * Math.exp(-t / 0.45));
    let x = 0;
    for (let k = 0; k < 3; k++) {
      const f = parts[k][0] * (1 - 0.06 * t + 0.012 * Math.sin(TAU * (13 + 4 * k) * t));
      ph[k] += (TAU * f) / sr;
      x += parts[k][1] * Math.sin(ph[k]);
    }
    const n = r() * 2 - 1;
    lp += 0.35 * (n - lp);
    hp = n - lp;
    d[i] = env * (0.55 * x + 0.35 * hp);
  }
};
// Dumpfer Stoß (Fahrwerk): abfallender Sinus + Klick + kurzes Klappern
const thumpFill = (d, sr) => {
  const r = rng(11);
  let ph = 0, lp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const f = 42 + 55 * Math.exp(-t / 0.045);
    ph += (TAU * f) / sr;
    const n = r() * 2 - 1;
    lp += 0.08 * (n - lp);
    const click = t < 0.006 ? n * (1 - t / 0.006) * 0.5 : 0;
    d[i] = Math.sin(ph) * Math.exp(-t / 0.075) * 0.95 + click + lp * 2.2 * Math.exp(-t / 0.1);
  }
};
// Aufprall: tiefer Schlag, Knirschen, metallische Teiltöne
const crashFill = (d, sr) => {
  const r = rng(99);
  let ph = 0, lp = 0, lp2 = 0;
  const hits = Array.from({ length: 9 }, () => r() * 0.9);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    ph += (TAU * (34 + 30 * Math.exp(-t / 0.08))) / sr;
    const n = r() * 2 - 1;
    const k = 0.05 + 0.4 * Math.exp(-t / 0.3);
    lp += k * (n - lp);
    lp2 += 0.02 * (n - lp2);
    let crunch = 0;
    for (const h of hits) if (t >= h && t < h + 0.05) crunch += n * (1 - (t - h) / 0.05) * 0.6;
    const metal = (Math.sin(TAU * 311 * t) + 0.7 * Math.sin(TAU * 523 * t) + 0.5 * Math.sin(TAU * 877 * t)) * 0.12 * Math.exp(-t / 0.7);
    d[i] = Math.sin(ph) * Math.exp(-t / 0.45) + lp * 1.6 * Math.exp(-t / 0.9) + lp2 * 3 * Math.exp(-t / 0.4) + crunch + metal;
  }
};

// ---------------------------------------------------------------- Graph
/** Baut den kompletten Klang-Graphen auf einem (Offline-)AudioContext. Rückgabe: Parameter + One-Shots. */
export function buildGraph(ctx, dest = ctx.destination) {
  const waves = engineWaves();
  const pw = (w) => ctx.createPeriodicWave(w.real, w.imag);
  const white = makeBuffer(ctx, 2.1, whiteFill(1));
  const pink = makeBuffer(ctx, 3.3, pinkFill(2));
  const jitter = makeBuffer(ctx, 4, jitterFill);
  const wanderBuf = makeBuffer(ctx, 9, wanderFill);
  const sources = [];

  const gain = (v = 1) => {
    const n = ctx.createGain();
    n.gain.value = v;
    return n;
  };
  const biquad = (type, f, Q = 0.707, gdb = 0) => {
    const n = ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = Q;
    n.gain.value = gdb;
    return n;
  };
  const osc = (typeOrWave, f = 0) => {
    const n = ctx.createOscillator();
    if (typeof typeOrWave === 'string') n.type = typeOrWave;
    else n.setPeriodicWave(typeOrWave);
    n.frequency.value = f;
    sources.push(n);
    return n;
  };
  const loop = (buf, rate = 1) => {
    const n = ctx.createBufferSource();
    n.buffer = buf;
    n.loop = true;
    n.playbackRate.value = rate;
    sources.push(n);
    return n;
  };
  const chain = (...nodes) => {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  };

  // Master: Kabinenfilter → Resonanz → Hochpass (Schutz vor DC/Subbass) → Lautstärke → Kompressor
  const bus = gain(1);
  const cabinLP = biquad('lowpass', 4200, 0.6);
  const cabinBoom = biquad('peaking', 120, 1.1, 5);
  const subCut = biquad('highpass', 26, 0.7);
  const master = gain(0);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.008;
  comp.release.value = 0.25;
  chain(bus, cabinLP, cabinBoom, subCut, master, comp, dest);

  // Frequenz-Bus: f_c (Arbeitsspiel) + langsame Schwankung → alle drehzahlfesten Oszillatoren
  const fc = ctx.createConstantSource();
  fc.offset.value = 0;
  sources.push(fc);
  const wanderSrc = loop(wanderBuf, 1);
  const wanderG = gain(0);
  const fSum = gain(1);
  fc.connect(fSum);
  chain(wanderSrc, wanderG, fSum);
  const shaft = gain(2); // Kurbelwelle = 2·f_c
  const bpf = gain(4); // Blatt-/Zündfrequenz = 4·f_c
  fSum.connect(shaft);
  fSum.connect(bpf);

  // Motor-Grundklang
  const oSoft = osc(pw(waves.soft));
  const oHard = osc(pw(waves.hard));
  const oPulse = osc(pw(waves.puff));
  for (const o of [oSoft, oHard, oPulse]) fSum.connect(o.frequency);
  const gSoft = gain(1), gHard = gain(0);
  const engAM = gain(1);
  oSoft.connect(gSoft).connect(engAM);
  oHard.connect(gHard).connect(engAM);
  const jitSrc = loop(jitter, 0);
  const jitG = gain(0);
  chain(jitSrc, jitG, engAM.gain);
  const engDrive = gain(0.35);
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2) + 0.04 * x * x; // leicht asymmetrisch (geradzahlige Obertöne)
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  const engComp = gain(1);
  const engBody = biquad('peaking', 95, 1.4, 6); // Resonanz Auspuff/Motorträger
  const engLP = biquad('lowpass', 400, 0.9);
  const engOut = gain(0);
  chain(engAM, engDrive, shaper, engComp, engBody, engLP, engOut, bus);

  // Auspuff-„Bellen“: Rauschen im Takt der Zündungen gepulst; beim Durchdrehen ohne Zündung Kompressionsstöße
  const nW1 = loop(white);
  const puffHP = biquad('highpass', 240, 0.7);
  const puffAM = gain(0.1);
  const pulseDepth = gain(1);
  chain(oPulse, pulseDepth, puffAM.gain);
  const puffLP = biquad('lowpass', 900, 0.8);
  const puffOut = gain(0);
  chain(nW1, puffHP, puffAM, puffLP, puffOut, bus);
  const crankLP = biquad('lowpass', 520, 1.2);
  const crankOut = gain(0);
  chain(puffAM, crankLP, crankOut, bus);

  // Propeller-Ton + blattfrequent moduliertes Rauschen
  const oProp = osc(pw(waves.prop));
  shaft.connect(oProp.frequency);
  const propLP = biquad('lowpass', 600, 0.8);
  const propOut = gain(0);
  chain(oProp, propLP, propOut, bus);
  const oBlade = osc('sine'); // Blatt- = Kompressionsfrequenz (4·f_c)
  bpf.connect(oBlade.frequency);
  const nP1 = loop(pink);
  const propBP = biquad('bandpass', 650, 0.7);
  const propAM = gain(0.55);
  const bladeDepth = gain(0.45);
  chain(oBlade, bladeDepth, propAM.gain);
  const propNoiseOut = gain(0);
  chain(nP1, propBP, propAM, propNoiseOut, bus);

  // Anlasser: Heulen des Anlassermotors, bei jeder Kompression kurz gebremst (FM + AM im Kompressionstakt)
  const starterF = ctx.createConstantSource();
  starterF.offset.value = 620;
  sources.push(starterF);
  const oStarter = osc('sawtooth');
  starterF.connect(oStarter.frequency);
  const starterFM = gain(0);
  chain(oBlade, starterFM, oStarter.frequency);
  const starterBP = biquad('bandpass', 1100, 1.8);
  const starterOut = gain(0);
  const starterAM = gain(0);
  chain(oBlade, starterAM, starterOut.gain);
  chain(oStarter, starterBP, starterOut, bus);
  const grindBP = biquad('bandpass', 2600, 3);
  const grindG = gain(0.3);
  chain(nW1, grindBP, grindG, starterBP);

  // Fahrtwind: rosa Rauschen, Bandpass ∝ IAS, Flattern; dazu Zischen an Tür-/Fensterdichtungen
  const nP2 = loop(pink, 0.97);
  const windBP = biquad('bandpass', 400, 0.55);
  const windOut = gain(0);
  chain(nP2, windBP, windOut, bus);
  const flutterSrc = loop(wanderBuf, 3.1);
  const flutterG = gain(0);
  chain(flutterSrc, flutterG, windOut.gain);
  const nW2 = loop(white, 1.03);
  const hissHP = biquad('highpass', 2600, 0.7);
  const hissPeak = biquad('peaking', 3400, 2, 6);
  const hissOut = gain(0);
  chain(nW2, hissHP, hissPeak, hissOut, bus);

  // Stall-Horn: Zungenpfeife (zwei leicht verstimmte Sägezähne → Schwebung), Formant ~1,65 kHz, Flattern
  const oH1 = osc('sawtooth', 482);
  const oH2 = osc('sawtooth', 486.5);
  const hornBP = biquad('bandpass', 1650, 1.5);
  const hornLP = biquad('lowpass', 3600, 0.7);
  const hornAM = gain(1);
  const hornLfo = osc('sine', 27);
  const hornLfoG = gain(0.16);
  chain(hornLfo, hornLfoG, hornAM.gain);
  const hornOut = gain(0);
  oH1.connect(hornBP);
  oH2.connect(hornBP);
  chain(hornBP, hornLP, hornAM, hornOut, bus);

  // Reifen: Abrollen (Tiefpass-Rauschen ∝ Geschwindigkeit) + Poltern (Gras/Unebenheiten)
  const nW3 = loop(white, 0.91);
  const rollLP = biquad('lowpass', 400, 0.8);
  const rollOut = gain(0);
  chain(nW3, rollLP, rollOut, bus);
  const nP3 = loop(pink, 0.83);
  const rumbleLP = biquad('lowpass', 110, 1.0);
  const rumbleOut = gain(0);
  chain(nP3, rumbleLP, rumbleOut, bus);

  // Klappenmotor: Elektromotor + Getriebe
  const oFlap = osc('sawtooth', 105);
  const oFlap2 = osc('square', 415);
  const flapBP = biquad('bandpass', 340, 1.3);
  const flapG2 = gain(0.22);
  const flapOut = gain(0);
  oFlap.connect(flapBP);
  chain(oFlap2, flapG2, flapBP);
  chain(flapBP, flapOut, bus);

  // Warnton VNE / Überdrehzahl: unterbrochener Ton, klar vom Stall-Horn unterscheidbar
  const oWarn = osc('sine', 1250);
  const warnAM = gain(0.5);
  const oWarnLfo = osc('square', 2.2);
  const warnLfoG = gain(0.5);
  chain(oWarnLfo, warnLfoG, warnAM.gain);
  const warnOut = gain(0);
  chain(oWarn, warnAM, warnOut, bus);

  const t0 = ctx.currentTime + 0.01;
  const r = rng(5);
  for (const s of sources) {
    if (s.buffer) s.start(t0, r() * s.buffer.duration * 0.9);
    else s.start(t0);
  }

  const oneShots = {
    screech: makeBuffer(ctx, 0.9, screechFill),
    thump: makeBuffer(ctx, 0.4, thumpFill),
    crash: makeBuffer(ctx, 2.4, crashFill),
  };

  return {
    ctx,
    bus,
    oneShots,
    p: {
      master: master.gain, cabinCutoff: cabinLP.frequency, cabinBoom: cabinBoom.gain,
      fc: fc.offset, wander: wanderG.gain, jitterRate: jitSrc.playbackRate, jitter: jitG.gain,
      softGain: gSoft.gain, hardGain: gHard.gain, drive: engDrive.gain, driveComp: engComp.gain,
      engCutoff: engLP.frequency, engGain: engOut.gain,
      puffCutoff: puffLP.frequency, puffGain: puffOut.gain, crankGain: crankOut.gain,
      propCutoff: propLP.frequency, propGain: propOut.gain, propNoise: propNoiseOut.gain,
      starterHz: starterF.offset, starterFM: starterFM.gain, starterGain: starterOut.gain, starterAM: starterAM.gain,
      windHz: windBP.frequency, windGain: windOut.gain, flutter: flutterG.gain, hissGain: hissOut.gain,
      hornGain: hornOut.gain,
      rollCutoff: rollLP.frequency, rollGain: rollOut.gain, rumbleGain: rumbleOut.gain,
      flapHz: oFlap.frequency, flapHz2: oFlap2.frequency, flapGain: flapOut.gain,
      warnGain: warnOut.gain,
    },
    /** Einen One-Shot-Puffer abspielen. */
    play(name, level, rate = 1, when = ctx.currentTime) {
      const buf = oneShots[name];
      if (!buf || level <= 0) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gn = gain(Math.min(1.2, level));
      src.connect(gn).connect(bus);
      src.onended = () => gn.disconnect();
      src.start(when);
    },
  };
}

/** Graph-Zielwerte setzen (setTargetAtTime, keine Klicks). set(param, value, timeConstant). */
export function applyParams(G, P, set) {
  const p = G.p;
  set(p.master, P.master, 0.08);
  set(p.cabinCutoff, P.cabinCutoff, 0.1);
  set(p.cabinBoom, P.cabinBoom, 0.1);
  set(p.fc, P.cycleHz, 0.03);
  set(p.wander, P.wander, 0.1);
  set(p.jitterRate, P.jitterRate, 0.03);
  set(p.jitter, P.rough, 0.1);
  set(p.softGain, P.softGain, 0.08);
  set(p.hardGain, P.hardGain, 0.08);
  set(p.drive, P.drive, 0.08);
  set(p.driveComp, P.driveComp, 0.08);
  set(p.engCutoff, P.engCutoff, 0.06);
  set(p.engGain, P.engGain, P.running ? 0.05 : 0.12);
  set(p.puffCutoff, P.puffCutoff, 0.06);
  set(p.puffGain, P.puffGain, 0.05);
  set(p.crankGain, P.crankGain, 0.05);
  set(p.propCutoff, P.propCutoff, 0.08);
  set(p.propGain, P.propGain, 0.06);
  set(p.propNoise, P.propNoise, 0.06);
  set(p.starterHz, P.starterHz, 0.05);
  set(p.starterFM, P.starterGain > 0 ? P.starterHz * 0.14 : 0, 0.05);
  set(p.starterGain, P.starterGain, 0.03);
  set(p.starterAM, P.starterGain * 0.45, 0.03);
  set(p.windHz, P.windHz, 0.1);
  set(p.windGain, P.windGain, 0.1);
  set(p.flutter, P.windGain * 0.18, 0.1);
  set(p.hissGain, P.hissGain, 0.1);
  set(p.hornGain, P.hornGain, 0.03);
  set(p.rollCutoff, P.rollCutoff, 0.08);
  set(p.rollGain, P.rollGain, 0.06);
  set(p.rumbleGain, P.rumbleGain, 0.06);
  set(p.flapHz, P.flapHz, 0.1);
  set(p.flapHz2, P.flapHz * 3.95, 0.1);
  set(p.flapGain, P.flapGain, 0.06);
  set(p.warnGain, P.warnGain, 0.03);
}

/**
 * Klang-Ereignisse aus dem Zustandswechsel (Aufsetzen, Fahrwerksstöße, Crash). Reine Funktion.
 * mem: { contact[3], comp[3], vy, crashed, lastHit[3], time } – wird fortgeschrieben.
 * Rückgabe: Liste [name, level, rate]
 */
export function detectEvents(s, mem, dt) {
  const out = [];
  const now = (mem.time = (mem.time || 0) + dt);
  mem.contact ||= [false, false, false];
  mem.comp ||= [0, 0, 0];
  mem.lastHit ||= [-1, -1, -1];
  const gsMs = Math.max(0, s.gs_kt || 0) * 0.5144;
  const vImp = Math.max(0, -(mem.vy ?? 0)); // Sinkgeschwindigkeit vor dem Kontakt (m/s)
  if (s.crashed && !mem.crashed) out.push(['crash', 0.9, 1]);
  if (!s.crashed) {
    for (let i = 0; i < 3; i++) {
      const c = !!s.wheelContact?.[i];
      const comp = s.gearCompression?.[i] || 0;
      if (c && !mem.contact[i] && now - mem.lastHit[i] > 0.25 && (vImp > 0.2 || gsMs > 8)) {
        mem.lastHit[i] = now;
        out.push(['thump', clamp(0.12 + vImp * 0.35, 0, 1) * (i === 0 ? 0.7 : 1), 0.95 + 0.1 * i]);
        // Quietschen: Rad muss beim Aufsetzen auf Rollgeschwindigkeit hochdrehen (nur Asphalt, Haupträder)
        if (i > 0 && s.surface === 'asphalt' && gsMs > 12) {
          out.push(['screech', clamp((gsMs - 10) / 25, 0, 1) * clamp(0.35 + vImp * 0.4, 0, 1) * 0.55, i === 1 ? 0.97 : 1.04]);
        }
      } else if (c && mem.contact[i] && dt > 0) {
        // Fahrwerksstoß beim Rollen (Unebenheit): schnelles Einfedern
        const rate = (comp - mem.comp[i]) / dt;
        if (rate > 0.35 && now - mem.lastHit[i] > 0.2) {
          mem.lastHit[i] = now;
          out.push(['thump', clamp(rate * 0.12, 0.03, 0.35), 1.1]);
        }
      }
      mem.contact[i] = c;
      mem.comp[i] = comp;
    }
  }
  mem.crashed = !!s.crashed;
  mem.vy = s.v ? s.v[1] : (s.vs_fpm || 0) * 0.00508;
  return out;
}

// ---------------------------------------------------------------- Laufzeit-Hülle
/**
 * Audio-Hülle für die Seite: Der AudioContext entsteht erst bei der ersten Nutzerinteraktion (unlock()).
 * update(state, controls, { dt, external, paused, muted, volume }) pro Frame.
 */
export function createAudio() {
  let ctx = null;
  let G = null;
  let failed = false;
  let hidden = false;
  const cache = new Map();
  const mem = {};
  let prevFlaps = null;
  let flapsMovingT = 0;
  let last = null;

  function set(param, v, tc) {
    const prev = cache.get(param);
    if (prev !== undefined && Math.abs(prev - v) <= 1e-4 * Math.max(1, Math.abs(v))) return;
    cache.set(param, v);
    param.setTargetAtTime(v, ctx.currentTime, tc);
  }

  function unlock() {
    if (failed) return;
    try {
      if (!ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) {
          failed = true;
          return;
        }
        ctx = new AC({ latencyHint: 'interactive' });
        G = buildGraph(ctx);
      }
      if (ctx.state !== 'running' && !hidden) ctx.resume().catch(() => {});
    } catch {
      failed = true;
    }
  }

  function update(s, ctl, o = {}) {
    const dt = o.dt || 0;
    if (prevFlaps !== null && dt > 0) {
      const moving = Math.abs(s.flapsDeg - prevFlaps) / dt > 0.3;
      flapsMovingT = moving ? 0.12 : Math.max(0, flapsMovingT - dt); // kurze Nachlaufzeit gegen Flackern
    }
    prevFlaps = s.flapsDeg;
    const P = audioParams(s, ctl, { ...o, flapsMoving: flapsMovingT > 0 });
    last = P;
    const ev = detectEvents(s, mem, o.paused ? 0 : dt);
    if (!G || ctx.state !== 'running') return;
    applyParams(G, P, set);
    if (!o.paused) for (const [name, level, rate] of ev) G.play(name, level, rate);
  }

  function setHidden(h) {
    hidden = h;
    if (!ctx) return;
    if (h) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  }

  function debug() {
    if (!G) return { state: ctx ? ctx.state : 'none', unlocked: !!ctx, target: last };
    const p = G.p;
    return {
      state: ctx.state,
      unlocked: true,
      sampleRate: ctx.sampleRate,
      firingHz: p.fc.value * 4, // Zündfrequenz des Motor-Oszillators (4 Zündungen je Arbeitsspiel)
      expectedFiringHz: last ? last.firingHz : 0,
      engineGain: p.engGain.value,
      windGain: p.windGain.value,
      hornGain: p.hornGain.value,
      propGain: p.propGain.value,
      rollGain: p.rollGain.value,
      master: p.master.value,
      target: last,
    };
  }

  return {
    unlock,
    update,
    setHidden,
    debug,
    get context() {
      return ctx;
    },
    get graph() {
      return G;
    },
  };
}
