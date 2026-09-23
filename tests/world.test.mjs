// Welt ohne Renderer: Tageszeit/Himmelsmodell (AK-21), Wolkenfeld und Sicht in der Wolke (AK-22),
// Kachel-Streaming (AK-19, Planungsseite), Landbedeckung am Flugplatz und PAPI-Anzeige.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sunDirection, sunElevationDeg, skyRadiance, skyLighting, inCloudAmount, fogVisibility,
} from '../js/world/skymodel.js';
import { createCloudField } from '../js/world/cloudfield.js';
import { TILE, MAX_TILES, streamTiles, tileKey, desiredLod } from '../js/world/tileplan.js';
import { landcover } from '../js/world/landcover.js';
import { papiUnits, papiIndication } from '../js/world/papi.js';
import { AIRPORT, terrainHeight } from '../js/world/heightfield.js';

const REPORT = !!process.env.AK_REPORT;
const report = (...a) => REPORT && console.log('  ', ...a);

// ------------------------------------------------------------------ AK-21 Tageszeit
test('AK-21 Sonnenstand: 12 h > 30°, 6,5 h und 18,5 h < 10°; Sonne im Süden mittags, Osten morgens', () => {
  const e12 = sunElevationDeg(12), e65 = sunElevationDeg(6.5), e185 = sunElevationDeg(18.5);
  report(`Sonnenhöhe 12 h ${e12.toFixed(1)}°, 6,5 h ${e65.toFixed(1)}°, 18,5 h ${e185.toFixed(1)}°`);
  assert.ok(e12 > 30, `12 h: ${e12}`);
  assert.ok(e65 < 10 && e185 < 10, `${e65} / ${e185}`);
  const noon = sunDirection(12), morning = sunDirection(8);
  assert.ok(noon[2] > 0.5, 'Mittags steht die Sonne im Süden (+Z)');
  assert.ok(morning[0] > 0.5, 'Morgens steht die Sonne im Osten (+X)');
  assert.ok(sunElevationDeg(0) < -30, 'Mitternacht: Sonne tief unter dem Horizont');
});

test('AK-21 Horizontfarbe zur Sonne bei 6,5 h und 18,5 h orange-rot, mittags bläulich-weiß', () => {
  for (const h of [6.5, 18.5]) {
    const s = sunDirection(h);
    const a = Math.hypot(s[0], s[2]);
    const c = skyRadiance(s[0] / a, 0.03, s[2] / a, s);
    report(`Horizont Richtung Sonne ${h} h: ${c.map((v) => v.toFixed(3)).join(' / ')}`);
    assert.ok(c[0] > c[1] && c[1] > c[2], `R > G > B erwartet: ${c}`);
    assert.ok(c[0] > 2.5 * c[2], `deutlich rot/orange: ${c}`);
    const L = skyLighting(h);
    assert.ok(L.hazeSun[0] > L.hazeSun[2] * 1.5, 'auch die Dunstfarbe zur Sonne ist warm');
  }
  const L12 = skyLighting(12);
  assert.ok(L12.zenith[2] > L12.zenith[0] * 2, 'Zenit mittags blau');
  assert.ok(L12.hazeAway[2] >= L12.hazeAway[0], 'Horizont mittags bläulich-weiß');
});

test('AK-21 Nacht: Sterne sichtbar (Alpha > 0,5), Sonne aus, Mondlicht schwach; Tag: keine Sterne', () => {
  const n = skyLighting(0);
  assert.ok(n.starAlpha > 0.5, `starAlpha ${n.starAlpha}`);
  assert.equal(n.sunIntensity, 0);
  assert.ok(n.moonIntensity > 0 && n.moonIntensity < 0.2);
  assert.ok(n.darkness === 1);
  const d = skyLighting(10);
  assert.equal(d.starAlpha, 0);
  assert.ok(d.sunIntensity > 3, `Sonne 10 h: ${d.sunIntensity}`);
  assert.ok(d.darkness === 0);
  // goldene Stunde: Sonnenlicht warm und schwächer
  const g = skyLighting(7);
  assert.ok(g.sunColor[2] < 0.6 && g.sunIntensity < d.sunIntensity);
});

// ------------------------------------------------------------------ AK-22 Wolken
test('AK-22 Wolken: 0 % → keine Wolke; 80 % → ≥ 30 Wolken im Umkreis von 10 km; deterministisch', () => {
  const f = createCloudField();
  f.setParams(0, 1219);
  assert.equal(f.cloudsNear(0, 0, 10000).length, 0);
  assert.equal(f.densityAt(0, 1300, 0), 0);
  f.setParams(0.8, 1219);
  const a = f.cloudsNear(0, 0, 10000).length;
  report(`80 %: ${a} Wolken im Umkreis von 10 km`);
  assert.ok(a >= 30, `nur ${a} Wolken`);
  const g = createCloudField();
  g.setParams(0.8, 1219);
  assert.equal(g.cloudsNear(0, 0, 10000).length, a, 'gleicher Seed → gleiche Wolken');
  // mehr Bedeckung → mehr Wolken
  f.setParams(0.35, 1219);
  assert.ok(f.cloudsNear(0, 0, 10000).length < a);
});

test('AK-22 In der Wolke: Dichte > 0,5 im Kern → Sichtweite < 200 m; außerhalb volle Sicht', () => {
  const f = createCloudField();
  f.setParams(0.8, 1219);
  const cl = f.cloudsNear(3000, -2000, 10000)[0];
  const core = f.densityAt(cl.x, cl.base + (cl.top - cl.base) * 0.45, cl.z);
  assert.ok(core > 0.5, `Kern-Dichte ${core}`);
  const vis = fogVisibility(inCloudAmount(core));
  report(`Kern-Dichte ${core.toFixed(2)} → Sicht ${vis.toFixed(0)} m`);
  assert.ok(vis < 200, `Sicht ${vis}`);
  const below = f.densityAt(cl.x, cl.base - 200, cl.z);
  assert.equal(below, 0);
  assert.ok(fogVisibility(inCloudAmount(below)) > 20000);
  // Wolken treiben mit dem Wind
  const x0 = cl.x;
  f.advance(10, 5, 0);
  const moved = f.cloudsNear(3000, -2000, 10000).find((c) => c.fx === cl.fx && c.fz === cl.fz);
  assert.ok(Math.abs(moved.x - x0 - 50) < 1e-6, 'Drift 5 m/s × 10 s');
});

// ------------------------------------------------------------------ AK-19 Kachel-Streaming (Planungsseite)
test('AK-19 Streaming: 30 km mit 110 kt, Budget 2 Kacheln/Update → nie Löcher, ≤ 25 Kacheln, LOD 0 ± 1 km', () => {
  const tiles = new Map();
  let fills = 0;
  const fill = (job, rec) => {
    fills++;
    return { ...(rec || {}), tx: job.tx, tz: job.tz, lod: job.lod };
  };
  let x = 300, z = -150; // Start nahe am Platz
  streamTiles(tiles, Math.floor(x / TILE), Math.floor(z / TILE), Infinity, fill);
  const v = 110 * 0.514444; // m/s
  const dt = 0.5; // SIM.step(60)
  const hdg = 0.6; // schräg über die Kachelgrenzen
  let maxPerUpdate = 0;
  const coverage = () => {
    for (const [dx, dz] of [[0, 0], [1000, 0], [-1000, 0], [0, 1000], [0, -1000], [700, 700], [-700, -700]]) {
      const t = tiles.get(tileKey(Math.floor((x + dx) / TILE), Math.floor((z + dz) / TILE)));
      if (!t || t.lod !== 0) return false;
    }
    return true;
  };
  for (let s = 0; s * v * dt < 30000; s++) {
    x += Math.sin(hdg) * v * dt;
    z -= Math.cos(hdg) * v * dt;
    const before = fills;
    streamTiles(tiles, Math.floor(x / TILE), Math.floor(z / TILE), 2, fill);
    maxPerUpdate = Math.max(maxPerUpdate, fills - before);
    assert.ok(tiles.size <= MAX_TILES, `zu viele Kacheln: ${tiles.size}`);
    assert.ok(coverage(), `Loch/LOD bei (${x.toFixed(0)}, ${z.toFixed(0)})`);
  }
  // am Ende sind alle 25 Soll-Kacheln im richtigen LOD vorhanden
  const cx = Math.floor(x / TILE), cz = Math.floor(z / TILE);
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const t = tiles.get(tileKey(cx + dx, cz + dz));
      assert.ok(t, 'Kachel fehlt');
      assert.equal(t.lod, desiredLod(dx, dz));
    }
  }
  report(`30 km: ${fills} Kachelfüllungen, max. ${maxPerUpdate} pro Update, ${tiles.size} Kacheln`);
  assert.ok(maxPerUpdate <= 2);
});

// ------------------------------------------------------------------ Landbedeckung, PAPI
test('Landbedeckung: kein Wald am Flugplatz und in der Anflugschneise, gemähtes Gras auf dem Plateau', () => {
  const out = [0, 0, 0, 0];
  for (let x = -1000; x <= 1000; x += 50) {
    for (let z = -250; z <= 250; z += 25) {
      landcover(x, z, terrainHeight(x, z), 1, out);
      assert.equal(out[0], 0, `Wald bei (${x}, ${z})`);
    }
  }
  landcover(0, 0, AIRPORT.elevation, 1, out);
  assert.equal(out[3], 1);
  for (const x of [-2400, -1500, 1500, 2400]) {
    landcover(x, 0, terrainHeight(x, 0), 1, out);
    assert.equal(out[0], 0, `Anflugschneise bei x = ${x}`);
  }
});

test('PAPI: auf dem 3°-Pfad WWRR, zu hoch WWWW, zu tief RRRR (beide Pistenrichtungen)', () => {
  const units = papiUnits();
  const thr = { 27: AIRPORT.runway.x1, '09': AIRPORT.runway.x0 };
  for (const rwy of ['27', '09']) {
    const u = units[rwy];
    const dir = rwy === '27' ? 1 : -1; // Anflug von Osten bzw. Westen
    const at = (deg, dist) => {
      const x = u[1].x + dir * dist;
      return { x, y: u[0].y + Math.tan((deg * Math.PI) / 180) * dist, z: 0 };
    };
    assert.equal(papiIndication(u, at(3, 4000)), 'WWRR', rwy);
    assert.equal(papiIndication(u, at(4, 4000)), 'WWWW', rwy);
    assert.equal(papiIndication(u, at(2, 4000)), 'RRRR', rwy);
    assert.equal(papiIndication(u, at(2.95, 1500)), 'WWRR', rwy);
    assert.ok(Math.abs(u[0].x - thr[rwy]) === 260, 'PAPI 260 m hinter der Schwelle');
    assert.ok(u.every((p) => Math.sign(p.z) === (rwy === '27' ? 1 : -1)), 'links vom Anflug');
  }
});
