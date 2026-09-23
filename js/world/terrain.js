// Terrain: 5 × 5 Nahkacheln à 1024 m – innerer 3 × 3-Block LOD 0 (16-m-Raster, identische Triangulierung wie
// groundHeight), äußerer Ring LOD 1 (32 m, jeder zweite LOD-0-Vertex) – plus ein grobes Fern-Mesh (±24 km, 256 m),
// das beim Weiterfliegen zeilenweise in einen zweiten Puffer neu entsteht (Double Buffer).
// Budget: höchstens 2 Nahkacheln pro Update (tileplan.js); Meshes werden wiederverwendet (keine Neuallokation).
// Vertices liegen kachel-lokal (float32-genau), Mesh.position = Kachelursprung. T-Junctions zwischen LOD 0/1 und die
// Kante zum Fern-Mesh verdecken Skirts (Randstreifen nach unten).
//
// Terrain-Shader (MeshStandardMaterial + onBeforeCompile): Albedo aus Höhe, Neigung, Landbedeckung (Vertex-Attribut
// „cover“ aus landcover.js) und Rauschtextur: Wiese, Acker-Patchwork, Wald, Fels, Alm, Schnee, Ufer. Muster nutzen
// modulo-reduzierte Weltkoordinaten (vPat = Welt − uPatOrigin, uPatOrigin = Vielfaches von 32 768 m; alle Muster sind
// 32 768-periodisch → kein Sprung beim Umsetzen). Seen: eigene Wasser-Meshes pro Kachel (nur Quads mit Wasser),
// die den Positionspuffer der Kachel teilen; Seegrund wird im Shader abgesenkt (kein Z-Fighting am Ufer).
import * as THREE from 'three';
import { terrainHeight, GRID, WATER_LEVEL, SNOW_LINE } from './heightfield.js';
import { landcover } from './landcover.js';
import { TILE, NEAR, streamTiles, tileKey } from './tileplan.js';
import { noiseTexture } from './noisetex.js';
import { patchHaze, CLOUD_SHADOW, CLOUD_SHADOW_GLSL } from './sky.js';

export { TILE };
const SEG0 = TILE / GRID; // 64 Segmente (LOD 0)
const SEG1 = SEG0 / 2; // 32 Segmente (LOD 1)
const SKIRT = 20; // m Randstreifen nach unten
const FAR_N = 192; // Quads je Richtung
const FAR_STEP = 256; // m
const FAR_REBUILD = 2000; // m Abstand vom Fern-Mesh-Zentrum bis zum Neuaufbau
const FAR_ROWS_PER_UPDATE = 16;
export const PAT_PERIOD = 32768; // m – Periode aller Shader-Muster

// ------------------------------------------------------------------ Farben (sRGB-Hex → linear über THREE.Color)
const C = (hex) => new THREE.Color(hex);
const TU = {
  tNoise: { value: null },
  uPatOrigin: { value: new THREE.Vector2() },
  uWaterLevel: { value: WATER_LEVEL },
  uSnowLine: { value: SNOW_LINE },
  cGrassA: { value: C(0x56752f) },
  cGrassB: { value: C(0x6f8c37) },
  cGrassDry: { value: C(0x8f9147) },
  cMowed: { value: C(0x6a8d3a) },
  cForestA: { value: C(0x2a4722) },
  cForestB: { value: C(0x3b5a2e) },
  cConifer: { value: C(0x223b26) },
  cRock: { value: C(0x6e675c) },
  cRockB: { value: C(0x8b8376) },
  cSnow: { value: C(0xeef2f6) },
  cSand: { value: C(0xa4966f) },
  cBed: { value: C(0x3d4a3e) },
  cAlpine: { value: C(0x7a7e4c) },
  cHedge: { value: C(0x2f4a22) },
  cTrack: { value: C(0x9a8f76) },
  cField: {
    value: [0x9aa84e, 0xc2ac5c, 0x6f913a, 0x7a5e3f, 0x5d7f2e, 0xb49a57, 0x8a6a48, 0xc8c05a].map(C),
  },
};

const TERRAIN_PARS = /* glsl */ `
uniform sampler2D tNoise;
uniform float uWaterLevel, uSnowLine;
uniform vec3 cGrassA, cGrassB, cGrassDry, cMowed, cForestA, cForestB, cConifer, cRock, cRockB, cSnow, cSand, cBed,
  cAlpine, cHedge, cTrack;
uniform vec3 cField[8];
varying vec4 vCover;
varying vec3 vTW;
varying vec3 vTN;
varying vec2 vPat;
${CLOUD_SHADOW_GLSL}
uint tHash(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float tRand(ivec2 c, int s) { return float(tHash(uvec2(c + ivec2(s * 7919, s * 3571))) & 0xffffu) / 65535.0; }

// Acker-Patchwork: Region 2048 m (Hash-IDs 16-periodisch → 32 768 m), darin gedrehtes Feldraster mit
// unterschiedlichen Feldbreiten, Hecken/Feldraine an Kanten, Bearbeitungsspuren, Feldweg an Regionsgrenzen.
vec3 fields(vec3 base, vec2 P, float fine, float aa, out float hedge) {
  vec2 rp = P / 2048.0;
  ivec2 rid = ivec2(floor(rp)) & 15;
  vec2 rl = (fract(rp) - 0.5) * 2048.0;
  float ang = (tRand(rid, 1) - 0.5) * 1.2 + (tRand(rid, 2) > 0.7 ? 1.5708 : 0.0);
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(ca * rl.x - sa * rl.y, sa * rl.x + ca * rl.y);
  float wx = mix(70.0, 190.0, tRand(rid, 3));
  float wz = mix(140.0, 320.0, tRand(rid, 4));
  float row = floor(q.y / wz);
  float shift = (tRand(rid + ivec2(int(row), 0), 5) - 0.5) * wx;
  vec2 cq = vec2((q.x + shift) / wx, q.y / wz);
  ivec2 cell = ivec2(floor(cq));
  vec2 f = fract(cq);
  // Flurstücke: jede Zelle ist in 1–3 Streifen geteilt (unregelmäßige Feldbreiten)
  float k = floor(tRand(cell + rid * 64, 11) * 2.999) + 1.0;
  float sub = floor(f.x * k);
  f.x = fract(f.x * k);
  float sw = wx / k;
  ivec2 fid = cell * 4 + ivec2(int(sub), 0) + rid * 256;
  float crop = tRand(fid, 6);
  vec3 fc = cField[int(floor(tRand(fid, 7) * 7.999))];
  fc *= 0.88 + 0.24 * tRand(fid, 8);
  fc *= 0.94 + 0.12 * f.y; // leichter Verlauf (Bodenfeuchte, Bearbeitungsrichtung)
  // Bearbeitungsspuren (Reihen längs der Feldachse), nur in der Nähe und nur so fein wie auflösbar
  float rowAA = clamp(1.0 - fwidth(q.x) * 1.2, 0.0, 1.0);
  float rows = 0.5 + 0.5 * sin(q.x * 2.2 + tRand(fid, 9) * 6.28);
  fc *= 1.0 - fine * rowAA * 0.1 * rows;
  // Feldkanten: Rain (Gras) bzw. Hecke; Breite wächst mit dem Pixel-Footprint (Anti-Aliasing)
  float ex = min(f.x, 1.0 - f.x) * sw, ez = min(f.y, 1.0 - f.y) * wz;
  float edge = min(ex, ez);
  float rain = 1.0 - smoothstep(1.5, 2.5 + aa, edge);
  hedge = (tRand(fid, 10) > 0.62 ? 1.0 : 0.0) * (1.0 - smoothstep(2.0, 5.0 + aa, edge));
  vec3 c = crop < 0.12 ? base : fc; // einzelne Wiesenparzellen
  c = mix(c, base * 1.05, rain);
  // Feldweg an der Regionsgrenze
  vec2 re = min(fract(rp), 1.0 - fract(rp)) * 2048.0;
  float track = 1.0 - smoothstep(2.0, 3.5 + aa, min(re.x, re.y));
  c = mix(c, cTrack, track * 0.85);
  hedge *= 1.0 - track;
  return c;
}

vec3 terrainAlbedo() {
  vec2 P = vPat;
  float dist = length(vTW - cameraPosition);
  float aa = length(fwidth(P));
  vec4 nA = texture(tNoise, P / 2048.0);
  vec4 nB = texture(tNoise, P / 256.0);
  vec4 nC = texture(tNoise, P / 32.0);
  vec4 nD = texture(tNoise, P / 4.0);
  float fine = 1.0 - smoothstep(120.0, 700.0, dist);
  float h = vTW.y;
  vec3 N = normalize(vTN);
  float slope = 1.0 - N.y;

  // Wiese (großräumig feuchter/trockener, kleinräumig fleckig)
  vec3 grass = mix(cGrassA, cGrassB, clamp(vCover.z * 0.9 + (nA.r - 0.5) * 0.8, 0.0, 1.0));
  grass = mix(grass, cGrassDry, smoothstep(0.55, 0.85, nB.g) * 0.45);
  grass *= 0.88 + 0.24 * nC.b + fine * 0.18 * (nD.a - 0.5);
  vec3 col = grass;

  // Acker-Patchwork
  float fm = smoothstep(0.35, 0.65, vCover.y + (nB.r - 0.5) * 0.35);
  if (fm > 0.001) {
    float hedge;
    vec3 fc = fields(grass, P, fine, aa, hedge);
    col = mix(col, fc, fm);
    col = mix(col, cHedge * (0.8 + 0.4 * nD.g), hedge * fm);
  }
  // Flugplatz: gemähtes Gras mit Mähstreifen längs der Piste
  if (vCover.w > 0.001) {
    // Mähstreifen (16 m) längs der Piste, Rasenflecken, Fahrspuren; weiter weg nur die Grundtönung
    float stripe = step(0.5, fract(P.y / 16.0)) * clamp(1.0 - aa / 8.0, 0.0, 1.0);
    vec3 m = mix(grass, cMowed, 0.55) * (0.9 + 0.1 * stripe + 0.16 * (nC.r - 0.5) + 0.1 * (nB.b - 0.5));
    m *= 1.0 + fine * 0.14 * (nD.g - 0.5);
    col = mix(col, m, vCover.w);
  }
  // Wald: Kronendach mit Lücken, in der Höhe mehr Nadelwald
  float fo = smoothstep(0.42, 0.58, vCover.x + (nB.b - 0.5) * 0.45 + (nC.r - 0.5) * 0.14);
  if (fo > 0.001) {
    vec3 fcol = mix(cForestA, cForestB, nC.g);
    fcol = mix(fcol, cConifer, smoothstep(650.0, 1100.0, h + (nA.g - 0.5) * 300.0));
    float crowns = smoothstep(0.25, 0.75, nD.r) * fine + (1.0 - fine) * 0.5;
    fcol *= 0.62 + 0.62 * crowns + 0.2 * (nC.a - 0.5);
    col = mix(col, fcol, fo);
  }
  // Almwiesen
  col = mix(col, cAlpine * (0.85 + 0.3 * nC.b), smoothstep(1300.0, 1650.0, h + (nA.g - 0.5) * 250.0) * (1.0 - fo * 0.7));
  // Fels an steilen Hängen: grau bis ockerfarben, Schichtung nur so fein wie auflösbar, Geröll-/Graspolster
  float rk = smoothstep(0.26, 0.42, slope + (nB.a - 0.5) * 0.2 + (nC.b - 0.5) * 0.08);
  float strata = 0.12 * sin(h * 0.33 + nB.r * 6.0) * clamp(1.0 - fwidth(h) * 0.25, 0.0, 1.0);
  vec3 rock = mix(cRock, cRockB, nC.a) * mix(vec3(1.0), vec3(1.08, 0.98, 0.86), nA.a);
  rock *= 0.8 + 0.3 * nD.b * fine + 0.18 * (nB.g - 0.5) + strata;
  col = mix(col, rock, rk);
  // Schnee (Schneegrenze mit Rauschen, an Steilhängen weniger)
  float sl = uSnowLine + (nA.b - 0.5) * 320.0;
  float sn = smoothstep(sl, sl + 70.0, h) * (1.0 - smoothstep(0.32, 0.55, slope + (nC.g - 0.5) * 0.2));
  col = mix(col, cSnow * (0.92 + 0.08 * nC.r), sn);
  // Ufer und Seegrund
  float sand = 1.0 - smoothstep(uWaterLevel + 0.8, uWaterLevel + 3.0 + nC.r * 2.0, h);
  col = mix(col, cSand * (0.9 + 0.2 * nD.b * fine), sand);
  col = mix(col, cBed, 1.0 - smoothstep(uWaterLevel - 3.0, uWaterLevel, h));
  return col;
}
`;

// ------------------------------------------------------------------ Geometrie-Hilfen
/** Index für ein Raster mit seg Segmenten + Skirts (Diagonale (x0,z1)–(x1,z0) wie groundHeight). */
function gridIndex(seg) {
  const W = seg + 1, NV = W * W;
  const idx = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1; // a=00 b=10 c=01 d=11
      idx.push(a, c, b, d, b, c);
    }
  }
  const edges = [(k) => k, (k) => seg * W + k, (k) => k * W, (k) => k * W + seg];
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < seg; k++) {
      const a = edges[e](k), b = edges[e](k + 1);
      const sa = NV + e * W + k, sb = sa + 1;
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // beidseitig
    }
  }
  return new THREE.BufferAttribute(new Uint16Array(idx), 1);
}

export function createTerrain(scene, opts = {}) {
  const tex = noiseTexture();
  TU.tNoise.value = tex;
  const hooks = opts.hooks || {};
  const waterMat = opts.waterMaterial || null;
  const waterFarMat = opts.waterFarMaterial || null;

  // uCov: 25 Flags (5 × 5-Block, Zeile = z), 1 = Nahkachel fertig → Fern-Mesh dort verwerfen
  const farU = {
    uNearMin: { value: new THREE.Vector2() },
    uNearMax: { value: new THREE.Vector2() },
    uCov: { value: new Float32Array(25) },
  };

  function terrainMaterial(far) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, TU, CLOUD_SHADOW, far ? farU : {});
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 cover;
          uniform vec2 uPatOrigin;
          uniform float uWaterLevel;
          varying vec4 vCover;
          varying vec3 vTW;
          varying vec3 vTN;
          varying vec2 vPat;
          ${far ? 'varying vec2 vFarXZ;' : ''}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vCover = cover;
          vTN = normal;
          vec4 tw = modelMatrix * vec4(transformed, 1.0);
          vTW = tw.xyz;
          vPat = tw.xz - uPatOrigin;
          ${far ? 'vFarXZ = position.xz;' : ''}
          // Seegrund absenken: Ufer schneidet die Wasserfläche steil, und der Abstand zur Wasserfläche wächst mit der
          // Entfernung (Tiefenpuffer-Auflösung ≈ d²/(near·2²⁴)) → kein Z-Fighting zwischen Seegrund und Wasser
          if (transformed.y < uWaterLevel) {
            float dCam = length(tw.xyz - cameraPosition);
            transformed.y = uWaterLevel - 1.5 - dCam * dCam * 2.5e-7 - dCam * 0.001 - (uWaterLevel - transformed.y) * 1.5;
          }`,
        );
      let fs = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TERRAIN_PARS}`)
        .replace('#include <color_fragment>', 'diffuseColor.rgb = terrainAlbedo();')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          { float cs = cloudShadow(vTW); reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`,
        );
      if (far) {
        // Unter fertigen Nahkacheln das grobe Netz verwerfen (sonst sticht es bei Graten durch). Der 5×5-Block liegt
        // auf dem 1024-m-Raster und damit auf Fern-Vertices: jedes Dreieck liegt ganz innen oder ganz außen.
        fs = fs
          .replace('#include <common>', '#include <common>\nuniform vec2 uNearMin;\nuniform vec2 uNearMax;\nuniform float uCov[25];\nvarying vec2 vFarXZ;')
          .replace(
            'void main() {',
            `void main() {
            if (all(greaterThan(vFarXZ, uNearMin + 0.5)) && all(lessThan(vFarXZ, uNearMax - 0.5))) {
              ivec2 t = ivec2(floor((vFarXZ - uNearMin) / ${TILE}.0));
              if (uCov[t.y * 5 + t.x] > 0.5) discard; // nur unter fertigen Nahkacheln
            }`,
          );
      }
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => (far ? 'terrain-far' : 'terrain-near');
    return patchHaze(m);
  }
  const mat = terrainMaterial(false);
  const farMat = terrainMaterial(true);
  if (waterFarMat) Object.assign(waterFarMat.uniforms, farU); // Verwerfen unter fertigen Nahkacheln
  for (const wm of [waterMat, waterFarMat]) if (wm) wm.uniforms.uPatOrigin = TU.uPatOrigin; // gleiche Musterkoordinaten

  // ---------------------------------------------------------------- Nahkacheln
  const W0 = SEG0 + 1;
  const NV0 = W0 * W0;
  const CAP = NV0 + 4 * W0; // Vertices inkl. Skirts (LOD 0 ist die größte Stufe)
  const index = [gridIndex(SEG0), gridIndex(SEG1)];
  const H = new Float64Array((SEG0 + 3) * (SEG0 + 3));
  const cov = [0, 0, 0, 0];
  const tiles = new Map(); // key → { tx, tz, lod, mesh, water, slot }
  let generated = 0;
  let slots = 0;

  function newRecord() {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(CAP * 3), 3);
    g.setAttribute('position', pos);
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
    g.setAttribute('cover', new THREE.BufferAttribute(new Float32Array(CAP * 4), 4));
    g.setIndex(index[0]);
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox = new THREE.Box3();
    const m = new THREE.Mesh(g, mat);
    m.name = 'tile';
    m.matrixAutoUpdate = false;
    m.receiveShadow = false;
    m.castShadow = false;
    scene.add(m);
    let water = null;
    if (waterMat) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', pos); // geteilter Positionspuffer
      wg.setIndex(new THREE.BufferAttribute(new Uint16Array(SEG0 * SEG0 * 6), 1));
      wg.boundingSphere = new THREE.Sphere();
      water = new THREE.Mesh(wg, waterMat);
      water.name = 'lake';
      water.matrixAutoUpdate = false;
      water.visible = false;
      scene.add(water);
    }
    return { mesh: m, water, slot: slots++, tx: 0, tz: 0, lod: 0 };
  }

  /** Kachel (tx, tz) in LOD lod in den Datensatz schreiben. */
  function fillTile(rec, tx, tz, lod) {
    const m = rec.mesh;
    const g = m.geometry;
    const seg = lod ? SEG1 : SEG0, step = TILE / seg, W = seg + 1, NV = W * W, HW = seg + 3;
    const P = g.attributes.position.array, Nn = g.attributes.normal.array, Cv = g.attributes.cover.array;
    const x0 = tx * TILE, z0 = tz * TILE;
    for (let j = -1; j <= seg + 1; j++) {
      for (let i = -1; i <= seg + 1; i++) H[(j + 1) * HW + (i + 1)] = terrainHeight(x0 + i * step, z0 + j * step);
    }
    let hMin = Infinity, hMax = -Infinity;
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const k = j * W + i;
        const hc = H[(j + 1) * HW + (i + 1)];
        const hl = H[(j + 1) * HW + i], hr = H[(j + 1) * HW + i + 2];
        const hu = H[j * HW + i + 1], hd = H[(j + 2) * HW + i + 1];
        let nx = -(hr - hl) / (2 * step), nz = -(hd - hu) / (2 * step), ny = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        P[k * 3] = i * step;
        P[k * 3 + 1] = hc;
        P[k * 3 + 2] = j * step;
        Nn[k * 3] = nx;
        Nn[k * 3 + 1] = ny;
        Nn[k * 3 + 2] = nz;
        landcover(x0 + i * step, z0 + j * step, hc, ny, cov);
        Cv[k * 4] = cov[0];
        Cv[k * 4 + 1] = cov[1];
        Cv[k * 4 + 2] = cov[2];
        Cv[k * 4 + 3] = cov[3];
        if (hc < hMin) hMin = hc;
        if (hc > hMax) hMax = hc;
      }
    }
    // Skirts: Kantenvertices mindestens 20 m tiefer und bis unter die Kante des groben Fern-Meshes
    // (Kachelkanten liegen auf dem 256-m-Raster; dort ist das Fern-Mesh linear zwischen seinen Vertices).
    const edgeK = [(k) => k, (k) => seg * W + k, (k) => k * W, (k) => k * W + seg];
    const farEdge = (wx, wz, alongX) => {
      const u = (alongX ? wx : wz) / FAR_STEP, u0 = Math.floor(u), f = u - u0;
      const a = alongX ? terrainHeight(u0 * FAR_STEP, wz) : terrainHeight(wx, u0 * FAR_STEP);
      if (f === 0) return a;
      const b = alongX ? terrainHeight((u0 + 1) * FAR_STEP, wz) : terrainHeight(wx, (u0 + 1) * FAR_STEP);
      return a + (b - a) * f;
    };
    let yMin = hMin - SKIRT;
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k <= seg; k++) {
        const src = edgeK[e](k), dst = NV + e * W + k;
        const wx = x0 + P[src * 3], wz = z0 + P[src * 3 + 2];
        const hEdge = P[src * 3 + 1];
        P[dst * 3] = P[src * 3];
        P[dst * 3 + 1] = Math.min(hEdge - SKIRT, farEdge(wx, wz, e < 2) - 2);
        if (P[dst * 3 + 1] < yMin) yMin = P[dst * 3 + 1];
        P[dst * 3 + 2] = P[src * 3 + 2];
        for (let c = 0; c < 3; c++) Nn[dst * 3 + c] = Nn[src * 3 + c];
        for (let c = 0; c < 4; c++) Cv[dst * 4 + c] = Cv[src * 4 + c];
      }
    }
    const used = NV + 4 * W;
    for (const name of ['position', 'normal', 'cover']) {
      const a = g.attributes[name];
      a.clearUpdateRanges();
      a.addUpdateRange(0, used * a.itemSize);
      a.needsUpdate = true;
    }
    if (g.index !== index[lod]) g.setIndex(index[lod]);
    g.boundingBox.min.set(0, yMin, 0);
    g.boundingBox.max.set(TILE, hMax, TILE);
    g.boundingBox.getBoundingSphere(g.boundingSphere);
    m.position.set(x0, 0, z0);
    m.updateMatrix();
    m.updateMatrixWorld(true);
    m.visible = true;

    // Seen: Quads mit mindestens einem Vertex unter dem Wasserspiegel
    if (rec.water) {
      const wi = rec.water.geometry.index;
      const I = wi.array;
      let n = 0;
      for (let j = 0; j < seg; j++) {
        for (let i = 0; i < seg; i++) {
          const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
          if (Math.min(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]) >= WATER_LEVEL) continue;
          I[n++] = a;
          I[n++] = c;
          I[n++] = b;
          I[n++] = d;
          I[n++] = b;
          I[n++] = c;
        }
      }
      const wg = rec.water.geometry;
      wg.setDrawRange(0, n);
      wi.clearUpdateRanges();
      wi.addUpdateRange(0, Math.max(n, 1));
      wi.needsUpdate = true;
      wg.boundingSphere.center.set(TILE / 2, WATER_LEVEL, TILE / 2);
      wg.boundingSphere.radius = TILE * 0.75;
      rec.water.position.set(x0, 0, z0);
      rec.water.updateMatrix();
      rec.water.updateMatrixWorld(true);
      rec.water.visible = n > 0;
    }
    rec.tx = tx;
    rec.tz = tz;
    rec.lod = lod;
    generated++;
    if (hooks.onFill) hooks.onFill(rec, { H, HW, seg, step, cover: Cv, x0, z0 });
    return rec;
  }

  // ---------------------------------------------------------------- Fern-Mesh (Double Buffer)
  const FV = (FAR_N + 1) * (FAR_N + 1);
  const farIndex = (() => {
    const idx = new Uint16Array(FAR_N * FAR_N * 6);
    let o = 0;
    const W = FAR_N + 1;
    for (let j = 0; j < FAR_N; j++) {
      for (let i = 0; i < FAR_N; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = b;
        idx[o++] = d;
        idx[o++] = b;
        idx[o++] = c;
      }
    }
    return new THREE.BufferAttribute(idx, 1);
  })();
  const farMeshes = [0, 1].map(() => {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(FV * 3), 3);
    g.setAttribute('position', pos);
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(FV * 3), 3));
    g.setAttribute('cover', new THREE.BufferAttribute(new Float32Array(FV * 4), 4));
    g.setIndex(farIndex);
    const m = new THREE.Mesh(g, farMat);
    m.name = 'farTerrain';
    m.frustumCulled = false;
    m.visible = false;
    m.matrixAutoUpdate = false;
    scene.add(m);
    if (waterFarMat) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', pos);
      wg.setIndex(new THREE.BufferAttribute(new Uint16Array(FAR_N * FAR_N * 6), 1));
      const w = new THREE.Mesh(wg, waterFarMat);
      w.name = 'farLakes';
      w.frustumCulled = false;
      w.visible = false;
      w.matrixAutoUpdate = false;
      scene.add(w);
      m.userData.water = w;
    }
    return m;
  });
  const far = { active: -1, job: null, cx: 0, cz: 0 };
  const FH = new Float64Array((FAR_N + 3) * (FAR_N + 3));

  function startFar(x, z) {
    const cx = Math.round(x / TILE) * TILE, cz = Math.round(z / TILE) * TILE;
    far.job = { cx, cz, ox: cx - (FAR_N / 2) * FAR_STEP, oz: cz - (FAR_N / 2) * FAR_STEP, hr: 0, target: far.active === 0 ? 1 : 0 };
  }
  /** Fern-Mesh-Job um bis zu `rows` Höhenzeilen fortsetzen; true, wenn fertig (und getauscht). */
  function stepFar(rows) {
    const job = far.job;
    if (!job) return false;
    const W = FAR_N + 3;
    const m = farMeshes[job.target];
    const g = m.geometry;
    const P = g.attributes.position.array, Nn = g.attributes.normal.array, Cv = g.attributes.cover.array;
    for (let n = 0; n < rows && job.hr < W; n++, job.hr++) {
      const j = job.hr - 1;
      for (let i = -1; i <= FAR_N + 1; i++) FH[job.hr * W + (i + 1)] = terrainHeight(job.ox + i * FAR_STEP, job.oz + j * FAR_STEP);
      // Vertexzeile v = hr − 2 ist fertig, sobald ihre Nachbarzeilen vorliegen
      const v = job.hr - 2;
      if (v < 0) continue;
      for (let i = 0; i <= FAR_N; i++) {
        const k = v * (FAR_N + 1) + i;
        const hc = FH[(v + 1) * W + i + 1];
        let nx = -(FH[(v + 1) * W + i + 2] - FH[(v + 1) * W + i]) / (2 * FAR_STEP);
        let nz = -(FH[(v + 2) * W + i + 1] - FH[v * W + i + 1]) / (2 * FAR_STEP);
        let ny = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        P[k * 3] = i * FAR_STEP;
        P[k * 3 + 1] = hc;
        P[k * 3 + 2] = v * FAR_STEP;
        Nn[k * 3] = nx;
        Nn[k * 3 + 1] = ny;
        Nn[k * 3 + 2] = nz;
        landcover(job.ox + i * FAR_STEP, job.oz + v * FAR_STEP, hc, ny, cov);
        Cv[k * 4] = cov[0];
        Cv[k * 4 + 1] = cov[1];
        Cv[k * 4 + 2] = cov[2];
        Cv[k * 4 + 3] = cov[3];
      }
    }
    if (job.hr < W) return false;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.cover.needsUpdate = true;
    m.position.set(job.ox, 0, job.oz);
    m.updateMatrix();
    m.updateMatrixWorld(true);
    m.visible = true;
    const w = m.userData.water;
    if (w) {
      const I = w.geometry.index.array;
      const WV = FAR_N + 1;
      let n = 0;
      for (let jj = 0; jj < FAR_N; jj++) {
        for (let ii = 0; ii < FAR_N; ii++) {
          const a = jj * WV + ii, b = a + 1, c = a + WV, d = c + 1;
          if (Math.min(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]) >= WATER_LEVEL) continue;
          I[n++] = a;
          I[n++] = c;
          I[n++] = b;
          I[n++] = d;
          I[n++] = b;
          I[n++] = c;
        }
      }
      w.geometry.setDrawRange(0, n);
      w.geometry.index.needsUpdate = true;
      w.position.copy(m.position);
      w.updateMatrix();
      w.updateMatrixWorld(true);
      w.visible = n > 0;
    }
    if (far.active >= 0 && far.active !== job.target) {
      farMeshes[far.active].visible = false;
      if (farMeshes[far.active].userData.water) farMeshes[far.active].userData.water.visible = false;
    }
    far.active = job.target;
    far.cx = job.cx;
    far.cz = job.cz;
    far.job = null;
    return true;
  }

  // ---------------------------------------------------------------- Streaming
  const center = { tx: 0, tz: 0 };
  const fill = (job, rec) => fillTile(rec || newRecord(), job.tx, job.tz, job.lod);

  /**
   * Kacheln um (x, z) nachführen. budget = max. Nahkacheln pro Aufruf (Infinity beim Start).
   * Rückgabe: Anzahl neu geschriebener Kacheln.
   */
  function update(x, z, budget = 2) {
    const ctx = Math.floor(x / TILE), ctz = Math.floor(z / TILE);
    center.tx = ctx;
    center.tz = ctz;
    const made = streamTiles(tiles, ctx, ctz, budget, fill);
    // Fern-Mesh: Unterdrückung nur unter fertigen Nahkacheln des aktuellen 5×5-Blocks, Neuaufbau bei Entfernung
    for (let dz = -NEAR; dz <= NEAR; dz++) {
      for (let dx = -NEAR; dx <= NEAR; dx++) farU.uCov.value[(dz + NEAR) * 5 + dx + NEAR] = tiles.has(tileKey(ctx + dx, ctz + dz)) ? 1 : 0;
    }
    // Veralteter Auftrag (z. B. Neustart/Sprung während des Aufbaus): verwerfen und neu zentrieren
    if (far.job && Math.hypot(x - far.job.cx, z - far.job.cz) > FAR_REBUILD) far.job = null;
    if (!far.job && (far.active < 0 || Math.hypot(x - far.cx, z - far.cz) > FAR_REBUILD)) startFar(x, z);
    if (far.job) {
      if (far.active < 0 || budget === Infinity) stepFar(Infinity);
      else stepFar(FAR_ROWS_PER_UPDATE);
    }
    const fm = far.active >= 0 ? farMeshes[far.active] : null;
    if (fm) {
      farU.uNearMin.value.set((ctx - NEAR) * TILE - fm.position.x, (ctz - NEAR) * TILE - fm.position.z);
      farU.uNearMax.value.set((ctx + NEAR + 1) * TILE - fm.position.x, (ctz + NEAR + 1) * TILE - fm.position.z);
    }
    return made;
  }

  /** Musterursprung (Vielfaches der Musterperiode) an die Kamera binden – float32-genaue Shader-Koordinaten. */
  function setCamera(cx, cz) {
    TU.uPatOrigin.value.set(Math.floor(cx / PAT_PERIOD) * PAT_PERIOD, Math.floor(cz / PAT_PERIOD) * PAT_PERIOD);
  }

  /** Liegt unter (x, z) eine fertige LOD-0-Kachel (und je 1 km rundum)? */
  function coverage(x, z) {
    for (const [dx, dz] of [[0, 0], [1000, 0], [-1000, 0], [0, 1000], [0, -1000]]) {
      const t = tiles.get(tileKey(Math.floor((x + dx) / TILE), Math.floor((z + dz) / TILE)));
      if (!t || t.lod !== 0) return false;
    }
    return true;
  }

  return {
    update,
    setCamera,
    coverage,
    tiles,
    get tileCount() {
      return tiles.size;
    },
    get generated() {
      return generated;
    },
    farMeshes,
    material: mat,
    farMaterial: farMat,
    uniforms: TU,
    patOrigin: TU.uPatOrigin.value,
  };
}
