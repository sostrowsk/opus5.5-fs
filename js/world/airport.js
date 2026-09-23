// Flugplatz Talheim (XTAL, fiktiv): Piste 09/27 (1200 × 30 m) mit Canvas-Markierungen, Rollweg mit gelber
// Mittellinie und Haltemarkierung, Vorfeld, zwei Hangars und Vereinsheim (ein Mesh mit Textur-Atlas), animierter
// Windsack (CPU-Geometrie, folgt dem Bodenwind mit Böen), PAPI für beide Richtungen (Farbe pro Lampe im Shader aus
// dem Höhenwinkel des Betrachters) und Pisten-/Schwellen-/Rollwegbefeuerung (ein Points-Draw-Call, nachts an).
import * as THREE from 'three';
import { AIRPORT } from './heightfield.js';
import { HAZE, HAZE_GLSL } from './sky.js';
import { papiUnits, papiIndication } from './papi.js';

const LIFT = 0.03; // m über dem (exakt ebenen) Plateau; zusätzlich polygonOffset

/** Pistentextur: zwei Hälften à 600 m übereinander in einer 4096 × 512-Leinwand (≈ 6,8 px/m). */
function runwayTexture() {
  const W = 4096, H = 512, HALF = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  const r = AIRPORT.runway;
  const pxm = W / (r.length / 2); // px pro m längs
  const pzm = HALF / r.width; // px pro m quer
  // Asphalt mit Struktur, Reifenabrieb in den Aufsetzzonen
  x.fillStyle = '#3d3f41';
  x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H);
  const d = img.data;
  let seed = 3;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed >>> 24) - 128) * 0.09;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  // Hilfsfunktion: Rechteck in Pistenkoordinaten (s = m ab Westende, q = m quer, Nord negativ)
  const rect = (s0, s1, q0, q1, color) => {
    x.fillStyle = color;
    for (const half of [0, 1]) {
      const a = Math.max(s0, half * 600), b = Math.min(s1, (half + 1) * 600);
      if (b <= a) continue;
      x.fillRect((a - half * 600) * pxm, half * HALF + (q0 + r.width / 2) * pzm, (b - a) * pxm, (q1 - q0) * pzm);
    }
  };
  // Reifenabrieb (deterministisch)
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const [s0, s1] of [[60, 420], [780, 1140]]) {
    for (let k = 0; k < 30; k++) {
      const q = -4 + rnd() * 8;
      rect(s0 + rnd() * 100, s1 - rnd() * 100, q, q + 0.4 + rnd() * 0.6, 'rgba(20,20,20,0.18)');
    }
  }
  const W8 = 'rgba(236,236,230,0.94)';
  // Randlinien
  rect(0, 1200, -14.1, -13.2, W8);
  rect(0, 1200, 13.2, 14.1, W8);
  // Schwellen (Piano Keys) an beiden Enden
  for (const s0 of [6, 1200 - 6 - 30]) {
    for (let k = 0; k < 8; k++) {
      const q = -12.5 + k * 3.35 + (k >= 4 ? 1.8 : 0);
      rect(s0, s0 + 30, q - 12.5 + 12.5, q + 1.8, W8);
    }
  }
  // Mittellinie (30 m Strich / 20 m Lücke)
  for (let s = 60; s < 1140; s += 50) rect(s, s + 30, -0.45, 0.45, W8);
  // Aufsetzzonen & Zielpunkt
  for (const [s, len, n] of [[150, 22.5, 3], [300, 22.5, 2], [450, 22.5, 1]]) {
    for (const end of [0, 1]) {
      const a = end === 0 ? s : 1200 - s - len;
      for (let k = 0; k < n; k++) {
        const off = 3 + k * 1.8;
        rect(a, a + len, off, off + 0.9, W8);
        rect(a, a + len, -off - 0.9, -off, W8);
      }
    }
  }
  for (const a of [230, 1200 - 230 - 45]) {
    rect(a, a + 45, 4.5, 10, W8);
    rect(a, a + 45, -10, -4.5, W8);
  }
  // Kennziffern: „09“ am Westende (lesbar beim Anflug von Westen), „27“ am Ostende
  const digits = (label, s0, flip) => {
    const half = s0 < 600 ? 0 : 1;
    const cx = (s0 - half * 600) * pxm;
    const cy = half * HALF + HALF / 2;
    x.save();
    x.translate(cx, cy);
    x.rotate(flip ? -Math.PI / 2 : Math.PI / 2); // Schriftoberkante zeigt in Landerichtung
    x.scale(pzm / pxm, 1);
    x.font = `700 ${Math.round(12.5 * pxm)}px ui-sans-serif, system-ui, Arial, sans-serif`;
    x.fillStyle = W8;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(label, 0, 0);
    x.restore();
  };
  digits('09', 60, false);
  digits('27', 1140, true);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

// ------------------------------------------------------------------ Gebäude-Atlas (1024 × 512)
// Regionen in Pixeln [x0, y0, x1, y1]
const ATL = {
  wall: [0, 0, 512, 256], // Wellblech hell
  door: [512, 0, 1024, 256], // Hangartor
  front: [0, 256, 512, 512], // Giebelwand mit Schild
  club: [512, 256, 768, 512], // Vereinsheim mit Fenstern
  roof: [768, 256, 896, 512], // Dach (Trapezblech dunkel)
  plain: [900, 260, 1020, 380], // einfarbig (Vertexfarbe)
};

function atlasTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d', { willReadFrequently: true });
  // Wellblech (senkrechte Sicken) mit Schmutz zum Boden hin
  const corrugated = (x0, y0, w, h, base, dark) => {
    g.fillStyle = base;
    g.fillRect(x0, y0, w, h);
    for (let x = 0; x < w; x += 8) {
      g.fillStyle = dark;
      g.fillRect(x0 + x, y0, 3, h);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(x0 + x + 4, y0, 2, h);
    }
    const gr = g.createLinearGradient(0, y0 + h * 0.75, 0, y0 + h);
    gr.addColorStop(0, 'rgba(60,55,45,0)');
    gr.addColorStop(1, 'rgba(60,55,45,0.35)');
    g.fillStyle = gr;
    g.fillRect(x0, y0, w, h);
  };
  corrugated(0, 0, 512, 256, '#b9bcbd', 'rgba(90,95,100,0.35)');
  corrugated(0, 256, 512, 256, '#b9bcbd', 'rgba(90,95,100,0.35)');
  // Schild auf der Giebelwand (oberer Teil der Region)
  // (zwischen Torsturz v ≈ 0,63 und Traufe v = 0,75 der Giebelwand)
  g.fillStyle = '#1f3d6b';
  g.fillRect(120, 323, 272, 27);
  g.fillStyle = '#f2f2ee';
  g.font = '700 22px ui-sans-serif, system-ui, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(256, 337);
  g.scale(0.55, 1); // die Giebelwand ist breiter als hoch abgebildet → Schrift vorverzerren
  g.fillText('TALHEIM  ·  XTAL', 0, 0);
  g.restore();
  // Hangartor: sechs Flügel, waagrechte Sicken, Fugen
  g.fillStyle = '#7d8a93';
  g.fillRect(512, 0, 512, 256);
  for (let y = 0; y < 256; y += 10) {
    g.fillStyle = 'rgba(40,50,60,0.25)';
    g.fillRect(512, y, 512, 3);
  }
  for (let k = 0; k <= 6; k++) {
    g.fillStyle = '#3c454c';
    g.fillRect(512 + k * (512 / 6) - 2, 0, 4, 256);
  }
  g.fillStyle = 'rgba(30,30,30,0.4)';
  g.fillRect(512, 244, 512, 12);
  // Vereinsheim: weißer Putz, Fenster, Tür
  g.fillStyle = '#e4e0d6';
  g.fillRect(512, 256, 256, 256);
  for (const wx of [530, 600, 690]) {
    g.fillStyle = '#5d4a36';
    g.fillRect(wx - 3, 330 - 3, 56, 66);
    g.fillStyle = '#26313a';
    g.fillRect(wx, 330, 50, 60);
    g.fillStyle = 'rgba(160,190,210,0.35)';
    g.fillRect(wx + 4, 334, 18, 52);
    g.fillStyle = '#5d4a36';
    g.fillRect(wx + 23, 330, 4, 60);
  }
  g.fillStyle = '#6b4a2e';
  g.fillRect(655, 400, 28, 112);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(512, 490, 256, 22);
  // Dach: dunkles Trapezblech
  g.fillStyle = '#5b5f62';
  g.fillRect(768, 256, 128, 256);
  for (let x = 768; x < 896; x += 6) {
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(x, 256, 2, 256);
  }
  g.fillStyle = '#ffffff';
  g.fillRect(896, 256, 128, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Geometrie-Sammler: Quads mit Atlas-Region und Vertexfarbe. */
function collector() {
  const P = [], N = [], UV = [], C = [];
  const uvOf = (reg, u, v) => [(reg[0] + (reg[2] - reg[0]) * u) / 1024, 1 - (reg[1] + (reg[3] - reg[1]) * (1 - v)) / 512];
  return {
    /** Viereck a-b-c-d (gegen den Uhrzeigersinn von außen), Region reg mit Teilbereich [u0, v0, u1, v1]. */
    quad(a, b, c, d, reg, col = [1, 1, 1], sub = [0, 0, 1, 1]) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(...n) || 1;
      const nn = [n[0] / l, n[1] / l, n[2] / l];
      const uv = [uvOf(reg, sub[0], sub[1]), uvOf(reg, sub[2], sub[1]), uvOf(reg, sub[2], sub[3]), uvOf(reg, sub[0], sub[3])];
      for (const [p, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]], [a, uv[0]], [c, uv[2]], [d, uv[3]]]) {
        P.push(...p);
        N.push(...nn);
        UV.push(...t);
        C.push(...col);
      }
    },
    tri(a, b, c, reg, col = [1, 1, 1], uvs = [[0, 0], [1, 0], [0.5, 1]]) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(...n) || 1;
      for (const [p, t] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]]]) {
        P.push(...p);
        N.push(n[0] / l, n[1] / l, n[2] / l);
        UV.push(...uvOf(reg, t[0], t[1]));
        C.push(...col);
      }
    },
    /** Achsparalleler Quader (Mittelpunkt unten), einfarbig. */
    box(cx, y0, cz, sx, sy, sz, col) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2, y1 = y0 + sy;
      const R = ATL.plain;
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], R, col);
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], R, col);
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], R, col);
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], R, col);
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], R, col);
    },
    /** Senkrechter Zylinder (Pfosten), einfarbig oder mit Farbwechsel je Abschnitt. */
    pole(cx, y0, cz, r, h, cols, sides = 8) {
      const n = cols.length;
      for (let s = 0; s < n; s++) {
        const ya = y0 + (h * s) / n, yb = y0 + (h * (s + 1)) / n;
        for (let k = 0; k < sides; k++) {
          const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
          const p = (a, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
          this.quad(p(a1, ya), p(a0, ya), p(a0, yb), p(a1, yb), ATL.plain, cols[s]);
        }
      }
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      g.computeBoundingSphere();
      return g;
    },
  };
}

/** Hangar mit Satteldach; Tor nach Süden (+Z) zum Vorfeld. */
function hangar(b, cx, cz, w, d, h, ridge) {
  const y0 = AIRPORT.elevation, x0 = cx - w / 2, x1 = cx + w / 2, zf = cz + d / 2, zb = cz - d / 2;
  const yw = y0 + h, yr = y0 + ridge, ov = 0.6;
  const W = ATL.wall, F = ATL.front, R = ATL.roof;
  // Seitenwände
  b.quad([x1, y0, zf], [x1, y0, zb], [x1, yw, zb], [x1, yw, zf], W);
  b.quad([x0, y0, zb], [x0, y0, zf], [x0, yw, zf], [x0, yw, zb], W);
  // Front (Süd) und Rückwand (Nord) als Rechteck + Giebeldreieck
  const gableV = h / ridge;
  b.quad([x0, y0, zf], [x1, y0, zf], [x1, yw, zf], [x0, yw, zf], F, [1, 1, 1], [0, 0, 1, gableV]);
  b.tri([x0, yw, zf], [x1, yw, zf], [cx, yr, zf], F, [1, 1, 1], [[0, gableV], [1, gableV], [0.5, 1]]);
  b.quad([x1, y0, zb], [x0, y0, zb], [x0, yw, zb], [x1, yw, zb], W, [1, 1, 1], [0, 0, 1, gableV]);
  b.tri([x1, yw, zb], [x0, yw, zb], [cx, yr, zb], W, [1, 1, 1], [[0, gableV], [1, gableV], [0.5, 1]]);
  // Dach mit Überstand
  b.quad([x1 + ov, yw - 0.25, zf + ov], [x1 + ov, yw - 0.25, zb - ov], [cx, yr, zb - ov], [cx, yr, zf + ov], R);
  b.quad([cx, yr, zf + ov], [cx, yr, zb - ov], [x0 - ov, yw - 0.25, zb - ov], [x0 - ov, yw - 0.25, zf + ov], R);
  // Tor (leicht vor der Wand) und Sockel
  const dw = w - 3, dh = h - 1.2;
  b.quad([cx - dw / 2, y0, zf + 0.08], [cx + dw / 2, y0, zf + 0.08], [cx + dw / 2, y0 + dh, zf + 0.08], [cx - dw / 2, y0 + dh, zf + 0.08], ATL.door);
  b.box(cx, y0, zf + 0.4, w + 0.4, 0.06, 0.8, [0.45, 0.45, 0.44]); // Torschiene
}

/** Vereinsheim mit flachem Satteldach. */
function clubhouse(b, cx, cz, w, d, h) {
  const y0 = AIRPORT.elevation, x0 = cx - w / 2, x1 = cx + w / 2, zf = cz + d / 2, zb = cz - d / 2, yw = y0 + h, yr = yw + 1.6;
  const Cl = ATL.club, R = ATL.roof;
  b.quad([x0, y0, zf], [x1, y0, zf], [x1, yw, zf], [x0, yw, zf], Cl);
  b.quad([x1, y0, zb], [x0, y0, zb], [x0, yw, zb], [x1, yw, zb], Cl, [1, 1, 1], [0, 0, 0.6, 1]);
  b.quad([x1, y0, zf], [x1, y0, zb], [x1, yw, zb], [x1, yw, zf], Cl, [1, 1, 1], [0, 0, 0.45, 1]);
  b.quad([x0, y0, zb], [x0, y0, zf], [x0, yw, zf], [x0, yw, zb], Cl, [1, 1, 1], [0, 0, 0.45, 1]);
  b.tri([x1, yw, zf], [x1, yw, zb], [x1, yr, cz], ATL.plain, [0.89, 0.87, 0.82]);
  b.tri([x0, yw, zb], [x0, yw, zf], [x0, yr, cz], ATL.plain, [0.89, 0.87, 0.82]);
  const ov = 0.5, red = [0.62, 0.3, 0.24];
  b.quad([x0 - ov, yw - 0.2, zf + ov], [x1 + ov, yw - 0.2, zf + ov], [x1 + ov, yr, cz], [x0 - ov, yr, cz], R, red);
  b.quad([x1 + ov, yw - 0.2, zb - ov], [x0 - ov, yw - 0.2, zb - ov], [x0 - ov, yr, cz], [x1 + ov, yr, cz], R, red);
}

// ------------------------------------------------------------------ Befeuerung (Points, ein Draw Call)
const LIGHT_VERT = /* glsl */ `
${HAZE_GLSL}
attribute vec3 aColA;
attribute vec3 aColB;
attribute vec4 aDir; // xyz Abstrahlrichtung, w: 0 rundum, 1 zweiseitig (A vorn / B hinten), 2 PAPI
attribute float aPapi; // PAPI-Schaltwinkel (°)
uniform float uNight, uScale;
varying vec3 vCol;
varying float vA;
void main() {
  vec3 toCam = cameraPosition - position;
  float d = length(toCam);
  vec3 v = toCam / max(d, 0.01);
  vec3 col = aColA;
  float vis = 1.0, on = uNight;
  if (aDir.w > 0.5 && aDir.w < 1.5) {
    float f = dot(v, aDir.xyz);
    col = f >= 0.0 ? aColA : aColB;
  } else if (aDir.w > 1.5) {
    // PAPI: nur aus Anflugrichtung sichtbar; rot unter dem Schaltwinkel, weiß darüber (schmaler Übergang)
    vis = smoothstep(0.0, 0.25, dot(v, aDir.xyz));
    float elev = degrees(atan(toCam.y, length(toCam.xz)));
    col = mix(vec3(9.0, 0.35, 0.25), vec3(7.0, 7.0, 6.5), smoothstep(aPapi - 0.06, aPapi + 0.06, elev));
    on = 1.0;
  }
  vec4 h = hazeAt(position);
  // Lampen durchdringen Dunst besser als Gelände (0,85), jenseits der Sichtweite (Wolke, Rand) sind sie aus
  vA = on * vis * (1.0 - h.a * 0.85) * (1.0 - smoothstep(uHazeNear, uHazeFar, d));
  vCol = col;
  gl_PointSize = clamp(1400.0 / d, 2.2, 16.0) * uScale * (aDir.w > 1.5 ? 1.3 : 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (vA < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // aus: verwerfen
}`;
const LIGHT_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  float a = (exp(-r2 * 7.0) + 0.25 * exp(-r2 * 2.0)) * (1.0 - smoothstep(0.6, 1.0, r2)) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createAirport(scene) {
  const group = new THREE.Group();
  group.name = 'airport';
  const r = AIRPORT.runway;
  const y = AIRPORT.elevation + LIFT;
  // Piste: zwei Hälften mit UV auf die obere/untere Texturhälfte
  const pos = [], uv = [], idx = [];
  for (const half of [0, 1]) {
    const x0 = r.x0 + half * 600, x1 = x0 + 600;
    const v0 = half === 0 ? 0.5 : 0, v1 = half === 0 ? 1 : 0.5;
    const b = pos.length / 3;
    // Textur-q = −15 (Nordrand, z = −15) oben
    pos.push(x0, y, -r.halfWidth, x1, y, -r.halfWidth, x0, y, r.halfWidth, x1, y, r.halfWidth);
    uv.push(0, v1, 1, v1, 0, v0, 1, v0);
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const rwyMat = new THREE.MeshStandardMaterial({
    map: runwayTexture(), roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const rwy = new THREE.Mesh(g, rwyMat);
  rwy.name = 'runway';
  rwy.receiveShadow = true;
  group.add(rwy);

  // ---------------------------------------------------------------- Rollweg & Vorfeld (Vertexfarben: Asphalt + Markierungen)
  {
    const P = [], C = [];
    const asph = new THREE.Color(0x46484a), yel = new THREE.Color(0xd9a92a);
    const rect = (x0, x1, z0, z1, yy, col, jitter = 0) => {
      const c = [col.r, col.g, col.b];
      if (jitter) for (let k = 0; k < 3; k++) c[k] *= 1 + jitter;
      P.push(x0, yy, z1, x1, yy, z1, x1, yy, z0, x0, yy, z1, x1, yy, z0, x0, yy, z0);
      for (let k = 0; k < 6; k++) C.push(...c);
    };
    // Flächen in 20-m-Feldern mit leichter Helligkeitsstreuung (Flickstellen)
    let s = 5;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (const a of AIRPORT.asphalt.slice(1)) {
      for (let x = a[0]; x < a[1]; x += 20) {
        for (let z = a[2]; z < a[3]; z += 20) rect(x, Math.min(x + 20, a[1]), z, Math.min(z + 20, a[3]), y - 0.005, asph, (rnd() - 0.5) * 0.12);
      }
    }
    const ym = y + 0.004;
    // Rollweg-Mittellinie (gelb) vom Vorfeld zur Piste, Haltemarkierung (2 durchgezogen + 2 gestrichelt)
    rect(-200.2, -199.8, -52, -15.5, ym, yel);
    for (const dz of [0, 0.45]) rect(-212, -188, -24.6 - dz, -24.3 - dz, ym, yel);
    for (let x = -212; x < -188; x += 1.8) for (const dz of [1.2, 1.65]) rect(x, x + 0.9, -24.6 - dz, -24.3 - dz, ym, yel);
    // Vorfeld: Führungslinie und Abstellpositionen
    rect(-290, -110, -60.2, -59.8, ym, yel);
    for (const px of [-270, -235, -165, -130]) rect(px - 0.2, px + 0.2, -104, -60, ym, yel);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    tg.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    tg.computeVertexNormals();
    const twMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const tw = new THREE.Mesh(tg, twMat);
    tw.name = 'taxiway';
    tw.receiveShadow = true;
    group.add(tw);
  }

  // ---------------------------------------------------------------- Gebäude, PAPI-Gehäuse, Windsackmast (ein Mesh)
  const papiRows = papiUnits(); // 27: Süden, Anflug von Osten; 09: Norden, Anflug von Westen
  const PAPI = [...papiRows[27], ...papiRows['09']];
  const SOCK = { x: 150, z: -58, h: 7.5 };
  {
    const b = collector();
    hangar(b, -255, -128, 36, 28, 7.2, 9.6);
    hangar(b, -206, -126, 28, 24, 6.4, 8.4);
    clubhouse(b, -140, -124, 16, 9, 3.4);
    for (const u of PAPI) {
      b.box(u.x, AIRPORT.elevation, u.z, 1.4, 0.95, 1.0, [0.78, 0.76, 0.7]);
      b.box(u.x + u.facing * 0.52, AIRPORT.elevation + 0.55, u.z, 0.06, 0.34, 0.8, [0.08, 0.08, 0.08]);
    }
    // Windsackmast (rot-weiß) mit Ausleger
    b.pole(SOCK.x, AIRPORT.elevation, SOCK.z, 0.09, SOCK.h, [[0.9, 0.9, 0.88], [0.75, 0.12, 0.1], [0.9, 0.9, 0.88], [0.75, 0.12, 0.1]]);
    b.box(SOCK.x, AIRPORT.elevation, SOCK.z, 1.2, 0.3, 1.2, [0.6, 0.6, 0.58]);
    const bm = new THREE.MeshStandardMaterial({ map: atlasTexture(), vertexColors: true, roughness: 0.78, metalness: 0.05 });
    const bmesh = new THREE.Mesh(b.geometry(), bm);
    bmesh.name = 'buildings';
    bmesh.castShadow = true;
    bmesh.receiveShadow = true;
    group.add(bmesh);
  }

  // ---------------------------------------------------------------- Windsack (CPU-animierte Geometrie)
  const SEGS = 5, SIDES = 10, SOCK_LEN = 3.6, R0 = 0.45, R1 = 0.16;
  const sockGeo = new THREE.BufferGeometry();
  const sockPos = new Float32Array(SEGS * 2 * SIDES * 3);
  const sockNrm = new Float32Array(SEGS * 2 * SIDES * 3);
  const sockCol = new Float32Array(SEGS * 2 * SIDES * 3);
  const sockIdx = [];
  for (let s = 0; s < SEGS; s++) {
    const col = s % 2 === 0 ? [0.95, 0.32, 0.05] : [0.93, 0.93, 0.9];
    for (let k = 0; k < 2 * SIDES; k++) sockCol.set(col, (s * 2 * SIDES + k) * 3);
    for (let k = 0; k < SIDES; k++) {
      const a = s * 2 * SIDES + k, b = s * 2 * SIDES + ((k + 1) % SIDES);
      const c = a + SIDES, d = b + SIDES;
      sockIdx.push(a, c, b, b, c, d);
    }
  }
  sockGeo.setAttribute('position', new THREE.BufferAttribute(sockPos, 3).setUsage(THREE.DynamicDrawUsage));
  sockGeo.setAttribute('normal', new THREE.BufferAttribute(sockNrm, 3).setUsage(THREE.DynamicDrawUsage));
  sockGeo.setAttribute('color', new THREE.BufferAttribute(sockCol, 3));
  sockGeo.setIndex(sockIdx);
  sockGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(SOCK.x, AIRPORT.elevation + SOCK.h, SOCK.z), SOCK_LEN + 1);
  const sock = new THREE.Mesh(sockGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
  sock.name = 'windsock';
  sock.castShadow = true;
  group.add(sock);
  const sockState = { t: 0, ext: 0, dir: 0, flap: 0 };

  function updateSock(dt, wx, wz, gust) {
    sockState.t += dt;
    const t = sockState.t;
    const speed = Math.hypot(wx, wz); // m/s
    const kt = speed / 0.5144 + gust;
    // Füllung (0 = hängt schlaff, 1 = voll ausgestreckt bei ≈ 15 kt) mit Trägheit
    const target = Math.max(0, Math.min(1, kt / 15));
    sockState.ext += (target - sockState.ext) * Math.min(1, dt * 1.8);
    const e = sockState.ext;
    // Richtung: der Windsack zeigt dorthin, wohin der Wind weht; bei Flaute pendelt er langsam
    const tdir = speed > 0.3 ? Math.atan2(wx, -wz) : sockState.dir;
    let dd = tdir - sockState.dir;
    dd = Math.atan2(Math.sin(dd), Math.cos(dd));
    sockState.dir += dd * Math.min(1, dt * 1.2);
    const dir = sockState.dir + Math.sin(t * 0.7) * 0.06 * (0.3 + e) + Math.sin(t * 2.3) * 0.03 * e;
    const fx = Math.sin(dir), fz = -Math.cos(dir); // Horizontalrichtung (x Ost, −z Nord)
    const sx = Math.cos(dir), sz = Math.sin(dir); // quer
    let px = SOCK.x + fx * 0.35, py = AIRPORT.elevation + SOCK.h - 0.1, pz = SOCK.z + fz * 0.35;
    const segLen = SOCK_LEN / SEGS;
    let vi = 0;
    for (let s = 0; s < SEGS; s++) {
      // Neigung unter die Horizontale: schlaff ≈ 75–85°, voll ≈ 3–8°; Flattern an der Spitze stärker
      const droop = ((1 - e) * (74 + s * 3) + e * (3 + s * 1.6)) * (Math.PI / 180);
      const flut = (Math.sin(t * (7 + s * 1.3) + s * 1.7) * 0.05 + Math.sin(t * 13.1 + s) * 0.02) * (0.2 + e) * (s + 1) * 0.5;
      const lat = Math.sin(t * (4.1 + s * 0.9) + s * 2.1) * 0.04 * e * (s + 1) * 0.5;
      const d = [fx * Math.cos(droop) + sx * lat, -Math.sin(droop) + flut, fz * Math.cos(droop) + sz * lat];
      const dl = Math.hypot(d[0], d[1], d[2]);
      d[0] /= dl;
      d[1] /= dl;
      d[2] /= dl;
      // Querachsen zum Segment
      let ux = sx, uy = 0, uz = sz; // horizontal quer
      let wxv = d[1] * uz - d[2] * uy, wyv = d[2] * ux - d[0] * uz, wzv = d[0] * uy - d[1] * ux; // d × u
      const wl = Math.hypot(wxv, wyv, wzv) || 1;
      wxv /= wl;
      wyv /= wl;
      wzv /= wl;
      const qx = px + d[0] * segLen, qy = py + d[1] * segLen, qz = pz + d[2] * segLen;
      const ra = R0 + (R1 - R0) * (s / SEGS), rb = R0 + (R1 - R0) * ((s + 1) / SEGS);
      // schlaffer Sack: Querschnitt fällt zusammen (flacher)
      const squash = 0.35 + 0.65 * e;
      for (const [cx, cy, cz, rr] of [[px, py, pz, ra], [qx, qy, qz, rb]]) {
        for (let k = 0; k < SIDES; k++) {
          const a = (k / SIDES) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const nx = ux * ca + wxv * sa, ny = uy * ca + wyv * sa, nz = uz * ca + wzv * sa;
          sockPos[vi * 3] = cx + ux * ca * rr + wxv * sa * rr * squash;
          sockPos[vi * 3 + 1] = cy + uy * ca * rr + wyv * sa * rr * squash;
          sockPos[vi * 3 + 2] = cz + uz * ca * rr + wzv * sa * rr * squash;
          sockNrm[vi * 3] = nx;
          sockNrm[vi * 3 + 1] = ny;
          sockNrm[vi * 3 + 2] = nz;
          vi++;
        }
      }
      px = qx;
      py = qy;
      pz = qz;
    }
    sockGeo.attributes.position.needsUpdate = true;
    sockGeo.attributes.normal.needsUpdate = true;
  }

  // ---------------------------------------------------------------- Befeuerung
  const LP = [], LA = [], LB = [], LD = [], LPA = [];
  const light = (x, yy, z, colA, colB = [0, 0, 0], dir = [0, 0, 0, 0], papi = 0) => {
    LP.push(x, yy, z);
    LA.push(...colA);
    LB.push(...colB);
    LD.push(...dir);
    LPA.push(papi);
  };
  const WHITE = [5.5, 5.0, 3.8], GREEN = [0.3, 6.0, 1.2], RED = [6.5, 0.25, 0.15], BLUE = [0.4, 0.9, 7.0];
  const ly = AIRPORT.elevation + 0.35;
  for (let x = r.x0; x <= r.x1 + 0.1; x += 60) for (const z of [-r.halfWidth - 1.5, r.halfWidth + 1.5]) light(x, ly, z, WHITE);
  for (let k = 0; k < 8; k++) {
    const z = -12.5 + (25 / 7) * k;
    light(r.x1 + 1, ly, z, GREEN, RED, [1, 0, 0, 1]); // Schwelle 27 (grün von Osten), Ende 09 (rot)
    light(r.x0 - 1, ly, z, GREEN, RED, [-1, 0, 0, 1]); // Schwelle 09, Ende 27
  }
  // Rollweg- und Vorfeldrand (blau)
  for (let z = -48; z <= -18; z += 10) for (const x of [-213.5, -186.5]) light(x, ly, z, BLUE);
  for (let x = -300; x <= -100; x += 25) light(x, ly, -111.5, BLUE);
  for (let x = -300; x <= -100; x += 25) if (x < -214 || x > -186) light(x, ly, -50.5, BLUE);
  for (let z = -110; z <= -52; z += 29) for (const x of [-301.5, -98.5]) light(x, ly, z, BLUE);
  for (const u of PAPI) light(u.x + u.facing * 0.56, u.y, u.z, [1, 1, 1], [0, 0, 0], [u.facing, 0, 0, 2], u.angle);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(LP, 3));
  lg.setAttribute('aColA', new THREE.Float32BufferAttribute(LA, 3));
  lg.setAttribute('aColB', new THREE.Float32BufferAttribute(LB, 3));
  lg.setAttribute('aDir', new THREE.Float32BufferAttribute(LD, 4));
  lg.setAttribute('aPapi', new THREE.Float32BufferAttribute(LPA, 1));
  const lightUniforms = { ...HAZE, uNight: { value: 0 }, uScale: { value: 1 } };
  const lights = new THREE.Points(
    lg,
    new THREE.ShaderMaterial({
      uniforms: lightUniforms,
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  lights.name = 'airportLights';
  lights.frustumCulled = false;
  lights.renderOrder = -2; // vor den Wolken: eine Wolke davor dämpft die Lampen
  group.add(lights);

  scene.add(group);

  /**
   * Pro Frame: dt (s), Bodenwind (m/s, Welt x/z, 10 m), Böe (kt), Dunkelheit 0..1 (Befeuerung),
   * Pixelverhältnis (Punktgröße).
   */
  function update(dt, opts = {}) {
    updateSock(Math.min(dt, 0.1), opts.windX ?? 0, opts.windZ ?? 0, opts.gustKt ?? 0);
    lightUniforms.uNight.value = Math.min(1, Math.max(0, ((opts.darkness ?? 0) - 0.25) / 0.35));
    if (opts.pixelRatio) lightUniforms.uScale.value = opts.pixelRatio;
  }

  return {
    group,
    runway: rwy,
    windsock: sock,
    sockState,
    lights,
    papi: PAPI,
    update,
    /** PAPI-Anzeige für einen Betrachter, z. B. SIM: airport.papiFor('27', camera.position) → 'WWRR'. */
    papiFor: (rwyId, eye) => papiIndication(papiRows[rwyId], eye),
  };
}
