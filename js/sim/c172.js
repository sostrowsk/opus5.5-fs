// Cessna 172P – reine Daten (SI-Einheiten, Winkel in rad sofern nicht anders angegeben).
// Body-Achsen: x vorn, y rechts, z unten; Ursprung im Schwerpunkt.
// Getunt wird NUR hier (siehe tests/physics.test.mjs für die Akzeptanzkriterien).
const D = Math.PI / 180;

export const C172 = {
  // ------------------------------------------------------------ Geometrie & Masse
  S: 16.17, // m² Flügelfläche
  b: 10.97, // m Spannweite
  c: 1.49, // m mittlere aerodynamische Flügeltiefe
  massDefault: 1000,
  massMin: 800,
  massMax: 1089, // MTOW 2400 lb
  massRef: 1089, // Bezugsmasse der Trägheitsmomente
  inertia: [1285, 1825, 2667], // Ixx, Iyy, Izz kg·m² bei massRef (Ixz ≈ 0)
  cgRestHeight: 1.225, // m Schwerpunkthöhe über Grund im Stand (Bezug für AGL)
  wingHeight: 1.0, // m Flügel (¼-Tiefe) über dem Schwerpunkt – Bezug für den Bodeneffekt

  // ------------------------------------------------------------ Motor (Lycoming O-320-D2J, 160 hp)
  engine: {
    powerRated: 119000, // W bei 2700 RPM, ISA Meereshöhe
    rpmRated: 2700,
    densityExp: 1.1, // Leistung ∝ σ^1,1
    idleFrac: 0.128, // Anteil des Volllast-Moments bei Gas 0 (Leerlaufanschlag) …
    idleRpm: 700, // … bei dieser Drehzahl; darüber sinkt der Saugrohrdruck im Leerlauf (∝ 1/rpm)
    throttleExp: 1.0,
    torqueCurve: 0.1, // Q(x) = Qmax·(1 − k·(x−1)²), x = rpm/2700
    fricA: 12, // N·m Reibung (Coulomb)
    fricB: 0.016, // N·m pro RPM (Pump-/Reibungsverluste)
    inertia: 1.6, // kg·m² Motor + Propeller
    starterTorque: 120, // N·m
    starterFreeRpm: 280, // Leerlaufdrehzahl des Anlassers
    fireRpm: 150, // ab hier zündet der Motor beim Durchdrehen
    catchRevs: 4, // Umdrehungen bis der Motor „kommt“
    dieRpm: 100, // darunter stirbt der Motor
    throttleTau: 0.12, // s Ansprechverhalten (Saugrohrdruck)
    rpmMax: 3200,
  },

  // ------------------------------------------------------------ Propeller (starr, McCauley 1C160, Ø 75 in)
  prop: {
    D: 1.905, // m
    // Fortschrittsgrad J = V/(n·D) – je 8 Stützstellen
    J: [0.0, 0.3, 0.6, 0.8, 1.0, 1.2, 1.5, 1.8],
    CT: [0.090, 0.086, 0.067, 0.040, 0.019, -0.014, -0.055, -0.095],
    CP: [0.0554, 0.0555, 0.050, 0.044, 0.030, 0.012, -0.018, -0.052],
    lowRpm: 100, // darunter Stand-/Anlaufbereich (kein J)
    blendRpm: 200, // 100–200 RPM weich überblendet
    diskArea: Math.PI * 0.9525 * 0.9525,
    slipH: 0.32, // Anteil des Slipstream-Staudrucks am Höhenleitwerk
    slipV: 0.55, // … am Seitenleitwerk
    pFactor: 0.9, // m/rad – Versatz der Schubachse pro Anstellwinkel (P-Faktor)
    swirl: 0.75, // Giermoment (N·m) pro N·m Propellermoment (Drall auf die Seitenflosse)
    torqueRoll: 0.6, // Anteil des Wellenmoments, der als Rollmoment wirkt (Rest hebt der Drall am Flügel auf)
    inertiaProp: 1.3, // kg·m² nur Propeller (Kreiseleffekt)
    thrustZ: 0.0, // m Schubachse unter (+)/über (−) dem Schwerpunkt
    center: [2.05, 0, -0.05], // Propellernabe (Body)
    radius: 0.9525,
  },

  // ------------------------------------------------------------ Aerodynamik
  aero: {
    CL0: 0.37,
    CLa: 5.3, // /rad
    CLq: 3.9,
    CLde: 0.43, // /rad (δe positiv = Hinterkante unten)
    alphaCrit0: 13.3 * D, // Klappen 0
    alphaCrit30: 11.9 * D, // Klappen 30
    alphaCritNeg: -12 * D,
    stallHyst: 3 * D,
    stallTau: 0.3, // s
    stallHornMargin0: 4 * D, // Horn ab αkrit − 4° (Klappen 0) …
    stallHornMargin30: 6.5 * D, // … bzw. − 6,5° (Klappen 30: Staupunkt wandert, Fahne spricht früher an)
    postStallCL: 0.80, // CL fällt nach dem Abriss auf 80 % …
    postStallSlope: 1.2, // … und weiter mit 1,2/rad
    stallDrag: 1.0, // zusätzlicher Widerstand × sin²α im Abriss
    stallCm: -0.07, // Nick-Moment im Abriss (Nase fällt)
    dropAsym: 0.3 * D, // feste Grundasymmetrie (linke Hälfte)
    dropBeta: 0.15, // Δα pro rad Schiebewinkel (Dieder/Rumpf)
    dropGain: 0.105, // Rollmoment pro ΔCL links/rechts
    dropMax: 0.035,

    CD0: 0.032,
    CDbeta: 0.17, // Widerstand × |β| (rad)
    e: 0.68, // Oswald-Faktor → k = 1/(π·e·AR)

    Cm0: 0.045,
    Cma: -1.3,
    Cmq: -15.0, // inkl. α̇-Anteil
    Cmde: -1.2,

    CYb: -0.31,
    CYp: -0.04,
    CYr: 0.21,
    CYdr: -0.187, // δr positiv = Seitenruder rechts (Nase rechts)

    Clb: -0.12,
    Clp: -0.47,
    ClrPerCL: 0.15, // Clr = 0,15·CL
    Clda: 0.105, // δa positiv = Rollen rechts
    Cldr: -0.0147,

    Cnb: 0.065,
    Cnr: -0.11,
    Cnda: -0.008, // negatives Wendemoment
    Cndr: 0.065,

    // Rigging: gleicht Propellerdrall/Moment im Reiseflug aus (feste Trimmkanten)
    ClRig: 0.00063,
    CnRig: 0.00077,
  },

  // Klappen: Stellungen und Beiwerte über dem Klappenwinkel (°)
  flaps: {
    detents: [0, 10, 20, 30],
    rate: 3, // °/s
    deg: [0, 10, 20, 30],
    dCL: [0, 0.20, 0.40, 0.56],
    dCD: [0, 0.006, 0.019, 0.042],
    dCm: [0, 0.012, 0.022, 0.028], // C172: Nase kommt beim Klappensetzen hoch
  },

  // Bodeneffekt über h/b (Flügelhöhe über Grund / Spannweite)
  groundEffect: {
    hb: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2],
    kCDi: [0.40, 0.50, 0.61, 0.70, 0.78, 0.84, 0.89, 0.95, 0.985, 1.0],
    kCL: [1.20, 1.13, 1.08, 1.05, 1.035, 1.022, 1.014, 1.006, 1.002, 1.0],
  },

  // Ruderausschläge (°) und Trimmung
  controls: {
    elevUp: 28, // Hinterkante hoch (ziehen)
    elevDown: 23, // Hinterkante runter (drücken)
    aileron: 20,
    rudder: 16,
    surfaceRate: 90, // °/s maximale Stellrate der Ruderflächen (SPEC §3.2: folgen der Eingabe nicht sprunghaft)
    trimFloat: 12, // ° Höhenruder-Floatlage bei Trimm ±1
    trimTab: 20, // ° Trimmruder-Ausschlag bei Trimm ±1 (nur Anzeige/Animation)
    noseSteer: 10, // ° Bugradlenkung bei vollem Seitenruder (langsam)
    steerMaxG: 0.4, // g – Bungee-Begrenzung der Bugradlenkung bei höherer Rollgeschwindigkeit
  },

  // ------------------------------------------------------------ Fahrwerk (Body, unbelasteter Radaufstandspunkt)
  gear: [
    { name: 'nose', pos: [1.22, 0, 1.30], k: 34000, c: 1900, travel: 0.20, steer: true, brake: null, radius: 0.18 },
    { name: 'left', pos: [-0.42, -1.27, 1.30], k: 62000, c: 3600, travel: 0.25, steer: false, brake: 'L', radius: 0.21 },
    { name: 'right', pos: [-0.42, 1.27, 1.30], k: 62000, c: 3600, travel: 0.25, steer: false, brake: 'R', radius: 0.21 },
  ],
  gearBumpFactor: 10, // Endanschlag: Steifigkeit × 10
  tire: {
    relaxLen: 0.3, // m Einlauflänge (Seitenkraft)
    slipSat: 0.12, // rad Schräglaufwinkel bis zur Haftgrenze
    lonStiff: 40, // 1/m × Normalkraft (Haftreibungs-Feder längs, ≈ 1,5 cm bis zur Haftgrenze)
    lonDamp: 1.2, // s/m × Normalkraft
    brakeMu: 0.55, // Bremsvermögen (× Normalkraft)
  },
  surfaces: {
    asphalt: { mu: 0.8, roll: 0.02 },
    grass: { mu: 0.5, roll: 0.05 },
    water: { mu: 0.1, roll: 0.3 },
  },

  // Strukturpunkte (Body) – Bodenkontakt = Crash
  structure: [
    { name: 'tail', pos: [-4.8, 0, 0.25] },
    { name: 'wingL', pos: [-0.2, -5.48, -1.05] },
    { name: 'wingR', pos: [-0.2, 5.48, -1.05] },
    { name: 'bellyF', pos: [0.8, 0, 0.75] },
    { name: 'bellyA', pos: [-2.2, 0, 0.62] },
    { name: 'cowl', pos: [1.85, 0, 0.62] },
  ],

  // ------------------------------------------------------------ Grenzen
  limits: {
    vneKias: 158,
    rpmRedline: 2700,
    gMax: 5.7, // Bruchlast (1,5 × 3,8 g)
    gMin: -2.3, // Bruchlast (1,5 × −1,52 g)
    gearCrashSpeed: 3.5, // m/s am Endanschlag
    gearForceFactor: 4, // × statische Radlast
  },

  // ------------------------------------------------------------ Fahrtmesser-Kalibrierung (POH-nah)
  asi: {
    lowerKcas: 25, // darunter keine Kalibrierung (Anzeige = KCAS)
    flaps0: { kias: [40, 50, 60, 70, 80, 100, 120, 140, 160], kcas: [49, 55, 62, 70, 80, 99, 118, 138, 157] },
    flaps30: { kias: [30, 40, 50, 60, 70, 85], kcas: [43, 49, 55, 62, 71, 85] },
  },
};
