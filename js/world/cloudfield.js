// Wolkenfeld (ohne three, ohne DOM): deterministische Cumulus-Wolken in 2-km-Zellen nach Zell-Hash und
// Bedeckungsgrad, mit dem Wind treibend. Liefert die Wolken samt Puffs für die Darstellung (clouds.js) und
// cloudDensityAt() für Sicht in der Wolke (Fog), Turbulenz und Wolkenschatten.
import { createNoise2D, fbm } from './noise.js';
import { terrainHeight } from './heightfield.js';
import { clamp, smoothstep } from '../sim/math.js';

export const CELL = 2000; // m

function hash3(i, j, k) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wolkenfeld. setParams(coverage 0..1, base m MSL); advance(dt, windX, windZ) verschiebt das Feld mit dem Wind.
 * Eine Wolke: { x, z (Welt, inkl. Drift), fx, fz (im Feld), base, top, rx, rz, puffs: [{ ox, oy, oz, r, v }] }
 * (Puff-Offsets relativ zur Wolkenmitte am Boden der Wolke, r = Radius, v = Variante 0..3).
 */
export function createCloudField(seed = 4242) {
  const nCov = createNoise2D(seed);
  const cache = new Map();
  const field = { coverage: 0, base: 1200, driftX: 0, driftZ: 0, version: 0 };

  function setParams(coverage, base) {
    coverage = clamp(coverage, 0, 1);
    if (coverage !== field.coverage || base !== field.base) {
      field.coverage = coverage;
      field.base = base;
      field.version++;
      cache.clear();
    }
  }
  function advance(dt, wx, wz) {
    field.driftX += wx * dt;
    field.driftZ += wz * dt;
  }

  /** Wolken einer Zelle (Feldkoordinaten, ohne Drift). */
  function cell(ci, cj) {
    const key = ci + ',' + cj;
    let list = cache.get(key);
    if (list) return list;
    list = [];
    const c = field.coverage;
    if (c > 0) {
      // großräumige Modulation: Wolkenstraßen/Lücken
      const m = fbm(nCov, (ci + 0.5) * CELL / 16000, (cj + 0.5) * CELL / 16000, 2);
      const local = clamp(c + 0.22 * m * (1 - c), 0, 1);
      const n = Math.floor(local * 3.2 + hash3(ci, cj, seed));
      const r = rng(Math.imul(ci, 73856093) ^ Math.imul(cj, 19349663) ^ seed);
      for (let k = 0; k < n; k++) {
        const size = 0.7 + 0.6 * local;
        const rx = (330 + 520 * r()) * size;
        const rz = rx * (0.65 + 0.6 * r());
        const thick = (220 + 520 * r()) * (0.55 + 0.9 * local);
        const fx = (ci + 0.1 + 0.8 * r()) * CELL;
        const fz = (cj + 0.1 + 0.8 * r()) * CELL;
        const base = field.base + (r() - 0.5) * 120;
        const cl = { fx, fz, x: 0, z: 0, base, top: base + thick, rx, rz, puffs: [], seed: r() };
        // Puffs: großer Kern, Türme in der Mitte, flache Randpuffs
        const np = Math.round(8 + 10 * Math.min(1, (rx * rz) / 700000));
        for (let p = 0; p < np; p++) {
          const a = r() * Math.PI * 2;
          const d = p === 0 ? 0 : Math.sqrt(r()) * 0.78;
          const ox = Math.cos(a) * d * rx, oz = Math.sin(a) * d * rz;
          const tower = 1 - d * d;
          const pr = (0.3 + 0.28 * r()) * Math.min(rx, rz) * (0.75 + 0.45 * tower);
          const oy = pr * 0.55 + (thick - pr) * tower * (0.35 + 0.55 * r());
          cl.puffs.push({ ox, oy: Math.max(pr * 0.5, oy), oz, r: pr, v: Math.floor(r() * 4) });
        }
        cl.puffs.sort((p, q) => q.r - p.r); // größte zuerst (LOD: ferne Wolken zeigen nur die ersten)
        list.push(cl);
      }
    }
    if (cache.size > 3000) cache.clear();
    cache.set(key, list);
    return list;
  }

  /** Wolken, deren Mitte im Umkreis radius um (x, z) liegt (Weltkoordinaten, Drift eingerechnet). */
  function cloudsNear(x, z, radius, out = []) {
    out.length = 0;
    if (field.coverage <= 0) return out;
    const fx = x - field.driftX, fz = z - field.driftZ;
    const r = radius + CELL;
    const i0 = Math.floor((fx - r) / CELL), i1 = Math.floor((fx + r) / CELL);
    const j0 = Math.floor((fz - r) / CELL), j1 = Math.floor((fz + r) / CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const cl of cell(i, j)) {
          const dx = cl.fx - fx, dz = cl.fz - fz;
          if (dx * dx + dz * dz > radius * radius) continue;
          cl.x = cl.fx + field.driftX;
          cl.z = cl.fz + field.driftZ;
          if (terrainHeight(cl.x, cl.z) > cl.base - 60) continue; // Wolke stünde im Berg
          out.push(cl);
        }
      }
    }
    return out;
  }

  const near = [];
  /** Wolkendichte 0..1 am Weltpunkt (x, y, z): 1 im Kern, weich zum Rand (Ellipsoid je Wolke). */
  function densityAt(x, y, z) {
    if (field.coverage <= 0) return 0;
    cloudsNear(x, z, 2200, near);
    let d = 0;
    for (const cl of near) {
      if (y < cl.base - 30 || y > cl.top + 60) continue;
      const cy = cl.base + (cl.top - cl.base) * 0.45, ry = (cl.top - cl.base) * 0.55 + 30;
      const u = (x - cl.x) / cl.rx, v = (y - cy) / ry, w = (z - cl.z) / cl.rz;
      const e = Math.sqrt(u * u + v * v + w * w);
      d = Math.max(d, 1 - smoothstep(0.55, 1.0, e));
    }
    return d;
  }

  return { field, setParams, advance, cloudsNear, densityAt, cell };
}
