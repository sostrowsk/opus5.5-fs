// Kachelbare Rausch-Textur (256², RGBA, einmalig auf der CPU erzeugt) für Terrain-, Wasser- und Wolkendetails.
// Vier unabhängige fBm-Kanäle mit unterschiedlicher Grundfrequenz; periodisch, damit Muster über
// modulo-reduzierte Weltkoordinaten nahtlos wiederholt werden können (SPEC §3.1: mod()-Koordinaten).
import * as THREE from 'three';

const SIZE = 256;
let cached = null;

function hash(i, j, s) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Periodischer Value-Noise mit Periode p Gitterzellen, Koordinaten u, v ∈ [0, p). */
function vnoise(u, v, p, s) {
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const a = fu * fu * fu * (fu * (fu * 6 - 15) + 10);
  const b = fv * fv * fv * (fv * (fv * 6 - 15) + 10);
  const i0 = ((i % p) + p) % p, j0 = ((j % p) + p) % p, i1 = (i0 + 1) % p, j1 = (j0 + 1) % p;
  const h00 = hash(i0, j0, s), h10 = hash(i1, j0, s), h01 = hash(i0, j1, s), h11 = hash(i1, j1, s);
  return h00 + (h10 - h00) * a + (h01 - h00) * b + (h00 - h10 - h01 + h11) * a * b;
}

/** Die gemeinsame Rausch-Textur (lazy, einmal pro Seite). */
export function noiseTexture() {
  if (cached) return cached;
  const data = new Uint8Array(SIZE * SIZE * 4);
  const base = [4, 8, 16, 32];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0, amp = 0.5, norm = 0, p = base[c];
        for (let o = 0; o < 4; o++) {
          sum += amp * vnoise((x / SIZE) * p, (y / SIZE) * p, p, c * 17 + o);
          norm += amp;
          amp *= 0.5;
          p *= 2;
        }
        // Kontrast leicht anheben (fBm liegt sonst eng um 0,5)
        const v = 0.5 + (sum / norm - 0.5) * 1.8;
        data[(y * SIZE + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
    }
  }
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  cached = t;
  return t;
}
