// Planung der Nahkacheln (ohne three, ohne DOM): 5 × 5 Kacheln à 1024 m um die Flugzeugkachel,
// innerer 3 × 3-Block LOD 0 (16 m), äußerer Ring LOD 1 (32 m). Liefert die Aufträge in Prioritätsreihenfolge;
// terrain.js arbeitet davon höchstens `budget` pro Update ab (PLAN §2.3, SPEC N4).
export const TILE = 1024;
export const NEAR = 2; // Radius in Kacheln → 5 × 5
export const MAX_TILES = (2 * NEAR + 1) ** 2;

export const tileKey = (tx, tz) => tx + ',' + tz;

/** Soll-LOD einer Kachel mit Versatz (dx, dz) zur Flugzeugkachel. */
export function desiredLod(dx, dz) {
  return Math.max(Math.abs(dx), Math.abs(dz)) <= 1 ? 0 : 1;
}

/**
 * Aufträge für den Block um (ctx, ctz). tiles: Map key → { tx, tz, lod }.
 * Priorität: 0 fehlende/zu grobe Kacheln im inneren 3 × 3 (LOD 0 unter dem Flugzeug), 1 fehlende Ringkacheln,
 * 2 überflüssig feine Ringkacheln (LOD 0 → 1, nur mit Restbudget). Innerhalb einer Stufe die nächsten zuerst.
 * Rückgabe: [{ tx, tz, lod, key, prio, d, replace: bool }]
 */
export function planTiles(tiles, ctx, ctz) {
  const jobs = [];
  for (let dz = -NEAR; dz <= NEAR; dz++) {
    for (let dx = -NEAR; dx <= NEAR; dx++) {
      const tx = ctx + dx, tz = ctz + dz, key = tileKey(tx, tz);
      const lod = desiredLod(dx, dz);
      const t = tiles.get(key);
      const d = dx * dx + dz * dz;
      if (!t) jobs.push({ tx, tz, lod, key, prio: lod === 0 ? 0 : 1, d, replace: false });
      else if (t.lod > lod) jobs.push({ tx, tz, lod, key, prio: 0, d, replace: true });
      else if (t.lod < lod) jobs.push({ tx, tz, lod, key, prio: 2, d, replace: true });
    }
  }
  jobs.sort((a, b) => a.prio - b.prio || a.d - b.d);
  return jobs;
}

/** Ist die Kachel (tx, tz) außerhalb des Blocks um (ctx, ctz)? */
export function outsideBlock(tx, tz, ctx, ctz) {
  return Math.max(Math.abs(tx - ctx), Math.abs(tz - ctz)) > NEAR;
}

/**
 * Streaming-Schritt (terrain.js und Tests): arbeitet bis zu `budget` Aufträge ab und ruft
 * fill(job, rec) für jede Kachel; rec ist der wiederverwendete Datensatz (dieselbe Kachel bei LOD-Wechsel, eine
 * Kachel außerhalb des Blocks) oder null (neu). fill schreibt die Kachel synchron und gibt den Datensatz zurück
 * ({ tx, tz, lod, … }). Kacheln außerhalb des Blocks werden erst entfernt, wenn ihr Mesh gebraucht wird – es
 * entstehen also nie Löcher. Rückgabe: Anzahl der Füllungen.
 */
export function streamTiles(tiles, ctx, ctz, budget, fill) {
  const jobs = planTiles(tiles, ctx, ctz);
  let made = 0;
  for (const j of jobs) {
    if (made >= budget) break;
    if (j.replace) {
      tiles.set(j.key, fill(j, tiles.get(j.key)));
      made++;
      continue;
    }
    // freies Mesh: die am weitesten entfernte Kachel außerhalb des Blocks, sonst neu (bis MAX_TILES)
    let worst = null, wd = -1;
    for (const [k, t] of tiles) {
      if (!outsideBlock(t.tx, t.tz, ctx, ctz)) continue;
      const dd = Math.max(Math.abs(t.tx - ctx), Math.abs(t.tz - ctz));
      if (dd > wd) {
        wd = dd;
        worst = k;
      }
    }
    if (worst === null && tiles.size >= MAX_TILES) break;
    const rec = worst !== null ? tiles.get(worst) : null;
    if (worst !== null) tiles.delete(worst);
    tiles.set(j.key, fill(j, rec));
    made++;
  }
  return made;
}
