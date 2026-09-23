// Vegetation: Nadel- und Laubbäume (Low-Poly) als je ein InstancedMesh, nur auf den Nahkacheln (5 × 5 → ≈ 2,5 km).
// Verteilung nach derselben Landbedeckung wie der Terrain-Shader (landcover.js, Vertex-Attribut „cover“): dichte
// Wälder, einzelne Bäume auf Wiesen; nie auf Asphalt, Wasser, Fels oder dem gemähten Flugplatzgras.
// Positionen folgen einem globalen, gehashten 18-m-Raster (gleiche Bäume unabhängig vom Kachel-LOD); die Höhe wird
// baryzentrisch auf dem Dreiecksraster der Kachel bestimmt, auf dem die Bäume sichtbar stehen.
// Pro Kachel werden die Bäume in einen Slot geschrieben; die sichtbaren Instanzen werden danach kompakt
// zusammenkopiert (keine leeren Instanzen im Draw Call).
import * as THREE from 'three';
import { WATER_LEVEL, isAsphalt } from './heightfield.js';
import { patchHaze, CLOUD_SHADOW, CLOUD_SHADOW_GLSL } from './sky.js';
import { clearance } from './landcover.js';

const CELL = 18; // m
const SLOT_CAP = 2600; // Bäume je Art und Kachel
const SLOTS = 25;

function hash(i, j, s) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ Baum-Geometrien (Höhe 1, Fuß bei y = 0)
function builder() {
  const P = [], N = [], Cl = [];
  return {
    tri(a, b, c, na, nb, nc, ca, cb, cc) {
      P.push(...a, ...b, ...c);
      N.push(...na, ...nb, ...nc);
      Cl.push(...ca, ...cb, ...cc);
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(Cl, 3));
      g.computeBoundingSphere();
      return g;
    },
  };
}
const lin = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

function addTrunk(b, r, h, sides, col) {
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, 0, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, 0, Math.sin(a1) * r];
    const q0 = [p0[0] * 0.7, h, p0[2] * 0.7], q1 = [p1[0] * 0.7, h, p1[2] * 0.7];
    const n0 = [Math.cos(a0), 0, Math.sin(a0)], n1 = [Math.cos(a1), 0, Math.sin(a1)];
    b.tri(p0, q0, p1, n0, n0, n1, col, col, col);
    b.tri(p1, q0, q1, n1, n0, n1, col, col, col);
  }
}

function coniferGeometry() {
  const b = builder();
  addTrunk(b, 0.035, 0.22, 5, lin(0x4a3524));
  const green = lin(0x30552f), tip = lin(0x44693a);
  const tiers = [[0.12, 0.46, 0.27], [0.34, 0.4, 0.21], [0.55, 0.45, 0.14]];
  const S = 7;
  for (let t = 0; t < tiers.length; t++) {
    const [y0, h, r] = tiers[t];
    const cBase = scale3(green, 0.62 + 0.14 * t), cTop = scale3(tip, 0.85 + 0.1 * t);
    const slope = r / h;
    for (let k = 0; k < S; k++) {
      const a0 = ((k + t * 0.5) / S) * Math.PI * 2, a1 = ((k + 1 + t * 0.5) / S) * Math.PI * 2, am = (a0 + a1) / 2;
      const p0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
      const apex = [0, y0 + h, 0];
      const nn = (a) => {
        const v = [Math.cos(a), slope + 0.35, Math.sin(a)];
        const l = Math.hypot(...v);
        return [v[0] / l, v[1] / l, v[2] / l];
      };
      b.tri(p0, apex, p1, nn(a0), nn(am), nn(a1), cBase, cTop, cBase);
      // Unterseite der Etage (dunkel, schließt die Silhouette von unten)
      b.tri(p1, [0, y0 + 0.06, 0], p0, [0, -1, 0], [0, -1, 0], [0, -1, 0], scale3(cBase, 0.5), scale3(cBase, 0.5), scale3(cBase, 0.5));
    }
  }
  return b.geometry();
}

function deciduousGeometry() {
  const b = builder();
  addTrunk(b, 0.05, 0.42, 5, lin(0x55402c));
  const ico = new THREE.IcosahedronGeometry(1, 1); // bereits nicht indiziert
  const p = ico.attributes.position;
  const leaf = lin(0x477530), leafHi = lin(0x65913c);
  const lump = (x, y, z) => 0.82 + 0.3 * hash(Math.round(x * 97), Math.round(y * 89), Math.round(z * 83));
  const v = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = lump(x, y, z);
    v.push([x * k * 0.4, 0.62 + y * k * 0.34, z * k * 0.4, x, y, z]);
  }
  for (let i = 0; i < v.length; i += 3) {
    const tri = [v[i], v[i + 1], v[i + 2]];
    const pos = tri.map((q) => [q[0], q[1], q[2]]);
    const nrm = tri.map((q) => {
      const l = Math.hypot(q[3], q[4], q[5]) || 1;
      return [q[3] / l, q[4] / l, q[5] / l];
    });
    const col = tri.map((q) => {
      const up = (q[4] + 1) / 2; // unten dunkler (Eigenschatten)
      return [leaf[0] + (leafHi[0] - leaf[0]) * up, leaf[1] + (leafHi[1] - leaf[1]) * up, leaf[2] + (leafHi[2] - leaf[2]) * up].map((c) => c * (0.55 + 0.45 * up));
    });
    b.tri(pos[0], pos[1], pos[2], nrm[0], nrm[1], nrm[2], col[0], col[1], col[2]);
  }
  ico.dispose();
  return b.geometry();
}

export function createVegetation(scene) {
  // Lambert + Wolkenschatten (dieselbe Projektion wie am Boden) + Dunst
  const lam = new THREE.MeshLambertMaterial({ vertexColors: true });
  lam.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, CLOUD_SHADOW);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CLOUD_SHADOW_GLSL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= cloudShadow(vHazeWorld);');
  };
  lam.customProgramCacheKey = () => 'vegetation';
  const mat = patchHaze(lam); // deklariert vHazeWorld (Weltposition inkl. Instanzmatrix)
  const kinds = [coniferGeometry(), deciduousGeometry()].map((g, k) => {
    const m = new THREE.InstancedMesh(g, mat, SLOTS * SLOT_CAP);
    m.name = k === 0 ? 'conifers' : 'broadleaf';
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * SLOT_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    scene.add(m);
    return {
      mesh: m,
      // je Slot: Matrizen (16) + Farbe (3) + Anzahl
      mats: Array.from({ length: SLOTS }, () => new Float32Array(SLOT_CAP * 16)),
      cols: Array.from({ length: SLOTS }, () => new Float32Array(SLOT_CAP * 3)),
      count: new Int32Array(SLOTS),
    };
  });
  let dirty = false;
  let stride = 1; // Qualität „Niedrig“: nur jeder zweite Baum
  const stats = { trees: 0, conifers: 0, broadleaf: 0 };

  /** Bäume einer Kachel erzeugen (Hook aus terrain.js nach jedem fillTile). */
  function fillTile(rec, d) {
    const slot = rec.slot;
    if (slot >= SLOTS) return;
    for (const k of kinds) k.count[slot] = 0;
    const { H, HW, seg, step, cover, x0, z0 } = d;
    const W = seg + 1;
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor((x0 + seg * step - 0.01) / CELL);
    const j0 = Math.floor(z0 / CELL), j1 = Math.floor((z0 + seg * step - 0.01) / CELL);
    for (let cj = j0; cj <= j1; cj++) {
      for (let ci = i0; ci <= i1; ci++) {
        const x = (ci + 0.1 + 0.8 * hash(ci, cj, 1)) * CELL, z = (cj + 0.1 + 0.8 * hash(ci, cj, 2)) * CELL;
        const gx = (x - x0) / step, gz = (z - z0) / step;
        if (gx < 0 || gz < 0 || gx >= seg || gz >= seg) continue;
        const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
        // Landbedeckung bilinear aus den Vertexwerten
        const c00 = (j * W + i) * 4, c10 = c00 + 4, c01 = c00 + W * 4, c11 = c01 + 4;
        const bil = (o) =>
          (cover[c00 + o] * (1 - fx) + cover[c10 + o] * fx) * (1 - fz) + (cover[c01 + o] * (1 - fx) + cover[c11 + o] * fx) * fz;
        const forest = bil(0), field = bil(1), mowed = bil(3);
        const r = hash(ci, cj, 3);
        const single = mowed < 0.02 && field < 0.3 ? 0.012 : 0;
        if (r >= forest * 0.78 + single) continue;
        if (forest < 0.05 && clearance(x, z) < 1) continue; // Einzelbäume nicht am Platz / im Anflug
        const far = seg < 64; // LOD-1-Ring (≥ 1 km): halbe Dichte, etwas größere Bäume
        if (far && hash(ci, cj, 11) < 0.5) continue;
        // Höhe auf dem Dreiecksraster der Kachel (Diagonale (x0,z1)–(x1,z0))
        const h00 = H[(j + 1) * HW + i + 1], h10 = H[(j + 1) * HW + i + 2];
        const h01 = H[(j + 2) * HW + i + 1], h11 = H[(j + 2) * HW + i + 2];
        const h = fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 - (h11 - h01) * (1 - fx) - (h11 - h10) * (1 - fz);
        if (h < WATER_LEVEL + 1.5) continue;
        if (isAsphalt(x, z)) continue;
        const slope = Math.max(Math.abs(h10 - h00), Math.abs(h01 - h00), Math.abs(h11 - h10), Math.abs(h11 - h01)) / step;
        if (slope > 0.75) continue;
        const r2 = hash(ci, cj, 4);
        const coniferP = Math.min(0.92, 0.18 + Math.max(0, (h - 520) / 700) + (forest > 0.5 ? 0.15 : 0));
        const kind = r2 < coniferP ? 0 : 1;
        const K = kinds[kind];
        const n = K.count[slot];
        if (n >= SLOT_CAP) continue;
        const r3 = hash(ci, cj, 5);
        const isSingle = forest < 0.3;
        const ht = (kind === 0 ? 14 + 14 * r3 : 11 + 10 * r3 + (isSingle ? 3 : 0)) * (far ? 1.12 : 1);
        const wd = ht * (kind === 0 ? 0.85 + 0.3 * hash(ci, cj, 6) : 1.0 + 0.45 * hash(ci, cj, 6) + (isSingle ? 0.25 : 0));
        const a = hash(ci, cj, 7) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const M = K.mats[slot], o = n * 16;
        M[o] = ca * wd;
        M[o + 1] = 0;
        M[o + 2] = -sa * wd;
        M[o + 3] = 0;
        M[o + 4] = 0;
        M[o + 5] = ht;
        M[o + 6] = 0;
        M[o + 7] = 0;
        M[o + 8] = sa * wd;
        M[o + 9] = 0;
        M[o + 10] = ca * wd;
        M[o + 11] = 0;
        M[o + 12] = x;
        M[o + 13] = h - 0.4;
        M[o + 14] = z;
        M[o + 15] = 1;
        const t = hash(ci, cj, 8);
        const Cc = K.cols[slot], oc = n * 3;
        const br = 0.78 + 0.4 * t;
        Cc[oc] = br * (0.95 + 0.15 * hash(ci, cj, 9));
        Cc[oc + 1] = br;
        Cc[oc + 2] = br * (0.85 + 0.2 * hash(ci, cj, 10));
        K.count[slot] = n + 1;
      }
    }
    dirty = true;
  }

  /** Sichtbare Slots kompakt in die Instanzpuffer kopieren (nach den Kachel-Updates eines Frames). */
  function commit() {
    if (!dirty) return;
    dirty = false;
    stats.trees = 0;
    kinds.forEach((K, kind) => {
      const im = K.mesh.instanceMatrix.array, ic = K.mesh.instanceColor.array;
      let n = 0;
      for (let s = 0; s < SLOTS; s++) {
        const c = K.count[s];
        if (!c) continue;
        if (stride === 1) {
          im.set(K.mats[s].subarray(0, c * 16), n * 16);
          ic.set(K.cols[s].subarray(0, c * 3), n * 3);
          n += c;
        } else {
          for (let i = 0; i < c; i += stride, n++) {
            im.set(K.mats[s].subarray(i * 16, i * 16 + 16), n * 16);
            ic.set(K.cols[s].subarray(i * 3, i * 3 + 3), n * 3);
          }
        }
      }
      K.mesh.count = n;
      K.mesh.instanceMatrix.clearUpdateRanges();
      K.mesh.instanceMatrix.addUpdateRange(0, Math.max(n, 1) * 16);
      K.mesh.instanceMatrix.needsUpdate = true;
      K.mesh.instanceColor.clearUpdateRanges();
      K.mesh.instanceColor.addUpdateRange(0, Math.max(n, 1) * 3);
      K.mesh.instanceColor.needsUpdate = true;
      K.mesh.visible = n > 0;
      stats.trees += n;
      if (kind === 0) stats.conifers = n;
      else stats.broadleaf = n;
    });
  }

  /** Baumdichte je Grafikqualität (1 = voll, 0.5 = jeder zweite Baum); wirkt beim nächsten commit(). */
  function setDensity(d) {
    const st = d >= 0.99 ? 1 : 2;
    if (st === stride) return;
    stride = st;
    dirty = true;
  }

  return { fillTile, commit, setDensity, stats, meshes: kinds.map((k) => k.mesh), material: mat };
}
