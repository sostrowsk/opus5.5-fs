// Bootstrap: Physik mit festem Zeitschritt (js/sim/loop.js), Welt (Terrain, Himmel, Flugplatz), Außenmodell,
// Cockpit mit Instrumenten und Kopfbewegung, Zwei-Pass-Rendering (PLAN §2.4), Eingabe (Tastatur, Maus, Touch),
// Klang, Menüs/App-Zustände (SPEC §4.1) und window.SIM (js/debug.js, SPEC §6).
// Wird von js/boot.js dynamisch geladen; die Initialisierung meldet per Top-Level-await echten Fortschritt.
import * as THREE from 'three';
import { createAircraft, createControls, stepAircraft, setMass, CRASH_TEXT } from './sim/aircraft.js';
import { createAtmosphere, setAtmosphereFromEnv, windAt } from './sim/atmosphere.js';
import { applyScenario, SCENARIOS } from './sim/scenarios.js';
import { quatToThree, clamp, DEG } from './sim/math.js';
import { createLoop, PHYS_DT } from './sim/loop.js';
import { worldGround } from './world/heightfield.js';
import { createTerrain } from './world/terrain.js';
import { createWater } from './world/water.js';
import { createSky, patchHazeTree } from './world/sky.js';
import { inCloudAmount } from './world/skymodel.js';
import { createClouds } from './world/clouds.js';
import { createVegetation } from './world/vegetation.js';
import { createAirport } from './world/airport.js';
import { createAircraftModel } from './aircraft/model.js';
import { B } from './aircraft/shapes.js';
import { createInstruments } from './cockpit/instruments.js';
import { createCockpit, EYE } from './cockpit/cockpit.js';
import { createHead, stepHead, resetHead } from './cockpit/head.js';
import { createInput } from './input/input.js';
import { createPointer } from './input/pointer.js';
import { createTouch } from './input/touch.js';
import { createAudio } from './audio/audio.js';
import { loadSettings, saveSettings, sanitize, defaultSettings, prefersReducedMotion, SETTINGS_DEF } from './config.js';
import { createUI } from './ui/ui.js';
import { setProgress, hideLoading, yieldToBrowser } from './ui/progress.js';
import { installDebug } from './debug.js';

const INSTR_HZ = 30;
const MENU_ORBIT_DEG_S = 5; // Drehgeschwindigkeit der Außenansicht hinter dem Startmenü

/** Grafikqualität (SPEC §4.3): Auflösung, Schatten (PLAN §2.4: 2048² Hoch, 1024² Mittel, aus Niedrig), Baumdichte. */
export const QUALITY = {
  low: { pixelRatio: 1, shadow: 0, trees: 0.5, antialias: false },
  medium: { pixelRatio: 1.5, shadow: 1024, trees: 1, antialias: true },
  high: { pixelRatio: 2, shadow: 2048, trees: 1, antialias: true },
};

setProgress(0.42, 'Simulation initialisieren …');

// ------------------------------------------------------------------ Simulation
const settings = loadSettings();
const ENV_KEYS = ['timeOfDay', 'windDir', 'windKt', 'turbulence', 'clouds', 'cloudBase_ft', 'qnh'];
const env = {};
for (const k of ENV_KEYS) env[k] = settings[k]; // gespeicherte Einstellungen (SPEC §4.3)
const atmosphere = createAtmosphere();
setAtmosphereFromEnv(atmosphere, env);
const ac = createAircraft({ ground: worldGround, atmosphere, mass: settings.mass });
const controls = createControls();
const lights = { landing: false, nav: false, strobe: false, beacon: false };
const head = createHead();
let scenario = 'runway';
applyScenario(ac, scenario, controls);

// Live-Ansicht auf den Zustand im SPEC-§6-Format (pos/vel/quat/omega zusätzlich zu den Anzeigewerten)
const state = ac.state;
Object.defineProperties(state, {
  pos: { get: () => ({ x: state.p[0], y: state.p[1], z: state.p[2] }), enumerable: true },
  vel: { get: () => ({ x: state.v[0], y: state.v[1], z: state.v[2] }), enumerable: true },
  quat: { get: () => { const [x, y, z, w] = quatToThree(state.q); return { x, y, z, w }; }, enumerable: true },
  omega: { get: () => ({ p: state.w[0], q: state.w[1], r: state.w[2] }), enumerable: true },
});

// App-Zustände (SPEC §4.1): loading → ready (Startmenü) → running ⇄ paused → crashed; error (Grafikkontext)
const app = { state: 'loading' };

// ------------------------------------------------------------------ Renderer & Szene
setProgress(0.46, 'Renderer vorbereiten …');
await yieldToBrowser();
const canvas = document.getElementById('view');
const Q0 = QUALITY[settings.quality] || QUALITY.medium;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: Q0.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q0.pixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // Shadow-Map nur in Pass 1 (needsUpdate), Pass 2 nutzt sie wieder
renderer.autoClear = false;
renderer.info.autoReset = false; // Draw Calls über beide Pässe summieren
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 30000);
camera.rotation.order = 'YXZ';

const sky = createSky(scene);
sky.setPixelRatio(renderer.getPixelRatio());
const water = createWater();
const vegetation = createVegetation(scene);
const terrain = createTerrain(scene, {
  waterMaterial: water.material,
  waterFarMaterial: water.farMaterial,
  hooks: { onFill: vegetation.fillTile },
});
const clouds = createClouds(scene);
const airport = createAirport(scene);
patchHazeTree(airport.group);

setProgress(0.5, 'Flugzeug und Cockpit bauen …');
await yieldToBrowser();
// Flugzeug: ein Knoten für Außenmodell (Layer 0) und Cockpit (Layer 1/2)
const acRoot = new THREE.Group();
acRoot.name = 'aircraft';
scene.add(acRoot);
const model = createAircraftModel();
acRoot.add(model.group);
patchHazeTree(model.group, { cloudShadow: true }); // Außenmodell: gleicher Dunst und Wolkenschatten wie die Welt
const instruments = createInstruments();
const cockpit = createCockpit(instruments);
acRoot.add(cockpit.group);
const eyeLocal = B(...EYE);

// Aufhelllicht der Kabine (Streulicht von hinten/oben durch Fenster und Innenraum), nur Pass 2 (Layer 2).
// Ein Dummy mit Intensität 0 auf Layer 0 hält die Lichtanzahl in beiden Pässen gleich (gleiche Shader-Programme).
const cabinFill = new THREE.DirectionalLight(0xffffff, 0.5);
cabinFill.name = 'cabinFill';
cabinFill.layers.set(2);
cabinFill.position.copy(B(-1.6, 0.15, -1.1));
cabinFill.target.position.copy(B(0.8, -0.1, 0.1));
acRoot.add(cabinFill, cabinFill.target);
const fillDummy = new THREE.DirectionalLight(0xffffff, 0);
fillDummy.name = 'fillDummy';
fillDummy.layers.set(0);
scene.add(fillDummy);

// ------------------------------------------------------------------ Ansicht
const VIEWS = {
  front: { yaw: 0, pitch: 0 },
  left: { yaw: 68, pitch: 4 },
  right: { yaw: -68, pitch: 4 },
  panel: { yaw: 0, pitch: -24 },
};
const view = { mode: 'cockpit', yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, fov: settings.fov, orbitYaw: 200, orbitPitch: 12, orbitDist: 17 };
const VIEW_CYCLE = ['front', 'left', 'right', 'panel', 'external'];
let viewName = 'front';
const lookQ = new THREE.Quaternion();
const lookE = new THREE.Euler(0, 0, 0, 'YXZ');
const headQ = new THREE.Quaternion();
const headE = new THREE.Euler(0, 0, 0, 'YXZ');
const headV = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const viewDir = new THREE.Vector3();

function setView(name) {
  viewName = VIEWS[name] ? name : 'front';
  const v = VIEWS[viewName];
  view.mode = 'cockpit';
  view.tYaw = v.yaw;
  view.tPitch = v.pitch;
}
function stepView(dt) {
  // kritisch gedämpfte Annäherung (nur Blicksteuerung, kein Kamera-Shake)
  const k = 1 - Math.exp(-dt * 9);
  view.yaw += (view.tYaw - view.yaw) * k;
  view.pitch += (view.tPitch - view.pitch) * k;
  if (Math.abs(view.tYaw - view.yaw) < 0.01) view.yaw = view.tYaw;
  if (Math.abs(view.tPitch - view.pitch) < 0.01) view.pitch = view.tPitch;
}

// Darstellung zwischen den letzten beiden Physikschritten interpolieren (α aus dem Akkumulator), damit die
// Bewegung bei 60/90/144 Hz gleichmäßig ist (SPEC §3.1, AK-34).
const prevP = [0, 0, 0];
const prevQ = new THREE.Quaternion();
const curQ = new THREE.Quaternion();
let renderAlpha = 1;
function syncPrev() {
  prevP[0] = state.p[0];
  prevP[1] = state.p[1];
  prevP[2] = state.p[2];
  const [x, y, z, w] = quatToThree(state.q);
  prevQ.set(x, y, z, w);
}
function updateAircraftTransform() {
  const a = renderAlpha;
  acRoot.position.set(
    prevP[0] + (state.p[0] - prevP[0]) * a,
    prevP[1] + (state.p[1] - prevP[1]) * a,
    prevP[2] + (state.p[2] - prevP[2]) * a,
  );
  const [x, y, z, w] = quatToThree(state.q);
  curQ.set(x, y, z, w);
  acRoot.quaternion.copy(prevQ).slerp(curQ, a);
  acRoot.updateMatrixWorld(true);
}

function updateCamera() {
  if (camera.fov !== view.fov) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }
  if (view.mode === 'cockpit') {
    // Auge + Kopfbewegung (Body-Versatz ≤ 2 cm, Drehung ≤ 1°; bei 0 % exakt 0)
    const h = head.out;
    headV.copy(eyeLocal).add(B(h.x, h.y, h.z));
    camera.position.copy(headV).applyMatrix4(acRoot.matrixWorld);
    lookE.set(view.pitch * DEG, view.yaw * DEG, 0, 'YXZ');
    lookQ.setFromEuler(lookE);
    headE.set(h.pitch, 0, -h.roll, 'YXZ');
    headQ.setFromEuler(headE);
    camera.quaternion.copy(acRoot.quaternion).multiply(lookQ).multiply(headQ);
  } else {
    // Orbit um das Flugzeug (horizontal an der Flugrichtung ausgerichtet)
    const hdg = state.heading_deg * DEG;
    const a = hdg + view.orbitYaw * DEG, p = view.orbitPitch * DEG;
    tmpV.set(Math.sin(a) * Math.cos(p), Math.sin(p), -Math.cos(a) * Math.cos(p)).multiplyScalar(view.orbitDist);
    camera.position.copy(acRoot.position).add(tmpV);
    // nie unter das Gelände bzw. unter die Wasserfläche (Orbit-Nick bis −10° am Boden)
    const floor = Math.max(worldGround.height(camera.position.x, camera.position.z), worldGround.waterLevel) + 1.2;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.up.set(0, 1, 0);
    camera.lookAt(acRoot.position);
  }
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(viewDir);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/** Grafikqualität anwenden (sofort; die Kantenglättung des Kontexts erst beim nächsten Laden). */
let qualityApplied = null;
function applyQuality(q) {
  const Q = QUALITY[q] || QUALITY.medium;
  qualityApplied = q;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
  resize();
  sky.setPixelRatio(renderer.getPixelRatio());
  const sun = sky.sun;
  sun.castShadow = Q.shadow > 0; // ändert die Lichtkonfiguration → Materialien kompilieren einmal neu
  if (Q.shadow > 0 && sun.shadow.mapSize.x !== Q.shadow) {
    sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }
  vegetation.setDensity(Q.trees);
  document.body.classList.toggle('q-low', q === 'low');
}
applyQuality(settings.quality);

// ------------------------------------------------------------------ Zwei-Pass-Rendering (PLAN §2.4)
function setLayers(...ls) {
  camera.layers.disableAll();
  for (const l of ls) camera.layers.enable(l);
}
function setClip(near, far) {
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}
function renderFrame() {
  if (glLost) return;
  updateCamera();
  renderer.info.reset();
  renderer.clear();
  if (view.mode === 'cockpit') {
    // Pass 1: Welt + Außenmodell + Cockpit grob (Schattenwerfer!), Shadow-Map wird hier erzeugt
    setLayers(0, 1);
    setClip(0.5, 30000);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    // Pass 2: Cockpit fein (opak + Gläser), Shadow-Map wiederverwenden
    renderer.clearDepth();
    setLayers(1, 2);
    setClip(0.02, 10);
    renderer.shadowMap.needsUpdate = false;
    // Wolkenschatten am Flugzeug: das Cockpit über die Sonnenintensität (Welt und Außenmodell per cloudShadow im Shader)
    const sunI = sky.sun.intensity;
    sky.sun.intensity = sunI * world.sunShade;
    renderer.render(scene, camera);
    sky.sun.intensity = sunI;
  } else {
    const cabin = sky.hemiCabin.intensity, fill = cabinFill.intensity;
    sky.hemiCabin.intensity = 0;
    cabinFill.intensity = 0;
    setLayers(0, 1, 2);
    setClip(0.3, 30000);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    sky.hemiCabin.intensity = cabin;
    cabinFill.intensity = fill;
  }
}

// ------------------------------------------------------------------ Welt- und Anzeige-Update
const sunLocal = new THREE.Vector3();
const invQ = new THREE.Quaternion();
const lightDir = new THREE.Vector3();
const cloudCol = new THREE.Color();
const NIGHT_RED = new THREE.Color(1.0, 0.22, 0.16);
const windCloud = [0, 0, 0], windSurf = [0, 0, 0];
const world = { inCloud: 0, cloudDensityAc: 0, sunShade: 1 };
let instrAcc = 0;
function worldUpdate(dtSim, budget = 2) {
  updateAircraftTransform();
  terrain.update(state.p[0], state.p[2], budget);
  vegetation.commit();
  updateCamera();
  terrain.setCamera(camera.position.x, camera.position.z);
  // Wolken (Darstellung, Schattentextur); Dichte an der Kamera → Sicht in der Wolke
  clouds.update(camera.position, viewDir, camera.fov, camera.aspect, dtSim, env);
  const p = acRoot.position;
  world.inCloud = inCloudAmount(clouds.densityAt(camera.position.x, camera.position.y, camera.position.z));
  lightDir.copy(sky.sun.position).sub(sky.sun.target.position).normalize();
  world.sunShade = clouds.sunShadeAt(p.x, p.y, p.z, lightDir);
  sky.update(env.timeOfDay, p, camera.position, viewDir, {
    inCloud: world.inCloud,
    cloudColor: clouds.insideColor(cloudCol),
    coverage: env.clouds / 100,
    sunShade: world.sunShade,
  });
  clouds.setLighting(sky);
  renderer.toneMappingExposure = sky.state.exposure;
  water.update(dtSim, {
    windKt: env.windKt, light: sky.sun, skyColor: sky.hemiWorld.color, skyIntensity: sky.hemiWorld.intensity, coverage: env.clouds / 100,
  });
  windAt(atmosphere, 10, windSurf);
  airport.update(dtSim, {
    windX: windSurf[0], windZ: windSurf[2], gustKt: Math.hypot(atmosphere.gust[0], atmosphere.gust[1]) / 0.5144 * 0.5,
    darkness: sky.state.darkness, pixelRatio: renderer.getPixelRatio(),
  });
  invQ.copy(acRoot.quaternion).invert();
  sunLocal.copy(sky.sunDir).applyQuaternion(invQ);
  model.update(state, controls, {
    dt: dtSim, time: state.time, lights, darkness: sky.state.darkness, sunLocal, sunUp: clamp(sky.state.elevation / 10, 0, 1),
  });
  // Kabinenlicht: tagsüber Streulicht, nachts rötliche Flutbeleuchtung (Glareshield-/Deckenleuchte)
  const dk = sky.state.darkness;
  cabinFill.color.copy(sky.hemiCabin.color).lerp(NIGHT_RED, dk);
  cabinFill.intensity = sky.hemiWorld.intensity * 0.7 * (1 - dk) + 0.09 * dk;
  cockpit.update(state, controls, { lights });
  cockpit.setPanelLight(sky.state.darkness);
  instruments.update(state, env, dtSim);
}

// ------------------------------------------------------------------ Physikschritt (fester Takt 1/120 s)
let physicsMs = 0;
function physicsStep() {
  input.update(PHYS_DT); // Rampen im festen Takt → unabhängig von der Bildrate
  // Wolken treiben mit dem Wind in Wolkenhöhe; in der Wolke leicht turbulent (SPEC §3.3) – im Physiktakt,
  // damit gleiche Eingaben unabhängig von der Bildrate gleiche Zustände ergeben
  windAt(atmosphere, 1000, windCloud);
  world.cloudDensityAc = clouds.stepPhysics(PHYS_DT, env, windCloud[0], windCloud[2], state.p[0], state.p[1], state.p[2]);
  atmosphere.extraTurbulence = 0.3 * world.cloudDensityAc;
  stepAircraft(ac, controls, PHYS_DT);
  stepHead(head, state, prefersReducedMotion() ? 0 : settings.headMotion / 100, PHYS_DT); // reduced motion → aus
}
function timedSteps(n, run) {
  const t0 = performance.now();
  run();
  if (n) physicsMs = (performance.now() - t0) / n;
}
const loop = createLoop({
  step(i, n) {
    if (i === n - 1) syncPrev(); // Zustand vor dem letzten Schritt für die Interpolation merken
    physicsStep();
  },
});
/** Nach Pause, Neustart, Tab-Wechsel: kein Nachholen, keine Interpolation über die Lücke. */
function resetClock() {
  loop.reset();
  syncPrev();
  renderAlpha = 1;
  last = performance.now();
}

// ------------------------------------------------------------------ Eingabe
function doReset(id = scenario) {
  scenario = SCENARIOS[id] ? id : 'runway';
  input.clearAll(); // alte Demands (Maus-Yoke, Touch, gehaltene Tasten, laufende Drags) verwerfen
  setMass(ac, settings.mass); // die Masse wird beim Neustart übernommen (SPEC §4.3)
  applyScenario(ac, scenario, controls);
  clouds.resetDrift(); // gleicher Start → gleiche Wolkenlage (deterministische Turbulenz in Wolken)
  resetHead(head);
  resetClock();
  input.sync();
  instruments.snap(state, env);
  worldUpdate(0, Infinity);
  return state;
}

const input = createInput({
  controls,
  lights,
  settings,
  getState: () => state,
  actions: {
    view: setView,
    center: () => {
      setView('front');
      view.fov = settings.fov; // Zoom zurücksetzen
    },
    toggleExternal: () => {
      view.mode = view.mode === 'cockpit' ? 'external' : 'cockpit';
    },
    pause: () => (app.state === 'running' ? pauseSim() : app.state === 'paused' ? resumeSim() : null),
    reset: () => {
      if (app.state === 'running' || app.state === 'crashed') startFlight(scenario);
    },
    toggleHud: () => setSettings({ showHud: !settings.showHud }),
    help: () => {
      if (app.state === 'running') pauseSim();
      ui.open('help');
    },
  },
});

// Klang: AudioContext erst nach einer echten Nutzerinteraktion (Autoplay-Regeln, keine Konsolenwarnung).
// Aktivierende Ereignisse nach HTML-Spezifikation: keydown (außer Esc), mousedown/pointerdown der Maus,
// pointerup/touchend bei Touch, click.
const audio = createAudio();
const gesture = () => audio.unlock();
window.addEventListener('keydown', (e) => e.key !== 'Escape' && gesture(), true);
window.addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && gesture(), true);
window.addEventListener('pointerup', (e) => e.pointerType !== 'mouse' && gesture(), true);
window.addEventListener('touchend', gesture, true);
window.addEventListener('click', gesture, true);
const audioOpts = { dt: 0, external: false, paused: false, muted: false, volume: 70 };
function updateAudio(dt) {
  audioOpts.dt = dt;
  audioOpts.external = view.mode !== 'cockpit';
  // Crash: Physik steht, aber der Aufprall-Klang (One-Shot) soll ausklingen – audio.js schaltet Motor/Wind selbst ab
  audioOpts.paused = (!simActive() && app.state !== 'crashed') || document.hidden;
  audioOpts.muted = settings.muted;
  audioOpts.volume = settings.volume;
  audio.update(state, controls, audioOpts);
}

function cycleView() {
  if (view.mode !== 'cockpit') {
    setView('front');
    return;
  }
  const next = VIEW_CYCLE[(VIEW_CYCLE.indexOf(viewName) + 1) % VIEW_CYCLE.length];
  if (next === 'external') view.mode = 'external';
  else setView(next);
}

const touch = createTouch({
  input,
  controls,
  settings,
  actions: { cycleView, pause: () => (app.state === 'running' ? pauseSim() : null), onUserGesture: gesture },
});
const pointer = createPointer({
  canvas,
  camera,
  cockpit,
  instruments,
  controls,
  lights,
  input,
  view,
  settings,
  isTouchLayout: () => touch.visible,
  actions: {},
});

/** Einstellungen übernehmen (sofort wirksam; die Masse erst beim Neustart, SPEC §4.3) und speichern. */
function setSettings(obj = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in SETTINGS_DEF)) continue;
    const val = sanitize(k, v);
    if (k === 'fov' && val !== settings.fov) view.fov = val; // ausdrückliche FOV-Änderung gilt auch nach Mausrad-Zoom
    if (k === 'yokeMouse' && !val) input.releaseSource('mouse'); // letzte Mauslage nicht weiter anwenden
    settings[k] = val;
    if (ENV_KEYS.includes(k)) env[k] = val; // Umwelt wirkt sofort, auch im Flug
  }
  setAtmosphereFromEnv(atmosphere, env);
  if (settings.quality !== qualityApplied) applyQuality(settings.quality);
  ui?.setHudVisible(settings.showHud);
  if ('showHud' in obj && ui?.isOpen('settings')) ui.syncSettings();
  touch.refresh();
  saveSettings(settings);
  return { ...settings };
}

// ------------------------------------------------------------------ App-Zustände & Menüs (SPEC §4.1)
let ui = null;
ui = createUI({
  settings,
  defs: SETTINGS_DEF,
  defaults: defaultSettings,
  setSettings,
  action(name, arg) {
    if (name === 'fly') startFlight(arg);
    else if (name === 'resume') resumeSim();
    else if (name === 'restart') startFlight(scenario);
    else if (name === 'menu') toMenu();
    else if (name === 'glrestart') glRestart();
  },
  // Solange ein Menü offen ist, lösen Tasten keine Flugsteuerung aus (SPEC §4.7)
  onChange: () => input.setBlocked(!!ui?.anyOpen),
});
ui.setHudVisible(settings.showHud);

function setApp(s) {
  app.state = s;
  document.body.dataset.app = s;
}
/** Simulation läuft (Physik im Takt)? Im Startmenü rollt die Szene im Leerlauf weiter (Propeller, Windsack). */
function simActive() {
  return (app.state === 'running' || app.state === 'ready') && !orientPaused;
}
function startFlight(id = scenario) {
  if (glLost) return state; // erst nach webglcontextrestored (Dialog „Neu starten“)
  ui.closeAll();
  ui.setScenario(id);
  doReset(id);
  setView('front');
  view.yaw = view.tYaw;
  view.pitch = view.tPitch;
  view.fov = settings.fov;
  setApp('running');
  input.setBlocked(false);
  resetClock();
  return state;
}
function pauseSim() {
  if (app.state !== 'running' && app.state !== 'ready') return;
  input.clearAll(); // keine gehaltenen Ruder über die Pause hinweg
  setApp('paused');
  ui.closeAll();
  ui.open('pause', null);
}
function resumeSim() {
  if (app.state !== 'paused') return;
  ui.closeAll();
  setApp('running');
  input.setBlocked(false);
  resetClock(); // kein Zeitsprung
}
function toMenu() {
  ui.closeAll();
  doReset('runway'); // Hintergrund: startbereite Maschine im Leerlauf
  view.mode = 'external';
  view.orbitYaw = 200;
  view.orbitPitch = 12;
  view.orbitDist = 17;
  setApp('ready');
  ui.open('menu', null);
}
function showCrash() {
  setApp('crashed');
  const s = state;
  ui.showCrash(CRASH_TEXT[s.crashReason] || s.crashReason || 'Unbekannt',
    `IAS ${s.ias_kt.toFixed(0)} kt · VS ${s.vs_fpm.toFixed(0)} ft/min · Querlage ${s.bank_deg.toFixed(0)}° · ${s.g.toFixed(1)} g`);
}
function checkCrash() {
  if (state.crashed && (app.state === 'running' || app.state === 'ready')) {
    if (app.state === 'ready') doReset('runway'); // im Menü-Hintergrund (Sturmwind) einfach neu aufstellen
    else showCrash();
  }
}

// Grafikkontext verloren/wiederhergestellt (SPEC §4.1 Punkt 6): anhalten, kontrollierter Neustart
let glLost = false;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // Wiederherstellung erlauben
  glLost = true;
  input.clearAll();
  setApp('error');
  ui.closeAll();
  ui.setGlRestart(false);
  ui.open('gl', null);
});
canvas.addEventListener('webglcontextrestored', () => {
  glLost = false;
  // GPU-Ressourcen des alten Kontexts sind weg; three legt Texturen/Puffer beim nächsten Rendern neu an. Die
  // Shadow-Map nur vergessen (nicht dispose() – das würde Objekte des alten Kontexts löschen → WebGL-Warnung).
  sky.sun.shadow.map = null;
  ui.setGlRestart(true);
});
function glRestart() {
  if (glLost) return;
  startFlight(scenario);
}

// ------------------------------------------------------------------ Hauptschleife (Fixed-Step-Akkumulator)
let last = performance.now();
let fps = 60;
let lastFrameMs = 16.7;
let orientPaused = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.25, Math.max(0, (now - last) / 1000));
  lastFrameMs = now - last;
  last = now;
  if (dtReal > 0) fps += (1 / dtReal - fps) * 0.05;
  // Drehhinweis (Hochformat, Touch) verdeckt alles: anhalten, gehaltene Eingaben lösen, danach ohne Zeitsprung weiter
  const blocked = touch.portraitBlocked;
  if (blocked !== orientPaused) {
    orientPaused = blocked;
    if (blocked) input.clearAll();
    resetClock();
  }
  let dtSim = 0;
  if (simActive() && !glLost) {
    const t0 = performance.now();
    const { n } = loop.advance(dtReal);
    if (n) physicsMs = (performance.now() - t0) / n;
    dtSim = n * PHYS_DT;
    renderAlpha = loop.alpha;
    checkCrash();
  } else renderAlpha = 1;
  if (app.state === 'ready') view.orbitYaw = (view.orbitYaw + MENU_ORBIT_DEG_S * dtReal) % 360;
  stepView(dtReal);
  if (!glLost) {
    worldUpdate(dtSim);
    instrAcc += dtReal;
    if (instrAcc >= 1 / INSTR_HZ) {
      instrAcc %= 1 / INSTR_HZ;
      instruments.draw();
    }
    renderFrame();
  }
  ui.updateHud(state, controls, { paused: app.state === 'paused' });
  pointer.update();
  touch.update();
  updateAudio(dtReal);
}

// Verdeckter Tab / Fokusverlust: automatische Pause mit Dialog – Fortsetzen ist eine bewusste Aktion (AK-30, AK-35)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    input.clearAll(); // keine hängenden Ruder nach dem Zurückkehren
    if (app.state === 'running') pauseSim();
  }
  audio.setHidden(document.hidden);
  resetClock();
});
window.addEventListener('blur', () => {
  // input.js löst beim blur selbst alle gehaltenen Tasten (clearAll)
  if (app.state === 'running') pauseSim();
  resetClock();
});
window.addEventListener('focus', () => resetClock());

// ------------------------------------------------------------------ Debug-/Test-Hook (SPEC §6, js/debug.js)
const glExt = () => renderer.getContext().getExtension('WEBGL_lose_context');
let loseExt = null;
installDebug({
  state,
  controls,
  env,
  app,
  /** n Physik-Substeps synchron, danach genau ein World-Update + Instrumente + Render. */
  stepN(n) {
    timedSteps(n, () => {
      for (let i = 0; i < n; i++) {
        if (i === n - 1) syncPrev();
        physicsStep();
      }
    });
    renderAlpha = 1;
    const dt = n * PHYS_DT;
    if (app.state === 'ready') view.orbitYaw = (view.orbitYaw + MENU_ORBIT_DEG_S * dt) % 360;
    stepView(Math.max(dt, 1 / 60));
    worldUpdate(dt);
    instruments.draw();
    renderFrame();
    checkCrash();
    ui.updateHud(state, controls, { paused: app.state === 'paused' });
    pointer.update();
    touch.update();
    updateAudio(dt);
    return state;
  },
  renderOnce() {
    worldUpdate(0);
    instruments.draw();
    renderFrame();
  },
  setControls(obj) {
    Object.assign(controls, obj);
    input.suspend();
  },
  setEnv(obj) {
    for (const [k, v] of Object.entries(obj)) if (ENV_KEYS.includes(k)) env[k] = sanitize(k, v);
    setAtmosphereFromEnv(atmosphere, env);
  },
  reset: (id = scenario) => startFlight(id),
  pause: (v) => (v ? pauseSim() : resumeSim()),
  instruments: () => instruments.values(),
  perf: () => ({
    fps,
    frameMs: lastFrameMs,
    physicsMs,
    drawCalls: renderer.info.render.calls, // Summe beider Render-Pässe (info.autoReset = false)
    triangles: renderer.info.render.triangles,
    tiles: terrain.tileCount,
    droppedSteps: loop.droppedSteps,
    trees: vegetation.stats.trees,
    cloudSprites: clouds.stats.instances,
    visibility: sky.state.visibility,
    quality: settings.quality,
    pixelRatio: renderer.getPixelRatio(),
  }),
  extras: {
    /** App-Zustand: 'loading' | 'ready' | 'running' | 'paused' | 'crashed' | 'error' */
    get appState() {
      return app.state;
    },
    /** offene Dialoge (oben zuletzt) */
    get dialogs() {
      return ui.stack;
    },
    /** Startmenü öffnen / Flug starten (wie die Buttons) */
    menu: () => toMenu(),
    fly: (id) => startFlight(id),
    /** Kamera: 'front' | 'left' | 'right' | 'panel' | 'external' */
    view(name) {
      if (name === 'external') view.mode = 'external';
      else setView(name);
      view.yaw = view.tYaw;
      view.pitch = view.tPitch;
    },
    /** Masse sofort setzen (Tests) und als Einstellung für folgende Neustarts übernehmen. */
    setMass(kg) {
      settings.mass = sanitize('mass', kg);
      setMass(ac, settings.mass);
    },
    settings,
    setSettings,
    /** Kopfbewegung (Body-Versatz m, Nicken/Rollen rad) */
    head: () => ({ ...head.out }),
    /** Klang-Zustand (AK-29): { state, firingHz, expectedFiringHz, engineGain, windGain, hornGain, … } */
    audio: () => audio.debug(),
    /** Bildschirmposition (client px) eines klickbaren Bedienelements, z. B. 'throttle' (AK-24). */
    controlScreenPos: (name) => pointer.screenPos(name),
    input: {
      source: () => input.source,
      keys: input.keys,
      clearAll: () => input.clearAll(),
      setBlocked: (b) => input.setBlocked(b),
      get blocked() {
        return input.blocked;
      },
    },
    touch: { get visible() { return touch.visible; }, root: touch.root },
    lights,
    model: model.parts,
    cockpit: cockpit.parts,
    terrain,
    /** Wolkendichte 0..1 an einem Weltpunkt (Default: Flugzeug) – > 0,5 = in der Wolke (AK-22). */
    cloudDensityAt: (p = state.pos) => clouds.densityAt(p.x, p.y, p.z),
    /** Welt-Module für Tests: Himmel (Sterne, Sonnenstand), Wolken, Wasser, Flugplatz (PAPI, Windsack), Vegetation. */
    world: { sky, stars: sky.stars, clouds, water, airport, vegetation, terrain, state: world },
    /** Grafikkontext-Verlust simulieren (AK-36) */
    debug: {
      loseContext() {
        loseExt = glExt();
        loseExt?.loseContext();
        return !!loseExt;
      },
      restoreContext() {
        loseExt?.restoreContext();
      },
    },
    THREE_REVISION: THREE.REVISION,
    three: { THREE, scene, camera, renderer, acRoot, sky, cockpit, model, instruments, view, audio }, // nur für Debugging/Tests
  },
});

// ------------------------------------------------------------------ Start: Welt aufbauen (mit Fortschritt), Menü
setProgress(0.55, 'Gelände erzeugen …');
await yieldToBrowser();
syncPrev();
updateAircraftTransform();
// Nahkacheln in Portionen (echter Fortschritt), das Fern-Mesh entsteht im ersten Aufruf vollständig
{
  let made = 0, total = 0;
  do {
    made = terrain.update(state.p[0], state.p[2], 4);
    total += made;
    vegetation.commit();
    setProgress(0.55 + 0.33 * Math.min(1, total / 25), `Gelände erzeugen … ${terrain.tileCount}/25 Kacheln`);
    await yieldToBrowser();
  } while (made > 0);
}
setProgress(0.9, 'Shader kompilieren …');
await yieldToBrowser();
view.mode = 'external';
worldUpdate(0, Infinity);
instruments.snap(state, env);
instruments.draw();
renderFrame(); // Außenansicht (Menü-Hintergrund)
view.mode = 'cockpit';
renderFrame(); // Cockpit-Pässe schon einmal kompilieren – der erste Flug-Frame ruckelt nicht
setProgress(1, 'Bereit');
await yieldToBrowser();
hideLoading();
toMenu();
resetClock();
requestAnimationFrame(frame);
