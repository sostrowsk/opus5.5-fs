// Heightfield: Determinismus, ebene Piste, Raster-Konsistenz Physik ↔ gerenderte LOD-0-Kachel (AK-20, Heightfield-Seite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoise2D, fbm } from '../js/world/noise.js';
import {
  GRID, WATER_LEVEL, SNOW_LINE, AIRPORT, terrainHeight, vertexHeight, groundHeight, groundSample, surface, isRunway,
} from '../js/world/heightfield.js';
import { mulberry32 } from '../js/sim/math.js';

const TILE = 1024; // m – Nahkachel (terrain.js)
const SEG = TILE / GRID; // 64 Segmente LOD 0

test('Noise ist deterministisch und seed-abhängig', () => {
  const a = createNoise2D(7), b = createNoise2D(7), c = createNoise2D(8);
  let diff = 0;
  for (let i = 0; i < 200; i++) {
    const x = i * 0.137 - 9, y = i * 0.071 + 3;
    assert.equal(a(x, y), b(x, y));
    diff += Math.abs(a(x, y) - c(x, y));
    const v = fbm(a, x, y, 5);
    assert.ok(v >= -1.0001 && v <= 1.0001, `fbm außerhalb [-1,1]: ${v}`);
  }
  assert.ok(diff > 1, 'anderer Seed muss andere Werte liefern');
});

test('Höhenfeld ist deterministisch (zweimal gleich, feste Stichproben)', () => {
  const pts = [[1234.5, -987.1], [-25000, 18000], [60000, 60000], [5, 5], [-150000, 3]];
  const first = pts.map(([x, z]) => terrainHeight(x, z));
  const second = pts.map(([x, z]) => terrainHeight(x, z));
  assert.deepEqual(first, second);
  for (const h of first) assert.ok(Number.isFinite(h) && h > 0 && h < 4000, `unplausible Höhe ${h}`);
});

test('Piste und Plateau sind exakt eben auf Platzhöhe (analytisch und auf dem Raster)', () => {
  const r = AIRPORT.runway;
  for (let x = r.x0; x <= r.x1; x += 7.3) {
    for (let z = -r.halfWidth; z <= r.halfWidth; z += 2.9) {
      assert.equal(terrainHeight(x, z), AIRPORT.elevation);
      assert.equal(groundHeight(x, z), AIRPORT.elevation, `groundHeight(${x}, ${z})`);
      const g = groundSample(x, z);
      assert.equal(g.ny, 1);
      assert.ok(isRunway(x, z));
      assert.equal(surface(x, z), 'asphalt');
    }
  }
  // Plateau-Rand: weicher Übergang ohne Sprung
  const inside = terrainHeight(799.99, 0), outside = terrainHeight(800.5, 0);
  assert.equal(inside, AIRPORT.elevation);
  assert.ok(Math.abs(outside - inside) < 0.01, `Sprung am Plateaurand: ${outside - inside}`);
});

test('groundHeight: Vertices = h(x,z), Dreiecke gemäß festgelegter Diagonale (x0,z1)–(x1,z0)', () => {
  const rng = mulberry32(99);
  for (let n = 0; n < 500; n++) {
    const x = (rng() - 0.5) * 60000, z = (rng() - 0.5) * 60000;
    const i = Math.floor(x / GRID), j = Math.floor(z / GRID);
    assert.equal(vertexHeight(i, j), terrainHeight(i * GRID, j * GRID));
    assert.equal(groundHeight(i * GRID, j * GRID), terrainHeight(i * GRID, j * GRID));
    // unabhängige Referenz: baryzentrisch im jeweiligen Dreieck
    const fx = x / GRID - i, fz = z / GRID - j;
    const h00 = terrainHeight(i * GRID, j * GRID), h10 = terrainHeight((i + 1) * GRID, j * GRID);
    const h01 = terrainHeight(i * GRID, (j + 1) * GRID), h11 = terrainHeight((i + 1) * GRID, (j + 1) * GRID);
    const ref = fx + fz <= 1
      ? h00 * (1 - fx - fz) + h10 * fx + h01 * fz
      : h11 * (fx + fz - 1) + h01 * (1 - fx) + h10 * (1 - fz);
    assert.ok(Math.abs(groundHeight(x, z) - ref) < 1e-6, `(${x},${z}) ${groundHeight(x, z)} vs ${ref}`);
  }
});

test('groundHeight ist stetig über Zellen- und Kachelgrenzen', () => {
  for (const x0 of [0, 1024, -2048, 5120, 30720]) {
    for (const z0 of [0, 1024, -3072, 4096]) {
      for (const d of [[1, 0], [0, 1], [1, 1]]) {
        const a = groundHeight(x0 - d[0] * 1e-7, z0 - d[1] * 1e-7);
        const b = groundHeight(x0 + d[0] * 1e-7, z0 + d[1] * 1e-7);
        assert.ok(Math.abs(a - b) < 1e-4, `Sprung bei (${x0},${z0}): ${a} vs ${b}`);
      }
    }
  }
});

// ------------------------------------------------------------------ AK-20 (Heightfield-Seite)
// Nachbau der LOD-0-Kachel wie terrain.js sie rendert: kachel-lokale float32-Vertices,
// Dreiecke A (00,01,10) und B (11,10,01). Raycast senkrecht von oben gegen die Dreiecke.
function buildTile(tx, tz) {
  const ox = tx * TILE, oz = tz * TILE;
  const pos = new Float32Array((SEG + 1) * (SEG + 1) * 3);
  for (let j = 0; j <= SEG; j++) {
    for (let i = 0; i <= SEG; i++) {
      const k = (j * (SEG + 1) + i) * 3;
      pos[k] = i * GRID;
      pos[k + 1] = vertexHeight(tx * SEG + i, tz * SEG + j);
      pos[k + 2] = j * GRID;
    }
  }
  const idx = [];
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * (SEG + 1) + i, b = a + 1, c = a + SEG + 1, d = c + 1; // a=00 b=10 c=01 d=11
      idx.push(a, c, b, d, b, c);
    }
  }
  return { ox, oz, pos, idx };
}
function raycastDown(tile, x, z) {
  // Strahl in kachel-lokalen Koordinaten (wie Three: Objekt-Matrix = Translation um den Kachelursprung)
  const lx = x - tile.ox, lz = z - tile.oz;
  const o = [lx, 10000, lz], dir = [0, -1, 0];
  const p = tile.pos;
  let best = null;
  const i = Math.min(SEG - 1, Math.max(0, Math.floor(lx / GRID)));
  const j = Math.min(SEG - 1, Math.max(0, Math.floor(lz / GRID)));
  // nur die Dreiecke der Zelle und ihrer Nachbarn testen (Grenzfälle)
  for (let jj = Math.max(0, j - 1); jj <= Math.min(SEG - 1, j + 1); jj++) {
    for (let ii = Math.max(0, i - 1); ii <= Math.min(SEG - 1, i + 1); ii++) {
      const base = (jj * SEG + ii) * 6;
      for (let t = 0; t < 2; t++) {
        const [ia, ib, ic] = tile.idx.slice(base + t * 3, base + t * 3 + 3);
        const A = [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]];
        const B = [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]];
        const C = [p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]];
        const hit = mollerTrumbore(o, dir, A, B, C);
        if (hit !== null && (best === null || hit < best)) best = hit;
      }
    }
  }
  return best === null ? null : o[1] - best;
}
function mollerTrumbore(o, d, A, B, C) {
  const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tv = [o[0] - A[0], o[1] - A[1], o[2] - A[2]];
  const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
  const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
}

test('AK-20: groundHeight ≈ Raycast gegen die LOD-0-Kachel (≤ 0,05 m; Piste ≤ 0,01 m), auch an Kachelgrenzen', () => {
  const rng = mulberry32(2020);
  const tiles = new Map();
  const tileAt = (x, z) => {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    const key = `${tx},${tz}`;
    if (!tiles.has(key)) tiles.set(key, buildTile(tx, tz));
    return tiles.get(key);
  };
  // Flugzeugpositionen: am Platz, vor und nach einem Kachelwechsel, weit draußen (float32-Präzision)
  const centers = [[0, 0], [1023.5, 10], [1024.5, 10], [-40960, 51200.2], [150000.7, -99999.3]];
  let maxErr = 0;
  for (const [cx, cz] of centers) {
    const pts = [];
    for (let n = 0; n < 100; n++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 1000;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    // gezielt auf Kachelgrenzen
    const bx = Math.round(cx / TILE) * TILE, bz = Math.round(cz / TILE) * TILE;
    for (let k = -5; k <= 5; k++) pts.push([bx, cz + k * 37.3], [cx + k * 41.7, bz], [bx, bz + k * 16]);
    for (const [x, z] of pts) {
      const hRay = raycastDown(tileAt(x, z), x, z);
      assert.notEqual(hRay, null, `kein Treffer bei (${x}, ${z})`);
      const err = Math.abs(hRay - groundHeight(x, z));
      maxErr = Math.max(maxErr, err);
      assert.ok(err <= 0.05, `Abweichung ${err.toFixed(4)} m bei (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  // Piste
  const r = AIRPORT.runway;
  for (let n = 0; n < 100; n++) {
    const x = r.x0 + rng() * r.length, z = (rng() - 0.5) * r.width;
    const err = Math.abs(raycastDown(tileAt(x, z), x, z) - groundHeight(x, z));
    assert.ok(err <= 0.01, `Piste: Abweichung ${err} m bei (${x}, ${z})`);
  }
  assert.ok(maxErr < 0.05);
});

test('Welt: Seen unter dem Wasserspiegel, Berge über der Schneegrenze, Oberflächentyp konsistent', () => {
  let water = 0, snow = 0, n = 0;
  for (let x = -40000; x <= 40000; x += 400) {
    for (let z = -40000; z <= 40000; z += 400) {
      n++;
      const h = groundHeight(x, z);
      const s = surface(x, z);
      if (s === 'water') {
        water++;
        assert.ok(h < WATER_LEVEL);
      } else if (s === 'grass') assert.ok(h >= WATER_LEVEL);
      if (h > SNOW_LINE) snow++;
    }
  }
  assert.ok(water / n > 0.01, `zu wenig Seen: ${(100 * water / n).toFixed(2)} %`);
  assert.ok(snow > 0, 'keine Berge über der Schneegrenze');
});

test('Anflug 27: Tal-Korridor bis 3 NM östlich ohne Hindernisse über Platzhöhe', () => {
  for (let x = 600; x <= 600 + 3 * 1852 + 1000; x += 25) {
    for (const z of [-150, 0, 150]) {
      const h = groundHeight(x, z);
      assert.ok(h <= AIRPORT.elevation + 5, `Hindernis bei x=${x}, z=${z}: ${h.toFixed(1)} m`);
    }
  }
});
