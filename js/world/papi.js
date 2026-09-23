// PAPI-Anlagen für Piste 09 und 27 (ohne three, ohne DOM): Lage der vier Lampeneinheiten je Pistenrichtung,
// Schaltwinkel und die Anzeige für einen Betrachter. Der Licht-Shader in airport.js rechnet pro Lampe genauso.
import { AIRPORT } from './heightfield.js';

/** Schaltwinkel (°) von der Piste nach außen: auf dem 3°-Gleitpfad → 2 weiß (außen), 2 rot (innen). */
export const PAPI_ANGLES = [3.5, 3.1667, 2.8333, 2.5];
const DIST_FROM_THRESHOLD = 260; // m (≈ Zielpunkt)

/**
 * Einheiten je Pistenrichtung, von innen (pistennah) nach außen:
 * 27: Anflug von Osten, links (Süden, +Z); 09: Anflug von Westen, links (Norden, −Z).
 * { x, y (Lampenhöhe), z, angle, facing (+1 = strahlt nach Osten, −1 = nach Westen) }
 */
export function papiUnits() {
  const r = AIRPORT.runway, y = AIRPORT.elevation + 0.8;
  const row = (x, side, facing) => PAPI_ANGLES.map((angle, k) => ({ x, y, z: side * (r.halfWidth + 15 + 9 * k), angle, facing }));
  return { 27: row(r.x1 - DIST_FROM_THRESHOLD, 1, 1), '09': row(r.x0 + DIST_FROM_THRESHOLD, -1, -1) };
}

/** Anzeige aus Pilotensicht von links nach rechts (außen → innen), z. B. 'WWRR'. eye = { x, y, z }. */
export function papiIndication(units, eye) {
  return [...units]
    .reverse()
    .map((u) => {
      const elev = (Math.atan2(eye.y - u.y, Math.hypot(eye.x - u.x, eye.z - u.z)) * 180) / Math.PI;
      return elev > u.angle ? 'W' : 'R';
    })
    .join('');
}
