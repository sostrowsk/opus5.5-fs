// Deterministisches Höhenfeld h(x, z) inkl. Flugplatz-Einebnung, Tal-Korridor, Seen und Oberflächentyp.
// Wird von Physik UND Grafik benutzt. Ohne three, ohne DOM.
//
// Physik/Grafik-Konsistenz: Die Physik sampelt NICHT analytisch, sondern baryzentrisch auf dem
// globalen 16-m-Dreiecksraster, auf dem auch die LOD-0-Kacheln liegen:
//   Vertex (i, j) liegt bei x = i·GRID, z = j·GRID, Höhe = vertexHeight(i, j).
//   Jedes Quad wird entlang der Diagonale (x0, z1) – (x1, z0) geteilt:
//     Dreieck A: (x0,z0) (x0,z1) (x1,z0)  für fx + fz ≤ 1
//     Dreieck B: (x1,z1) (x1,z0) (x0,z1)  für fx + fz > 1
//   terrain.js MUSS genau diese Triangulierung verwenden.
import { createNoise2D, fbm, ridged } from './noise.js';
import { smoothstep } from '../sim/math.js';

export const SEED = 172;
export const GRID = 16; // m, LOD-0-Rasterweite
export const WATER_LEVEL = 380; // m MSL, globaler Seespiegel
export const SNOW_LINE = 1800; // m MSL

/** Flugplatz „Talheim“ (fiktiv, XTAL). Piste 09/27 entlang der X-Achse. */
export const AIRPORT = {
  name: 'Talheim',
  ident: 'XTAL',
  elevation: 450, // m MSL (1476 ft)
  runway: { x0: -600, x1: 600, halfWidth: 15, length: 1200, width: 30 },
  // Plateau (exakt eben) und Überblendzone ins Gelände
  plateau: { halfX: 800, halfZ: 200, blend: 1200 },
  // Asphaltflächen als achsparallele Rechtecke [xMin, xMax, zMin, zMax] (−Z = Nord)
  asphalt: [
    [-600, 600, -15, 15], // Piste 09/27
    [-212, -188, -52, -15], // Rollweg (Verbindung Vorfeld – Piste)
    [-300, -100, -110, -52], // Vorfeld
  ],
};

// Tal-Korridor entlang der Pistenachse (Anflug frei von Hindernissen)
const CORRIDOR = { halfLen: 15000, fadeLen: 4000, core: 350, fade: 800 };

const nBase = createNoise2D(SEED);
const nDetail = createNoise2D(SEED + 1);
const nMask = createNoise2D(SEED + 2);
const nRidge = createNoise2D(SEED + 3);
const nFloor = createNoise2D(SEED + 4);

/** Natürliches Gelände ohne Flugplatz-Einflüsse. */
function naturalHeight(x, z) {
  const base = 452 + 215 * fbm(nBase, x / 7000, z / 7000, 5);
  const detail = 22 * fbm(nDetail, x / 900, z / 900, 3);
  // Gebirge: Grate nur dort, wo eine großräumige Maske es erlaubt; in Flugplatznähe abgeschwächt.
  const dAirport = Math.hypot(x, z * 1.6);
  let mask = smoothstep(-0.15, 0.35, fbm(nMask, x / 26000 + 3.1, z / 26000 - 1.7, 2));
  mask *= smoothstep(2500, 9000, dAirport);
  let mountain = 0;
  if (mask > 0) {
    const r = ridged(nRidge, x / 6500, z / 6500, 5);
    mountain = mask * Math.pow(r, 1.6) * 2000;
  }
  return base + detail + mountain;
}

/** Analytische Geländehöhe h(x, z) in m MSL (Grafik-Vertices werden damit berechnet). */
export function terrainHeight(x, z) {
  // Flugplatz-Plateau: innen exakt Platzhöhe
  const ap = AIRPORT.plateau;
  const dx = Math.max(0, Math.abs(x) - ap.halfX);
  const dz = Math.max(0, Math.abs(z) - ap.halfZ);
  const dRect = Math.hypot(dx, dz);
  if (dRect <= 0) return AIRPORT.elevation;

  let h = naturalHeight(x, z);

  // Tal-Korridor entlang der Pistenachse: Talboden ≈ Platzhöhe, Seen bleiben erhalten
  const wc =
    (1 - smoothstep(CORRIDOR.core, CORRIDOR.core + CORRIDOR.fade, Math.abs(z))) *
    (1 - smoothstep(CORRIDOR.halfLen, CORRIDOR.halfLen + CORRIDOR.fadeLen, Math.abs(x)));
  if (wc > 0) {
    const floor = AIRPORT.elevation - 4 + 6 * fbm(nFloor, x / 1800, z / 1800, 2);
    h += (Math.min(h, floor) - h) * wc;
  }

  // weiche Einebnung ums Plateau
  const wa = 1 - smoothstep(0, ap.blend, dRect);
  h += (AIRPORT.elevation - h) * wa;
  return h;
}

// ---------------------------------------------------------------- Raster (LOD 0)
// kleiner direkt adressierter Cache für Vertexhöhen (Physik fragt wiederholt dieselben Vertices ab)
const CACHE_SIZE = 1024;
const cacheI = new Int32Array(CACHE_SIZE).fill(0x7fffffff);
const cacheJ = new Int32Array(CACHE_SIZE);
const cacheH = new Float64Array(CACHE_SIZE);

/** Höhe des Rastervertex (i, j) bei x = i·GRID, z = j·GRID. */
export function vertexHeight(i, j) {
  // nur ganzzahlige Int32-Indizes cachen – NaN/Infinity würden als 0 abgelegt und den Cache vergiften
  if ((i | 0) !== i || (j | 0) !== j) return terrainHeight(i * GRID, j * GRID);
  const k = ((i * 73856093) ^ (j * 19349663)) & (CACHE_SIZE - 1);
  if (cacheI[k] === i && cacheJ[k] === j) return cacheH[k];
  const h = terrainHeight(i * GRID, j * GRID);
  cacheI[k] = i;
  cacheJ[k] = j;
  cacheH[k] = h;
  return h;
}

/**
 * Bodenhöhe und -normale auf dem LOD-0-Dreiecksraster (identisch zum gerenderten Mesh).
 * out = { h, nx, ny, nz } (Normale in Three-Weltkoordinaten, Y oben).
 */
export function groundSample(x, z, out = { h: 0, nx: 0, ny: 1, nz: 0 }) {
  const gx = x / GRID;
  const gz = z / GRID;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const fx = gx - i;
  const fz = gz - j;
  let dhdx, dhdz;
  if (fx + fz <= 1) {
    const h00 = vertexHeight(i, j);
    const h10 = vertexHeight(i + 1, j);
    const h01 = vertexHeight(i, j + 1);
    dhdx = h10 - h00;
    dhdz = h01 - h00;
    out.h = h00 + dhdx * fx + dhdz * fz;
  } else {
    const h11 = vertexHeight(i + 1, j + 1);
    const h10 = vertexHeight(i + 1, j);
    const h01 = vertexHeight(i, j + 1);
    dhdx = h11 - h01;
    dhdz = h11 - h10;
    out.h = h11 - dhdx * (1 - fx) - dhdz * (1 - fz);
  }
  dhdx /= GRID;
  dhdz /= GRID;
  const l = Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
  out.nx = -dhdx / l;
  out.ny = 1 / l;
  out.nz = -dhdz / l;
  return out;
}

const tmp = { h: 0, nx: 0, ny: 1, nz: 0 };
/** Bodenhöhe (m MSL) auf dem LOD-0-Raster – dieselbe Fläche, die gerendert wird. */
export function groundHeight(x, z) {
  return groundSample(x, z, tmp).h;
}

/** Liegt (x, z) auf einer Asphaltfläche des Flugplatzes? */
export function isAsphalt(x, z) {
  for (const r of AIRPORT.asphalt) {
    if (x >= r[0] && x <= r[1] && z >= r[2] && z <= r[3]) return true;
  }
  return false;
}
/** Liegt (x, z) auf der Piste? */
export function isRunway(x, z) {
  const r = AIRPORT.runway;
  return x >= r.x0 && x <= r.x1 && Math.abs(z) <= r.halfWidth;
}

/** Oberflächentyp: 'asphalt' | 'grass' | 'water'. */
export function surface(x, z) {
  if (isAsphalt(x, z)) return 'asphalt';
  if (groundHeight(x, z) < WATER_LEVEL) return 'water';
  return 'grass';
}

/** Standard-Bodenanbieter für die Physik. */
export const worldGround = {
  sample: groundSample,
  height: groundHeight,
  surface,
  waterLevel: WATER_LEVEL,
};

/** Hilfsfunktion (Tests/Welt): ebener Boden in fester Höhe. */
export function flatGround(elev = 0, type = 'grass', waterLevel = -1e9) {
  return {
    sample: (x, z, out = { h: 0, nx: 0, ny: 1, nz: 0 }) => {
      out.h = elev;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      return out;
    },
    height: () => elev,
    surface: () => type,
    waterLevel,
  };
}
