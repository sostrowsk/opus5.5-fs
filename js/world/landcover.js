// Landbedeckung pro Ort (ohne three, ohne DOM): Wald, Feldeignung, großräumige Variation, gemähtes Flugplatzgras.
// Terrain (Vertex-Attribut „cover“ → Terrain-Shader) und Vegetation (Baumdichte) nutzen dieselbe Funktion, damit
// Bäume genau dort stehen, wo der Boden nach Wald aussieht.
import { createNoise2D, fbm } from './noise.js';
import { WATER_LEVEL, AIRPORT } from './heightfield.js';
import { clamp, smoothstep } from '../sim/math.js';

export const TREE_LINE = 1750; // m MSL
const nForest = createNoise2D(901);
const nVar = createNoise2D(902);

/** Abstand (m) zum Flugplatz-Plateau-Rechteck (0 innerhalb). */
export function airportDistance(x, z) {
  const ap = AIRPORT.plateau;
  return Math.hypot(Math.max(Math.abs(x) - ap.halfX, 0), Math.max(Math.abs(z) - ap.halfZ, 0));
}

/**
 * Hindernisfreiheit 0..1 (0 = keine Bäume): Flugplatz samt Umgebung und die Anflugschneisen
 * (verlängerte Pistenachse, trichterförmig bis 2,6 km).
 */
export function clearance(x, z, dAp = airportDistance(x, z)) {
  let c = smoothstep(250, 420, dAp);
  const ax = Math.abs(x);
  if (ax < 2600) c *= smoothstep(60, 160, Math.abs(z) - Math.max(0, (ax - 600) * 0.12));
  return c;
}

/**
 * Landbedeckung an (x, z) mit Höhe h (m MSL) und Normalen-Y ny.
 * out = [forest 0..1, field 0..1, variation 0..1, mowed 0..1]
 */
export function landcover(x, z, h, ny, out = [0, 0, 0, 0]) {
  const v = fbm(nVar, x / 1500, z / 1500, 2); // −1..1
  const dAp = airportDistance(x, z);
  // Wald: großräumige Maske, auf Hängen und in höheren Lagen häufiger
  const fm = fbm(nForest, x / 1700, z / 1700, 3) + 0.22 * v + (h > 600 ? 0.12 : 0) + (1 - ny) * 1.5;
  let forest = smoothstep(0.16, 0.3, fm);
  forest *= clearance(x, z, dAp);
  forest *= 1 - smoothstep(TREE_LINE - 150, TREE_LINE, h); // Baumgrenze
  forest *= smoothstep(0.72, 0.8, ny); // Fels an Steilhängen
  forest *= smoothstep(WATER_LEVEL + 1, WATER_LEVEL + 4, h); // Ufer
  // Felder: flach, tief gelegen, nicht im Wald, nicht auf dem Flugplatz
  let field = smoothstep(0.975, 0.99, ny) * (1 - smoothstep(700, 780, h)) * smoothstep(30, 90, dAp);
  field *= smoothstep(WATER_LEVEL + 3, WATER_LEVEL + 8, h) * (1 - forest);
  out[0] = clamp(forest, 0, 1);
  out[1] = clamp(field, 0, 1);
  out[2] = clamp(0.5 + 0.5 * v, 0, 1);
  out[3] = 1 - smoothstep(0, 70, dAp);
  return out;
}
