// Himmel (eigener Rayleigh/Mie-Shader mit Ozon, Sonnen- und Mondscheibe), Sterne, Sonnen-/Mond-/Himmelslicht und
// Dunst (Aerial Perspective). Alle Farben stammen aus demselben Streumodell (skymodel.js): Sonnenfarbe = Transmission,
// Himmelslicht = gemittelte Himmelsleuchtdichte, Dunstfarbe = Horizont in Blickrichtung (mit Vorwärtsstreuung zur
// Sonne). So passen Himmel, Nebel, Licht und Wolken in jeder Tageszeit zusammen (Dämmerung, goldene Stunde, Nacht).
//
// Licht-Layer (Zwei-Pass-Rendering): Die Sonne (nachts: Mond) wirkt in beiden Pässen (layers.enableAll, wirft
// Schatten). Das Himmelslicht gibt es zweimal: außen (Layer 0 → Pass 1) und für die Kabine (Layer 2 → Pass 2).
//
// Dunst: patchHaze(material) ersetzt Threes Nebel in Standard-/Lambert-/Basic-Materialien durch einen
// höhenabhängigen Exponential-Dunst mit richtungsabhängiger Farbe, angewandt VOR dem Tone-Mapping (linear, HDR),
// damit ferne Berge exakt in den Horizont des Himmels übergehen. HAZE_GLSL nutzen auch die eigenen Shader.
import * as THREE from 'three';
import { clamp, lerp, DEG } from '../sim/math.js';
import { skyLighting, SKY_GLSL, sunDirection as sunDirArray, fogVisibility, CLEAR_VISIBILITY } from './skymodel.js';

/** Sonnenrichtung (THREE.Vector3) – Kompatibilität zu älteren Aufrufern. */
export function sunDirection(hours, out = new THREE.Vector3()) {
  const s = sunDirArray(hours);
  return out.set(s[0], s[1], s[2]);
}

// ------------------------------------------------------------------ Dunst (gemeinsame Uniforms + GLSL)
export const HAZE = {
  uHazeSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uHazeSun: { value: new THREE.Color(0.8, 0.9, 1) },
  uHazeAway: { value: new THREE.Color(0.7, 0.8, 1) },
  uHazeGlow: { value: new THREE.Color(0, 0, 0) },
  uHazeDensity: { value: 1.2e-4 }, // Extinktion am Boden (1/m) → Sicht ≈ 3,9/β
  uHazeFalloff: { value: 1 / 1500 }, // 1/Skalenhöhe der Dunstschicht
  uHazeBase: { value: 450 }, // m MSL
  uHazeNear: { value: 14000 }, // Randabblendung (verdeckt das Ende des Fern-Meshes) bzw. Sicht in der Wolke
  uHazeFar: { value: 22000 },
  uHazeCloud: { value: 0 }, // 0..1: in der Wolke
  uHazeCloudCol: { value: new THREE.Color(0.6, 0.62, 0.66) },
};

export const HAZE_GLSL = /* glsl */ `
uniform vec3 uHazeSunDir, uHazeSun, uHazeAway, uHazeGlow, uHazeCloudCol;
uniform float uHazeDensity, uHazeFalloff, uHazeBase, uHazeNear, uHazeFar, uHazeCloud;
vec3 hazeColor(vec3 v) {
  vec2 hv = normalize(v.xz + vec2(1e-6, 0.0));
  vec2 hs = normalize(uHazeSunDir.xz + vec2(1e-6, 0.0));
  float t = 0.5 + 0.5 * dot(hv, hs);
  vec3 c = mix(uHazeAway, uHazeSun, t * t);
  float mu = max(dot(v, uHazeSunDir), 0.0);
  c += uHazeGlow * (pow(mu, 10.0) * 1.6 + pow(mu, 60.0) * 3.0);
  return c;
}
// Optische Tiefe des Höhendunstes zwischen Kamera und p (analytisches Integral der Exponentialschicht)
float hazeDepth(vec3 d, float dist) {
  float k = uHazeFalloff;
  float e0 = exp(-clamp((cameraPosition.y - uHazeBase) * k, -4.0, 40.0));
  float x = clamp(d.y * k, -30.0, 30.0);
  float fac = abs(x) > 1e-3 ? (1.0 - exp(-x)) / x : 1.0 - 0.5 * x;
  return uHazeDensity * dist * e0 * fac;
}
// Dunst-Anteil f (0..1) und Farbe für Weltpunkt p
vec4 hazeAt(vec3 p) {
  vec3 d = p - cameraPosition;
  float dist = length(d);
  vec3 v = d / max(dist, 1e-3);
  float f = 1.0 - exp(-hazeDepth(d, dist));
  vec3 hc = hazeColor(v);
  float r = smoothstep(uHazeNear, uHazeFar, dist);
  vec3 rc = mix(hc, uHazeCloudCol, uHazeCloud);
  // zuerst Dunst, dann Rand-/Wolkenabblendung (zusammengefasst als ein Mischfaktor)
  float a = 1.0 - (1.0 - f) * (1.0 - r);
  vec3 col = a > 1e-5 ? (hc * f * (1.0 - r) + rc * r) / a : hc;
  return vec4(col, a);
}
vec3 applyHaze(vec3 col, vec3 p) {
  vec4 h = hazeAt(p);
  return mix(col, h.rgb, h.a);
}
`;

// ------------------------------------------------------------------ Wolkenschatten (clouds.js füllt die Textur)
const noShadowTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
noShadowTex.needsUpdate = true;
export const CLOUD_SHADOW = {
  tCloudShadow: { value: noShadowTex }, // R = Schattendichte 0..1 in der Wolkenschicht (Draufsicht)
  uCloudShadowRect: { value: new THREE.Vector3(0, 0, 1) }, // Mitte x, z und Kantenlänge (m)
  uCloudLayer: { value: new THREE.Vector2(1200, 1800) }, // Unter-/Obergrenze (m MSL)
  uCloudShadowOn: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },
};
export const CLOUD_SHADOW_GLSL = /* glsl */ `
uniform sampler2D tCloudShadow;
uniform vec3 uCloudShadowRect;
uniform vec2 uCloudLayer;
uniform float uCloudShadowOn;
uniform vec3 uLightDir;
// Anteil des direkten Lichts, der an Punkt p durch die Wolken kommt (1 = frei)
float cloudShadow(vec3 p) {
  if (uCloudShadowOn < 0.5 || uLightDir.y < 0.03) return 1.0;
  float hMid = mix(uCloudLayer.x, uCloudLayer.y, 0.35);
  if (p.y > hMid) return 1.0;
  vec2 q = p.xz + uLightDir.xz * ((hMid - p.y) / uLightDir.y);
  vec2 uv = (q - uCloudShadowRect.xy) / uCloudShadowRect.z + 0.5;
  vec2 e = min(uv, 1.0 - uv);
  float inside = smoothstep(0.0, 0.05, min(e.x, e.y));
  float s = texture(tCloudShadow, uv).r * inside;
  return 1.0 - s * 0.75;
}
`;

/** Ersetzt Threes Nebel eines eingebauten Materials durch den Dunst (vor dem Tone-Mapping). */
export function patchHaze(material) {
  if (!material || material.isShaderMaterial || material.userData.haze || material.fog === false) return material;
  const prev = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, HAZE);
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vHazeWorld;')
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
        {
          vec4 hw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            hw = instanceMatrix * hw;
          #endif
          vHazeWorld = (modelMatrix * hw).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nvarying vec3 vHazeWorld;\n' + HAZE_GLSL)
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = applyHaze(gl_FragColor.rgb, vHazeWorld);\n#include <tonemapping_fragment>')
      .replace('#include <fog_fragment>', '');
  };
  material.customProgramCacheKey = () => baseKey + '|haze';
  material.userData.haze = true;
  material.needsUpdate = true;
  return material;
}

/**
 * Wolkenschatten auf das Direktlicht eines eingebauten Materials (wie Terrain/Bäume). Muss VOR patchHaze
 * laufen und nur bei Materialien, die patchHaze auch patcht (nutzt dessen vHazeWorld).
 */
function patchCloudShadow(material) {
  if (material.isShaderMaterial || material.userData.haze || material.fog === false || material.userData.cloudShadow) return;
  const prev = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey(); // vor dem Umhängen, sonst teilen sich Materialien Programme
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, CLOUD_SHADOW);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CLOUD_SHADOW_GLSL)
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n{ float cs = cloudShadow(vHazeWorld); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }',
      );
  };
  material.customProgramCacheKey = () => baseKey + '|cs';
  material.userData.cloudShadow = true;
}

/**
 * Alle Welt-Materialien (Layer 0, Nebel an) eines Teilbaums mit Dunst versehen.
 * opts.cloudShadow: zusätzlich Wolkenschatten (z. B. Außenmodell – Haube und Flügel liegen sonst im
 * Wolkenschatten hell, während das Cockpit im zweiten Pass abgedunkelt wird).
 */
export function patchHazeTree(root, opts = {}) {
  root.traverse((o) => {
    if (!o.material || !o.layers.isEnabled(0)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (opts.cloudShadow) patchCloudShadow(m);
      patchHaze(m);
    }
  });
}

// ------------------------------------------------------------------ Sterne
function createStars() {
  const N = 2200;
  const pos = new Float32Array(N * 3), size = new Float32Array(N), col = new Float32Array(N * 3);
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos[i * 3] = r * Math.cos(a) * 9000;
    pos[i * 3 + 1] = u * 9000;
    pos[i * 3 + 2] = r * Math.sin(a) * 9000;
    const b = Math.pow(rnd(), 7); // wenige helle, viele schwache Sterne
    size[i] = 0.35 + 0.9 * b + rnd() * 0.25;
    const t = rnd(); // Farbtemperatur: bläulich … weiß … gelblich
    col[i * 3] = 0.8 + 0.2 * t;
    col[i * 3 + 1] = 0.85 + 0.1 * Math.sin(t * 3);
    col[i * 3 + 2] = 1.0 - 0.25 * t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uScale: { value: 2 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aCol;
      uniform float uOpacity, uScale, uTime;
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
        vec3 wd = normalize(mat3(modelMatrix) * position);
        float ext = smoothstep(-0.02, 0.25, wd.y); // Extinktion am Horizont
        float tw = 0.85 + 0.15 * sin(uTime * (3.0 + fract(aSize * 91.7) * 5.0) + position.x);
        vA = uOpacity * ext * tw * clamp(aSize * 1.4, 0.25, 1.0);
        vCol = aCol;
        gl_PointSize = max(1.0, aSize * uScale * 2.2);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.1, 0.5, length(c))) * vA;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol * a * 1.6, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  mat.opacity = 0;
  const pts = new THREE.Points(g, mat);
  pts.name = 'stars';
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}

// ------------------------------------------------------------------ Himmel
export function createSky(scene) {
  const uniforms = {
    ...HAZE,
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uSunDisk: { value: new THREE.Color(1, 1, 1) },
    uMoonVis: { value: 0 },
    uOvercast: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // immer auf der Fernebene
      }`,
    fragmentShader: /* glsl */ `
      ${SKY_GLSL}
      ${HAZE_GLSL}
      uniform vec3 uSunDir, uMoonDir, uSunDisk;
      uniform float uMoonVis, uOvercast;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyRadiance(d, uSunDir);
        // Sonnenscheibe (Randverdunkelung) + enger Hof
        float mu = dot(d, uSunDir);
        float disk = smoothstep(0.999986, 0.999991, mu);
        col += uSunDisk * (disk * 45.0 + pow(max(mu, 0.0), 2400.0) * 2.0);
        // Vollmond gegenüber der Sonne
        float mm = dot(d, uMoonDir);
        float moon = smoothstep(0.999987, 0.999991, mm);
        col += uMoonVis * (moon * vec3(0.85, 0.86, 0.88) * 1.4 + pow(max(mm, 0.0), 900.0) * vec3(0.02, 0.025, 0.035));
        // Bedeckung: grauer, flacher
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(l) * vec3(0.95, 0.98, 1.05), uOvercast * 0.55);
        // Zum Horizont hin in exakt die Dunstfarbe übergehen (fernes Gelände verschmilzt damit)
        vec3 hz = hazeColor(normalize(vec3(d.x, 0.0, d.z)));
        col = mix(col, hz, 1.0 - smoothstep(-0.005, 0.045, d.y));
        col = mix(col, uHazeCloudCol, uHazeCloud);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10000, 48, 24), mat);
  dome.name = 'sky';
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  scene.add(dome);

  const stars = createStars();
  scene.add(stars);
  const POLE = new THREE.Vector3(0, Math.sin(48 * DEG), -Math.cos(48 * DEG)); // Himmelsnordpol

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.name = 'sun';
  sun.layers.enableAll();
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); // „Mittel“ (PLAN §2.4); „Hoch“ = 2048 (AP9)
  const sc = sun.shadow.camera;
  sc.left = -7;
  sc.right = 7;
  sc.top = 7;
  sc.bottom = -7;
  sc.near = 1;
  sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.012;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  const hemiWorld = new THREE.HemisphereLight(0xbcd2e8, 0x4d5a3a, 1.1);
  hemiWorld.name = 'skyLightWorld';
  hemiWorld.layers.set(0);
  const hemiCabin = new THREE.HemisphereLight(0xbcd2e8, 0x4d5a3a, 0.5);
  hemiCabin.name = 'skyLightCabin';
  hemiCabin.layers.set(2);
  scene.add(hemiWorld, hemiCabin);

  // THREE.Fog bleibt als Messgröße/Fallback (far = aktuelle Sichtweite); gerendert wird der Dunst (HAZE).
  const fog = new THREE.Fog(0xb5cbe2, 14000, 22000);
  scene.fog = fog;

  const sunDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const L = {};
  const CABIN_TINT = new THREE.Color(0xd9d3c8);
  const tmpC = new THREE.Color();
  const state = {
    elevation: 0, darkness: 0, sunDir, exposure: 1, starAlpha: 0, moonUp: 0,
    sunColor: new THREE.Color(), sunIntensity: 0, skyColor: new THREE.Color(), skyIntensity: 0,
    horizonSun: new THREE.Color(), horizonAway: new THREE.Color(), visibility: 22000, inCloud: 0, sunShade: 1,
    cloudLight: new THREE.Color(), cloudLightDir: new THREE.Vector3(0, 1, 0),
  };

  /**
   * Tageszeit anwenden. center = Flugzeugposition (Schatten folgt), camPos = Kameraposition (Kuppel),
   * viewDir = Blickrichtung (THREE.Fog-Farbe), opts = { inCloud 0..1, cloudColor, coverage 0..1, sunShade 0..1 }.
   * sunShade (Wolkenschatten am Flugzeug) wirkt NICHT auf das Weltlicht – Terrain, Bäume und Wasser schatten selbst
   * per cloudShadow(); main.js dämpft damit nur den Cockpit-Pass.
   */
  function update(hours, center, camPos, viewDir, opts = {}) {
    skyLighting(hours, L);
    const s = L.sunDir;
    sunDir.set(s[0], s[1], s[2]);
    state.elevation = L.elevation;
    state.darkness = L.darkness;
    state.starAlpha = L.starAlpha;
    state.exposure = L.exposure;
    const cov = clamp(opts.coverage ?? 0, 0, 1);
    const inCloud = clamp(opts.inCloud ?? 0, 0, 1);
    const shade = clamp(opts.sunShade ?? 1, 0, 1);
    state.inCloud = inCloud;
    state.sunShade = shade;

    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uMoonDir.value.set(L.moonDir[0], L.moonDir[1], L.moonDir[2]);
    // Sonnenscheibe in Transmissionsfarbe (am Horizont orange-rot)
    uniforms.uSunDisk.value.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]).multiplyScalar(clamp(L.sunIntensity / 4, 0.05, 1.2));
    if (L.elevation < -1.5) uniforms.uSunDisk.value.setRGB(0, 0, 0);
    state.moonUp = clamp(-sunDir.y * 4, 0, 1);
    uniforms.uMoonVis.value = state.moonUp * (1 - cov * 0.6);
    uniforms.uOvercast.value = cov * cov;

    // Dunst: Farben aus dem Streumodell; bei Bedeckung grauer, dichter
    HAZE.uHazeSunDir.value.copy(sunDir);
    const grey = cov * cov * 0.6;
    const setHaze = (c, a) => {
      c.setRGB(a[0], a[1], a[2]);
      const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
      c.lerp(tmpC.setRGB(l, l, l), grey).multiplyScalar(1 - 0.25 * cov);
    };
    setHaze(HAZE.uHazeSun.value, L.hazeSun);
    setHaze(HAZE.uHazeAway.value, L.hazeAway);
    HAZE.uHazeGlow.value.setRGB(L.hazeGlow[0], L.hazeGlow[1], L.hazeGlow[2]).multiplyScalar(1 - 0.7 * cov);
    state.horizonSun.copy(HAZE.uHazeSun.value);
    state.horizonAway.copy(HAZE.uHazeAway.value);
    // Bodensicht ≈ 50 km (klar) … 30 km (bedeckt, tiefe Sonne); die Randabblendung verdeckt das Geländeende
    HAZE.uHazeDensity.value = 0.75e-4 * (1 + 0.5 * cov) * (1 + 0.3 * clamp(1 - L.elevation / 12, 0, 1));
    // In der Wolke: Sicht < 100 m (AK-22), Farbe der beleuchteten Wolke
    const vis = fogVisibility(inCloud);
    HAZE.uHazeFar.value = vis;
    HAZE.uHazeNear.value = lerp(CLEAR_VISIBILITY * 0.64, 0, Math.min(1, inCloud * 4));
    HAZE.uHazeCloud.value = inCloud;
    if (opts.cloudColor) HAZE.uHazeCloudCol.value.copy(opts.cloudColor);
    state.visibility = vis;
    fog.near = HAZE.uHazeNear.value;
    fog.far = vis;
    // THREE.Fog-Farbe = Dunstfarbe in Blickrichtung (Fallback)
    const hd = Math.hypot(viewDir.x, viewDir.z) || 1, hs = Math.hypot(sunDir.x, sunDir.z) || 1;
    const t = 0.5 + 0.5 * ((viewDir.x * sunDir.x + viewDir.z * sunDir.z) / (hd * hs));
    fog.color.copy(HAZE.uHazeAway.value).lerp(HAZE.uHazeSun.value, t * t);
    if (inCloud > 0) fog.color.lerp(HAZE.uHazeCloudCol.value, inCloud);

    // Sonne bzw. nachts Mond als einzige gerichtete Lichtquelle (wirft die Cockpit-Schatten)
    const night = L.elevation < -3;
    if (night) {
      lightDir.set(L.moonDir[0], L.moonDir[1], L.moonDir[2]);
      sun.color.setRGB(0.62, 0.72, 1.0);
      sun.intensity = L.moonIntensity * (1 - 0.75 * cov);
    } else {
      lightDir.copy(sunDir);
      sun.color.setRGB(L.sunColor[0], L.sunColor[1], L.sunColor[2]);
      sun.intensity = L.sunIntensity * (1 - 0.35 * cov);
    }
    sun.intensity *= 1 - inCloud * 0.85;
    state.sunColor.copy(sun.color);
    state.sunIntensity = sun.intensity;
    // Licht für die Wolken: Sonne in Wolkenhöhe (Abendrot nach Sonnenuntergang), sonst Mond
    if (L.cloudSunIntensity > L.moonIntensity) {
      state.cloudLightDir.copy(sunDir);
      state.cloudLight.setRGB(L.cloudSunColor[0], L.cloudSunColor[1], L.cloudSunColor[2]).multiplyScalar(L.cloudSunIntensity * (1 - 0.35 * cov));
    } else {
      state.cloudLightDir.set(L.moonDir[0], L.moonDir[1], L.moonDir[2]);
      state.cloudLight.setRGB(0.62, 0.72, 1.0).multiplyScalar(L.moonIntensity * (1 - 0.75 * cov));
    }
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(lightDir, 40);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    // Himmelslicht: bei Bedeckung heller/grauer (diffuses Wolkenlicht), in der Wolke gleichmäßig
    hemiWorld.color.setRGB(L.skyColor[0], L.skyColor[1], L.skyColor[2]).lerp(tmpC.setRGB(0.92, 0.95, 1), cov * 0.7);
    hemiWorld.groundColor.setRGB(L.groundColor[0], L.groundColor[1], L.groundColor[2]);
    const gl = hemiWorld.groundColor;
    const gm = Math.max(gl.r, gl.g, gl.b, 1e-6);
    const gi = gm;
    gl.multiplyScalar(1 / gm);
    const ki = L.skyIntensity * (1 + 0.25 * cov);
    hemiWorld.intensity = ki;
    hemiWorld.groundColor.multiplyScalar(clamp(gi / Math.max(ki, 1e-3), 0.05, 1));
    state.skyColor.copy(hemiWorld.color);
    state.skyIntensity = ki;
    // Kabine: Himmelslicht durch Plexiglas und von hellen Flächen zurückgeworfen → neutraler, wärmer
    hemiCabin.color.copy(hemiWorld.color).lerp(CABIN_TINT, 0.6);
    hemiCabin.groundColor.copy(hemiWorld.groundColor);
    hemiCabin.intensity = ki * 1.2;

    // Sterne: Opazität ∝ Dunkelheit, Drehung um den Himmelsnordpol mit der Uhrzeit
    stars.material.opacity = L.starAlpha * (1 - cov * 0.5) * (1 - inCloud); // Wolken verdecken selbst
    stars.material.uniforms.uOpacity.value = stars.material.opacity;
    stars.material.uniforms.uTime.value = (performance.now() / 1000) % 1000;
    stars.visible = stars.material.opacity > 0.002;
    stars.quaternion.setFromAxisAngle(POLE, (-hours / 24) * Math.PI * 2);
    stars.position.copy(camPos);
    stars.updateMatrixWorld();

    dome.position.copy(camPos);
    dome.updateMatrixWorld();
  }

  /** Pixelverhältnis für die Sterngröße. */
  function setPixelRatio(pr) {
    stars.material.uniforms.uScale.value = pr;
  }

  return { dome, stars, sun, hemiWorld, hemiCabin, fog, update, state, sunDir, setPixelRatio, uniforms };
}
