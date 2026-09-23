// Wolken: weiche Cumulus-Sprites (ein instanziertes Billboard-Mesh, im Vertex-Shader zur Kamera gedreht),
// pro Frame nach Kameradistanz sortiert (NormalBlending, depthWrite aus). Beleuchtung pro Fragment über eine
// Kugel-Normale des Puffs: sonnenseitig hell, Unterseite grau-blau aus dem Himmelslicht, Silberrand bei Gegenlicht,
// flache Wolkenbasis, Dunst mit der Entfernung. Dazu Wolkenschatten (Draufsicht-Textur für Terrain/Wasser und
// Abschattung des Flugzeugs) sowie cloudDensityAt() → Sicht in der Wolke, Turbulenz.
import * as THREE from 'three';
import { createCloudField } from './cloudfield.js';
import { HAZE, HAZE_GLSL, CLOUD_SHADOW } from './sky.js';

const MAX_PUFFS = 6000;
const VIEW_RADIUS = 21000; // m
const LOD_DIST = 9000; // m: dahinter nur die größten Puffs
const SHADOW_SIZE = 20000; // m Kantenlänge der Schattentextur
const SHADOW_RES = 256;

/** Puff-Atlas 2 × 2 (je 128²): weiche, klumpige Wattebäusche aus Gauß-Blobs. */
function puffTexture() {
  const N = 128, W = N * 2;
  const data = new Uint8Array(W * W * 4);
  let seed = 11;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let v = 0; v < 4; v++) {
    const blobs = [];
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.27;
      blobs.push([0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d * 0.85, 0.1 + rnd() * 0.12]);
    }
    const ox = (v % 2) * N, oy = Math.floor(v / 2) * N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N, w = (y + 0.5) / N;
        let s = 0;
        for (const [bx, by, br] of blobs) {
          const dx = u - bx, dy = w - by;
          s += Math.exp(-(dx * dx + dy * dy) / (br * br));
        }
        // weicher Rand, der zum Kachelrand sicher auf 0 geht
        const r = Math.hypot(u - 0.5, w - 0.5) * 2;
        const edge = Math.max(0, 1 - r * r);
        const a = Math.min(1, Math.max(0, (s - 0.35) * 0.9)) * edge;
        const i = ((oy + y) * W + ox + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.round(Math.pow(a, 1.2) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
${HAZE_GLSL}
attribute vec4 iA; // Mitte xyz, Radius
attribute vec4 iB; // Offset zur Wolkenmitte (normiert) xyz, Höhenanteil in der Wolke
attribute vec4 iC; // Variante, Drehung, Deckkraft, Wolkenbasis (m)
varying vec2 vUv;
varying vec2 vRc;
varying vec2 vC;
varying vec3 vOff;
varying float vH;
varying float vAlpha;
varying float vBaseY;
varying vec3 vWPos;
varying vec4 vHaze;
varying vec3 vView;
void main() {
  vec3 center = iA.xyz;
  float s = iA.w;
  vec2 c = position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = center + (right * c.x + up * c.y) * s;
  float ang = iC.y;
  vec2 rc = vec2(cos(ang) * c.x - sin(ang) * c.y, sin(ang) * c.x + cos(ang) * c.y) * 0.5 + 0.5;
  float var = iC.x;
  vRc = rc;
  // Atlaszelle mit Rand (kein Übersprechen der Nachbarzellen, auch nicht in kleinen Mip-Stufen)
  vUv = (rc * 0.94 + 0.03 + vec2(mod(var, 2.0), floor(var / 2.0))) * 0.5;
  vC = c;
  vOff = iB.xyz;
  vH = iB.w;
  vBaseY = iC.w;
  vWPos = wp;
  vec3 toC = center - cameraPosition;
  float dist = length(toC);
  vView = toC / max(dist, 1.0);
  // weiches Ausblenden kurz vor der Kamera (in der Wolke übernimmt der Nebel)
  vAlpha = iC.z * smoothstep(30.0, 220.0, dist - s * 0.55);
  vHaze = hazeAt(center);
  gl_Position = projectionMatrix * (viewMatrix * vec4(wp, 1.0));
}`;

const FRAG = /* glsl */ `
uniform sampler2D tPuff;
uniform vec3 uLightDir, uLightCol, uAmbTop, uAmbBot;
varying vec2 vUv;
varying vec2 vRc;
varying vec2 vC;
varying vec3 vOff;
varying float vH;
varying float vAlpha;
varying float vBaseY;
varying vec3 vWPos;
varying vec4 vHaze;
varying vec3 vView;
void main() {
  // gedrehte Texturkoordinaten ragen an den Ecken aus der Zelle → dort nichts zeichnen
  vec2 e = min(vRc, 1.0 - vRc);
  float a = texture(tPuff, vUv).a * vAlpha * smoothstep(0.0, 0.04, min(e.x, e.y));
  a *= smoothstep(vBaseY - 20.0, vBaseY + 70.0, vWPos.y); // flache Basis
  if (a < 0.004) discard;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float r2 = dot(vC, vC);
  vec3 n = normalize(right * vC.x + up * vC.y + back * sqrt(max(1.0 - r2, 0.0)));
  float ndl = dot(n, uLightDir);
  float wrap = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
  // Selbstschatten der Wolke: sonnenabgewandte und untere Puffs dunkler
  float self = clamp(0.5 + 0.5 * dot(vOff, uLightDir), 0.15, 1.0) * mix(0.55, 1.0, vH);
  vec3 amb = mix(uAmbBot, uAmbTop, clamp(vH * 0.7 + n.y * 0.3 + 0.15, 0.0, 1.0));
  vec3 col = uLightCol * (wrap * self * 0.26) + amb;
  // Silberrand/Vorwärtsstreuung bei Gegenlicht: dünne Ränder leuchten
  float mu = max(dot(vView, uLightDir), 0.0);
  col += uLightCol * (pow(mu, 6.0) * 0.5 + pow(mu, 40.0) * 1.6) * (1.0 - a) * self;
  col = mix(col, vHaze.rgb, vHaze.a);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createClouds(scene) {
  const field = createCloudField();
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const A = new Float32Array(MAX_PUFFS * 4), Bb = new Float32Array(MAX_PUFFS * 4), Cc = new Float32Array(MAX_PUFFS * 4);
  const iA = new THREE.InstancedBufferAttribute(A, 4).setUsage(THREE.DynamicDrawUsage);
  const iB = new THREE.InstancedBufferAttribute(Bb, 4).setUsage(THREE.DynamicDrawUsage);
  const iC = new THREE.InstancedBufferAttribute(Cc, 4).setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute('iA', iA);
  quad.setAttribute('iB', iB);
  quad.setAttribute('iC', iC);
  quad.instanceCount = 0;
  const uniforms = {
    tPuff: { value: puffTexture() },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightCol: { value: new THREE.Color(4, 4, 4) },
    uAmbTop: { value: new THREE.Color(0.8, 0.85, 0.95) },
    uAmbBot: { value: new THREE.Color(0.4, 0.45, 0.55) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...HAZE },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1; // vor den transparenten Flugzeugteilen (Scheiben, Propellerscheibe)
  mesh.visible = false;
  scene.add(mesh);

  // ---------------------------------------------------------------- Schattentextur (Draufsicht)
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SHADOW_RES;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const shadowTex = new THREE.CanvasTexture(canvas);
  shadowTex.colorSpace = THREE.NoColorSpace;
  shadowTex.minFilter = THREE.LinearFilter;
  shadowTex.generateMipmaps = false;
  shadowTex.flipY = false; // Zeile 0 = −Z-Rand (wie die UV-Berechnung im Shader)
  shadowTex.wrapS = shadowTex.wrapT = THREE.ClampToEdgeWrapping;
  let shadowPixels = null;
  const shadowState = { cx: 1e9, cz: 1e9, t: 0, version: -1, layerMid: 0 };
  const list = [];

  function drawShadows(cx, cz) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SHADOW_RES, SHADOW_RES);
    const k = SHADOW_RES / SHADOW_SIZE;
    field.cloudsNear(cx, cz, SHADOW_SIZE * 0.72, list);
    ctx.globalCompositeOperation = 'lighter';
    for (const cl of list) {
      for (let p = 0; p < Math.min(cl.puffs.length, 10); p++) {
        const pf = cl.puffs[p];
        const px = (cl.x + pf.ox - cx) * k + SHADOW_RES / 2, pz = (cl.z + pf.oz - cz) * k + SHADOW_RES / 2;
        const r = pf.r * k * 1.1;
        if (px < -r || pz < -r || px > SHADOW_RES + r || pz > SHADOW_RES + r) continue;
        const g = ctx.createRadialGradient(px, pz, 0, px, pz, r);
        g.addColorStop(0, 'rgba(120,120,120,1)');
        g.addColorStop(0.6, 'rgba(80,80,80,1)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    shadowPixels = ctx.getImageData(0, 0, SHADOW_RES, SHADOW_RES).data;
    shadowTex.needsUpdate = true;
    CLOUD_SHADOW.tCloudShadow.value = shadowTex;
    CLOUD_SHADOW.uCloudShadowRect.value.set(cx, cz, SHADOW_SIZE);
    shadowState.cx = cx;
    shadowState.cz = cz;
  }

  /** Direktlicht-Anteil am Punkt (x, y, z) – dieselbe Projektion wie cloudShadow() im Shader. */
  function sunShadeAt(x, y, z, L) {
    if (!shadowPixels || CLOUD_SHADOW.uCloudShadowOn.value < 0.5 || L.y < 0.03) return 1;
    const lay = CLOUD_SHADOW.uCloudLayer.value;
    const hMid = lay.x + (lay.y - lay.x) * 0.35;
    if (y > hMid) return 1;
    const qx = x + (L.x * (hMid - y)) / L.y, qz = z + (L.z * (hMid - y)) / L.y;
    const u = (qx - shadowState.cx) / SHADOW_SIZE + 0.5, v = (qz - shadowState.cz) / SHADOW_SIZE + 0.5;
    if (u <= 0 || v <= 0 || u >= 1 || v >= 1) return 1;
    const px = Math.min(SHADOW_RES - 1, Math.floor(u * SHADOW_RES)), py = Math.min(SHADOW_RES - 1, Math.floor(v * SHADOW_RES));
    const s = shadowPixels[(py * SHADOW_RES + px) * 4] / 255;
    return 1 - s * 0.75;
  }

  // ---------------------------------------------------------------- Instanzen (sortiert)
  const order = new Uint32Array(MAX_PUFFS);
  const keys = new Float32Array(MAX_PUFFS);
  const tmp = new Float32Array(MAX_PUFFS * 12);
  const stats = { clouds: 0, instances: 0, cloudsIn10km: 0 };
  const viewList = [];

  /**
   * Pro Frame: camPos/viewDir (THREE.Vector3), fovDeg/aspect der Kamera, dt (Schattentextur-Takt),
   * env (clouds %, cloudBase_ft). Die Drift läuft im Physiktakt (stepPhysics).
   */
  function update(camPos, viewDir, fovDeg, aspect, dt, env) {
    field.setParams((env.clouds ?? 0) / 100, (env.cloudBase_ft ?? 4000) * 0.3048);
    const cov = field.field.coverage;
    CLOUD_SHADOW.uCloudLayer.value.set(field.field.base, field.field.base + 250 + 450 * cov);
    if (cov <= 0) {
      mesh.visible = false;
      quad.instanceCount = 0;
      stats.clouds = stats.instances = stats.cloudsIn10km = 0;
      CLOUD_SHADOW.uCloudShadowOn.value = 0;
      shadowPixels = null;
      return;
    }
    // Schattentextur: bei Bewegung > 1 km, Parameterwechsel oder alle 2 s (Drift)
    shadowState.t += dt;
    const sx = Math.round(camPos.x / 500) * 500, sz = Math.round(camPos.z / 500) * 500;
    if (shadowState.version !== field.field.version || Math.hypot(sx - shadowState.cx, sz - shadowState.cz) > 1000 || shadowState.t > 2) {
      shadowState.version = field.field.version;
      shadowState.t = 0;
      drawShadows(sx, sz);
    }
    CLOUD_SHADOW.uCloudShadowOn.value = 1;

    field.cloudsNear(camPos.x, camPos.z, VIEW_RADIUS, viewList);
    stats.clouds = viewList.length;
    const halfDiag = Math.atan(Math.tan((fovDeg * Math.PI) / 360) * Math.sqrt(1 + aspect * aspect));
    let n = 0, c10 = 0;
    for (const cl of viewList) {
      const cy = (cl.base + cl.top) / 2;
      const dx = cl.x - camPos.x, dy = cy - camPos.y, dz = cl.z - camPos.z;
      const d = Math.hypot(dx, dy, dz);
      if (Math.hypot(dx, dz) <= 10000) c10++;
      const R = Math.max(cl.rx, cl.rz, cl.top - cl.base) * 1.3;
      if (d > R) {
        const cosA = (dx * viewDir.x + dy * viewDir.y + dz * viewDir.z) / d;
        const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
        if (ang > halfDiag + Math.asin(Math.min(1, R / d)) + 0.05) continue;
      }
      const far = d > LOD_DIST;
      const np = far ? Math.min(5, cl.puffs.length) : cl.puffs.length;
      const grow = far ? 1.25 : 1;
      const th = cl.top - cl.base;
      for (let p = 0; p < np && n < MAX_PUFFS; p++) {
        const pf = cl.puffs[p];
        const px = cl.x + pf.ox, py = cl.base + pf.oy, pz = cl.z + pf.oz;
        const o = n * 12;
        tmp[o] = px;
        tmp[o + 1] = py;
        tmp[o + 2] = pz;
        tmp[o + 3] = pf.r * grow * 1.35;
        const ol = Math.hypot(pf.ox / cl.rx, (pf.oy - th * 0.45) / (th * 0.6 + 1), pf.oz / cl.rz) || 1;
        tmp[o + 4] = pf.ox / cl.rx / ol;
        tmp[o + 5] = (pf.oy - th * 0.45) / (th * 0.6 + 1) / ol;
        tmp[o + 6] = pf.oz / cl.rz / ol;
        tmp[o + 7] = Math.min(1, pf.oy / Math.max(th, 1));
        tmp[o + 8] = pf.v;
        tmp[o + 9] = (pf.v * 1.7 + p * 2.3) % 6.283;
        tmp[o + 10] = 0.92;
        tmp[o + 11] = cl.base;
        const ex = px - camPos.x, ey = py - camPos.y, ez = pz - camPos.z;
        keys[n] = ex * ex + ey * ey + ez * ez;
        order[n] = n;
        n++;
      }
    }
    stats.cloudsIn10km = c10;
    const ord = order.subarray(0, n);
    ord.sort((a, b) => keys[b] - keys[a]); // von hinten nach vorn
    for (let k = 0; k < n; k++) {
      const o = ord[k] * 12;
      A.set(tmp.subarray(o, o + 4), k * 4);
      Bb.set(tmp.subarray(o + 4, o + 8), k * 4);
      Cc.set(tmp.subarray(o + 8, o + 12), k * 4);
    }
    for (const at of [iA, iB, iC]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, Math.max(n, 1) * 4);
      at.needsUpdate = true;
    }
    quad.instanceCount = n;
    mesh.visible = n > 0;
    stats.instances = n;
  }

  /** Beleuchtung aus dem Himmel übernehmen (Sonne bzw. Mond, Himmelslicht). */
  function setLighting(sky) {
    const L = sky.sun;
    uniforms.uLightDir.value.copy(sky.state.cloudLightDir);
    uniforms.uLightCol.value.copy(sky.state.cloudLight);
    const si = sky.hemiWorld.intensity;
    uniforms.uAmbTop.value.copy(sky.hemiWorld.color).multiplyScalar(si * 0.62);
    uniforms.uAmbBot.value.copy(sky.hemiWorld.color).lerp(sky.hemiWorld.groundColor, 0.35).multiplyScalar(si * 0.3);
    CLOUD_SHADOW.uLightDir.value.copy(L.position).sub(L.target.position).normalize();
  }

  /** Farbe des Wolkeninneren (Fog in der Wolke). */
  function insideColor(out) {
    const l = uniforms.uLightCol.value;
    out.copy(uniforms.uAmbTop.value).multiplyScalar(0.95);
    out.r += l.r * 0.05;
    out.g += l.g * 0.05;
    out.b += l.b * 0.05;
    return out;
  }

  /**
   * Physiktakt (deterministisch): Wolkenfeld mit dem Wind treiben lassen und die Dichte am Flugzeug liefern
   * (Turbulenz in der Wolke). Aufruf einmal pro festem Physikschritt.
   */
  function stepPhysics(dt, env, windX, windZ, x, y, z) {
    field.setParams((env.clouds ?? 0) / 100, (env.cloudBase_ft ?? 4000) * 0.3048);
    field.advance(dt, windX, windZ);
    return field.densityAt(x, y, z);
  }

  return {
    mesh,
    field,
    stepPhysics,
    resetDrift() {
      field.field.driftX = field.field.driftZ = 0;
    },
    update,
    setLighting,
    insideColor,
    densityAt: (x, y, z) => field.densityAt(x, y, z),
    sunShadeAt,
    stats,
    shadowTexture: shadowTex,
  };
}
