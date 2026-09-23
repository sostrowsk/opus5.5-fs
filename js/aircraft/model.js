// Prozedurales Außenmodell der Cessna 172P mit Animationen (Ruder, Klappen, Trimmruder, Propeller,
// Räder, Lichter). Alle Maße in Body-Koordinaten (x vorn, y rechts, z unten; Ursprung Schwerpunkt),
// passend zu js/sim/c172.js (Radaufstandspunkte, Propellernabe, Strukturpunkte).
// Liegt komplett auf Layer 0 (Welt). Aus dem Cockpit sichtbar: Haube, Propeller, Flügel, Strebe.
import * as THREE from 'three';
import { B, loft, naca4, surfaceLoft, beam, rod, extrudeXZ, mergeGeometries, mesh, glowTexture } from './shapes.js';
import { C172 } from '../sim/c172.js';
import { clamp, lerp } from '../sim/math.js';

const D = Math.PI / 180;

// ------------------------------------------------------------------ Rumpf-Querschnitte
// [x, halbe Breite, Oberkante z, Unterkante z, Exponent obere Hälfte, Exponent untere Hälfte]
// (Superellipse; großer Exponent = kastenförmig. Die Kabine hat fast senkrechte Seitenwände.)
const FUSE = [
  [-4.70, 0.02, -0.225, 0.13, 2.2, 2.2],
  [-4.60, 0.07, -0.235, 0.165, 2.4, 2.4],
  [-4.40, 0.105, -0.255, 0.195, 2.6, 2.6],
  [-3.75, 0.165, -0.32, 0.255, 2.8, 2.8],
  [-3.05, 0.24, -0.42, 0.325, 3.0, 3.0],
  [-2.35, 0.34, -0.56, 0.40, 3.6, 3.4],
  [-1.75, 0.44, -0.74, 0.45, 5.0, 4.5],
  [-1.25, 0.52, -0.875, 0.50, 8.0, 6.5],
  [-0.60, 0.555, -0.885, 0.55, 10.0, 8.0],
  [0.0, 0.555, -0.875, 0.56, 10.0, 8.0],
  [0.44, 0.55, -0.845, 0.56, 9.0, 8.0],
  [0.75, 0.54, -0.555, 0.56, 7.0, 7.0],
  [1.05, 0.525, -0.285, 0.555, 6.0, 5.0],
  [1.40, 0.485, -0.276, 0.53, 4.0, 3.6],
  [1.70, 0.42, -0.262, 0.46, 3.6, 3.2],
  [1.90, 0.345, -0.248, 0.35, 3.2, 2.8],
  [1.97, 0.295, -0.235, 0.29, 3.0, 2.6],
];

/** Monotone kubische Interpolation (Fritsch-Carlson) – keine Überschwinger zwischen den Stützstellen. */
function pchip(xs, ys) {
  const n = xs.length;
  const h = [], dl = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    dl[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  m[0] = dl[0];
  m[n - 1] = dl[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (dl[i - 1] * dl[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}
const col = (k) => FUSE.map((r) => r[k]);
const fx = col(0);
const fHw = pchip(fx, col(1));
const fZt = pchip(fx, col(2));
const fZb = pchip(fx, col(3));
const fNt = pchip(fx, col(4));
const fNb = pchip(fx, col(5));

/** Rumpf-Ober-/Unterkante (Body z) an der Stelle x – auch vom Cockpit für den Innenraum benutzt. */
export const fuselageTop = fZt;
export const fuselageBottom = fZb;

/** Halbe Rumpfbreite (Außenhaut) an der Stelle x in der Höhe z (Body); 0 außerhalb. Für Innenraum-Prüfungen. */
export function fuselageHalfWidth(x, z) {
  const zt = fZt(x), zb = fZb(x);
  if (z <= zt || z >= zb) return 0;
  const zm = (zt + zb) / 2, hz = (zb - zt) / 2;
  const n = z < zm ? fNt(x) : fNb(x);
  const s = Math.abs(z - zm) / hz; // |s|^(2/n) = s  →  |sin| = s^(n/2)
  const sn = Math.pow(s, n / 2);
  const cn = Math.sqrt(Math.max(0, 1 - sn * sn));
  return fHw(x) * Math.pow(cn, 2 / n);
}

// ------------------------------------------------------------------ Fenster (Body-Koordinaten)
// Seitenfenster als Polygone in (x, z); das Cockpit schneidet seine Wände etwas kleiner aus.
export const DOOR_WINDOW = [[0.45, -0.8], [0.84, -0.29], [0.84, -0.228], [-0.62, -0.228], [-0.62, -0.8]];
export const REAR_WINDOW = [[-0.745, -0.79], [-0.745, -0.28], [-1.345, -0.462], [-1.345, -0.78]];
const SIDE_WINDOWS = [DOOR_WINDOW, REAR_WINDOW];

export function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Nächster Punkt auf dem Polygonrand: { d, x, z }. */
export function nearestOnPoly(poly, x, z) {
  let best = { d: Infinity, x, z };
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < best.d) best = { d, x: px, z: pz };
  }
  return best;
}
/** Scheiben auf der Rumpfoberseite (Windschutzscheibe zwischen den A-Säulen, Heckscheibe). */
function isTopWindow(x, y, z, m = 0) {
  const ay = Math.abs(y);
  const zt = fZt(x);
  if (x > 0.47 - m && x < 1.02 + m && z < zt + 0.1 + m && ay < 0.465 + m) return true;
  return x > -2.05 - m && x < -1.3 + m && ay < 0.4 + m && z < zt + 0.05 + m;
}
/** Fenster-Klassifizierung eines Rumpfpunkts; margin > 0 vergrößert die Flächen (für die Lackierung). */
function isWindow(x, y, z, m = 0) {
  const ay = Math.abs(y);
  if (isTopWindow(x, y, z, m)) return true;
  // Tür- und hintere Seitenfenster
  if (ay > 0.3) {
    for (const w of SIDE_WINDOWS) if (pointInPoly(w, x, z) || (m > 0 && nearestOnPoly(w, x, z).d < m)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ Lackierung (Seitenprojektion)
const PX0 = -4.75, PX1 = 2.0, PZ0 = -0.92, PZ1 = 0.6;
function paintTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#f3f2ee';
  x.fillRect(0, 0, W, H);
  // Zierstreifen (links: Nase links; rechts: Nase rechts)
  for (const side of [0, 1]) {
    const toPx = (bx, bz) => {
      const u = side === 0 ? (PX1 - bx) / (PX1 - PX0) : (bx - PX0) / (PX1 - PX0);
      return [u * W, side * 256 + ((bz - PZ0) / (PZ1 - PZ0)) * 256];
    };
    const stripe = (off, w, color) => {
      x.beginPath();
      for (let i = 0; i <= 60; i++) {
        const bx = PX1 - (i / 60) * (PX1 - PX0);
        const zs = (bx > -1.4 ? 0.05 : 0.05 - (-1.4 - bx) * 0.075) + off;
        const [px, py] = toPx(bx, zs);
        if (i === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      for (let i = 60; i >= 0; i--) {
        const bx = PX1 - (i / 60) * (PX1 - PX0);
        const zs = (bx > -1.4 ? 0.05 : 0.05 - (-1.4 - bx) * 0.075) + off + w;
        const [px, py] = toPx(bx, zs);
        x.lineTo(px, py);
      }
      x.closePath();
      x.fillStyle = color;
      x.fill();
    };
    stripe(-0.035, 0.07, '#1d3a6b');
    stripe(0.05, 0.018, '#b3202a');
    // Türfugen und Nietlinien
    x.strokeStyle = 'rgba(90,90,90,0.55)';
    x.lineWidth = 1.2;
    for (const bx of [0.43, -0.63, 1.06]) {
      const [p0x, p0y] = toPx(bx, -0.8);
      const [p1x, p1y] = toPx(bx, 0.5);
      x.beginPath();
      x.moveTo(p0x, p0y);
      x.lineTo(p1x, p1y);
      x.stroke();
    }
  }
  // Fenster dunkel (mit Rand), Pixel für Pixel aus derselben Fensterdefinition wie die Löcher
  const img = x.getImageData(0, 0, W, H);
  const d = img.data;
  for (let py = 0; py < H; py++) {
    const side = py < 256 ? 0 : 1;
    const bz = PZ0 + ((py % 256) / 256) * (PZ1 - PZ0);
    for (let px = 0; px < W; px++) {
      const u = px / W;
      const bx = side === 0 ? PX1 - u * (PX1 - PX0) : PX0 + u * (PX1 - PX0);
      if (isWindow(bx, 0.5, bz, 0.022) || isWindow(bx, 0, bz, 0.022)) {
        const k = (py * W + px) * 4;
        d[k] = 22;
        d[k + 1] = 27;
        d[k + 2] = 33;
      }
    }
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let fuselageCache = null;
/** Rumpf-Geometrie (einmal gebaut, von Außenmodell und Cockpit gemeinsam genutzt). */
export function getFuselage() {
  return fuselageCache || (fuselageCache = buildFuselage());
}

/** Rumpf-Loft; liefert Haut (mit Fensterlöchern) und die Fensterflächen als eigene Geometrie. */
function buildFuselage() {
  const NP = 96;
  const xs = [];
  for (let x = 1.97; x > -4.7; ) {
    xs.push(x);
    x -= x > -1.5 && x < 1.1 ? 0.035 : 0.09;
  }
  xs.push(-4.7);
  const rings = xs.map((x) => {
    const hw = fHw(x), zt = fZt(x), zb = fZb(x), nt = fNt(x), nb = fNb(x);
    const zm = (zt + zb) / 2, hz = (zb - zt) / 2;
    const ring = [];
    for (let i = 0; i < NP; i++) {
      const th = (i / NP) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const n = s > 0 ? nt : nb; // obere Hälfte (s > 0 → z < zm)
      let px = x, py = hw * Math.sign(c) * Math.abs(c) ** (2 / n), pz = zm - hz * Math.sign(s) * Math.abs(s) ** (2 / n);
      // Seitenfenster: Punkte nahe der Fensterkante auf die Kante setzen (glatte Ausschnitte statt Treppen)
      if (Math.abs(py) > 0.3) {
        for (const w of SIDE_WINDOWS) {
          const q = nearestOnPoly(w, px, pz);
          if (q.d < 0.02) {
            px = q.x;
            pz = q.z;
            py = Math.sign(py) * fuselageHalfWidth(px, pz);
          }
        }
      }
      ring.push([px, py, pz]);
    }
    return ring;
  });
  const full = loft(rings, { capStart: true, capEnd: true });
  const g = full.toNonIndexed();
  const pos = g.attributes.position.array;
  const nor = g.attributes.normal.array;
  const skinP = [], skinN = [], skinUV = [], glassP = [], glassN = [];
  for (let t = 0; t < pos.length; t += 9) {
    // Schwerpunkt in Body-Koordinaten (lokal → body: x = −z, y = x, z = −y)
    const bx = -(pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
    const by = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
    const bz = -(pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
    const tri = pos.slice(t, t + 9), trn = nor.slice(t, t + 9);
    // Oben (Scheiben): Schwerpunkt entscheidet; Seitenfenster: alle drei Ecken innerhalb/auf dem Rand
    let glass = isTopWindow(bx, by, bz);
    if (!glass && Math.abs(by) > 0.3) {
      glass = SIDE_WINDOWS.some((w) => {
        for (let v = 0; v < 3; v++) {
          const vx = -tri[v * 3 + 2], vz = -tri[v * 3 + 1];
          if (!pointInPoly(w, vx, vz) && nearestOnPoly(w, vx, vz).d > 1e-3) return false;
        }
        return true;
      });
    }
    if (glass) {
      glassP.push(...tri);
      glassN.push(...trn);
      continue;
    }
    skinP.push(...tri);
    skinN.push(...trn);
    const side = by < 0 ? 0 : 1;
    for (let v = 0; v < 3; v++) {
      const vx = -tri[v * 3 + 2], vz = -tri[v * 3 + 1];
      const u = side === 0 ? (PX1 - vx) / (PX1 - PX0) : (vx - PX0) / (PX1 - PX0);
      const vv = (side * 0.5 + clamp((vz - PZ0) / (PZ1 - PZ0), 0, 1) * 0.5);
      skinUV.push(u, 1 - vv);
    }
  }
  // Glas-UV (für die Innen-Schlieren): Projektion auf Body x/y bzw. x/z
  const glassUV = [];
  for (let t = 0; t < glassP.length; t += 3) {
    const bx = -glassP[t + 2], by = glassP[t], bz = -glassP[t + 1];
    glassUV.push(by * 0.9 + 0.5, Math.abs(by) > 0.45 ? 0.5 - bz : 0.5 - bx * 0.9);
  }
  const mk = (p, n, uv) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv || new Array((p.length / 3) * 2).fill(0), 2));
    return geo;
  };
  return { skin: mk(skinP, skinN, skinUV), glass: mk(glassP, glassN, glassUV) };
}

// ------------------------------------------------------------------ Tragflächen & Leitwerk
const WING_LE = 0.45;
const NOSE_PIVOT = B(1.28, 0, 0.8);
const wingChord = (y) => {
  const a = Math.abs(y);
  return a <= 2.54 ? 1.63 : lerp(1.63, 1.12, (a - 2.54) / (5.3 - 2.54));
};
const wingZ = (y) => -0.905 - Math.abs(y) * Math.tan(1.73 * D);
const wingInc = (y) => lerp(1.5, -1.5, clamp(Math.abs(y) / 5.3, 0, 1)) * D;
function wingStation(y, c = wingChord(y), leShift = 0, zShift = 0) {
  const i = wingInc(y);
  return { le: [WING_LE - leShift, y, wingZ(y) + zShift], aft: [-Math.cos(i), 0, Math.sin(i)], up: [-Math.sin(i), 0, -Math.cos(i)], c };
}
const mirror = (st) => st.map((s) => ({ ...s, le: [s.le[0], -s.le[1], s.le[2]] }));
/** Punkt auf dem Profil einer Flügelstation (Body). */
function wingPoint(y, xc, zc) {
  const s = wingStation(y);
  return [s.le[0] + s.aft[0] * xc * s.c + s.up[0] * zc * s.c, y, s.le[2] + s.aft[2] * xc * s.c + s.up[2] * zc * s.c];
}

/** Drehgelenk für eine Ruderfläche: Gruppe am Scharnier, Achse (lokal) normiert. */
function hinge(parent, pA, pB, geo, mat, name, layer = 0) {
  const a = B(...pA), b = B(...pB);
  const axis = new THREE.Vector3().subVectors(b, a).normalize();
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.copy(a).add(b).multiplyScalar(0.5);
  const g = geo.clone();
  g.translate(-pivot.position.x, -pivot.position.y, -pivot.position.z);
  const m = mesh(g, mat, { layer, name: name + 'Mesh' });
  pivot.add(m);
  pivot.userData.axis = axis;
  pivot.userData.base = pivot.position.clone();
  parent.add(pivot);
  return pivot;
}

// Ringe mit stationsabhängigem Profil (gleiche Punktzahl je Station)
function profileRings(st, profFn) {
  return st.map((s, k) =>
    profFn(k).map(([xc, zc]) => [
      s.le[0] + s.aft[0] * xc * s.c + s.up[0] * zc * s.c,
      s.le[1] + s.aft[1] * xc * s.c + s.up[1] * zc * s.c,
      s.le[2] + s.aft[2] * xc * s.c + s.up[2] * zc * s.c,
    ]),
  );
}

// ------------------------------------------------------------------ Propeller
/** Lokale Prop-Koordinaten (x rechts, y oben, z hinten) → Body. */
const bodyOfLocal = (x, y, z) => [-z, x, -y];
function buildBlades() {
  const R = [0.11, 0.2, 0.35, 0.5, 0.65, 0.8, 0.88, 0.93, 0.955];
  const Cc = [0.075, 0.12, 0.145, 0.14, 0.13, 0.115, 0.1, 0.08, 0.04];
  const Tt = [0.45, 0.2, 0.12, 0.1, 0.085, 0.075, 0.07, 0.07, 0.07];
  const geos = [];
  for (const sgn of [1, -1]) {
    const rings = R.map((r, k) => {
      const beta = Math.atan(1.5 / (2 * Math.PI * r)) + 2 * D;
      const prof = naca4(0.03, 0.3, Tt[k], 8);
      const c = Cc[k];
      // Blatt entlang +y (bzw. −y); Vorderkante in Drehrichtung (+x bei +y) und nach vorn (−z)
      return prof.map(([xc, zc]) => {
        const s = (xc - 0.35) * c, t = zc * c;
        const lx = -Math.cos(beta) * s - Math.sin(beta) * t;
        const lz = Math.sin(beta) * s - Math.cos(beta) * t;
        return bodyOfLocal(sgn * lx, sgn * r, lz);
      });
    });
    const g = loft(rings, { capEnd: true }).toNonIndexed();
    // Farben: Rückseite (zum Piloten, +z) mattschwarz, Vorderseite Alu, Spitzen rot-weiß-rot
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    const colr = new Float32Array(p.length);
    const black = new THREE.Color(0x121212), alu = new THREE.Color(0x9a9ea3), red = new THREE.Color(0xc02020), white = new THREE.Color(0xeeeeee);
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.abs(p[i + 1]);
      let c = n[i + 2] > 0 ? black : alu;
      if (r > 0.865) c = r > 0.895 && r < 0.92 ? white : red;
      colr[i] = c.r;
      colr[i + 1] = c.g;
      colr[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
    geos.push(g);
  }
  return mergeGeometries(geos);
}

function propDiscMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0.5 },
      uGhost: { value: 0 },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uGlint: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform float uGhost;
      uniform vec3 uSun;
      uniform float uGlint;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        if (r > 0.955 || r < 0.12) discard;
        float a = atan(vP.y, vP.x);
        // Blattdichte: 2 Blätter decken innen mehr vom Umfang ab
        float cover = clamp(0.28 / (6.2832 * r), 0.0, 0.5);
        float alpha = uOpacity * (0.25 + 2.2 * cover);
        vec3 col = vec3(0.035);
        // Spitzen-Streifen erscheinen als Ringe
        float tip = smoothstep(0.862, 0.87, r);
        float white = smoothstep(0.893, 0.9, r) * (1.0 - smoothstep(0.915, 0.922, r));
        col = mix(col, vec3(0.22, 0.04, 0.03), tip);
        col = mix(col, vec3(0.3), white);
        alpha += tip * 0.02 * uOpacity;
        // Geisterblätter (stroboskopischer Eindruck)
        float g = pow(abs(cos(a - uGhost)), 60.0);
        alpha += g * 0.10 * uOpacity * smoothstep(0.15, 0.4, r);
        // Sonnenstreifen: radialer Glanz Richtung Sonne
        float sa = atan(uSun.y, uSun.x);
        float d = abs(atan(sin(a - sa), cos(a - sa)));
        float glint = exp(-d * d * 900.0) * uGlint * smoothstep(0.18, 0.8, r) * (1.0 - smoothstep(0.9, 0.955, r));
        col += vec3(1.0, 0.96, 0.88) * glint * 1.6;
        alpha += glint * 0.35;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ------------------------------------------------------------------ Modell
export function createAircraftModel() {
  const group = new THREE.Group();
  group.name = 'c172-exterior';

  const paintTex = paintTexture();
  const M = {
    paint: new THREE.MeshStandardMaterial({ color: 0xffffff, map: paintTex, roughness: 0.38, metalness: 0.0 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.4, metalness: 0.0 }),
    grey: new THREE.MeshStandardMaterial({ color: 0x8f949a, roughness: 0.45, metalness: 0.5 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.2, metalness: 0.9 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0f1822, roughness: 0.06, metalness: 0.3, transparent: true, opacity: 0.72, depthWrite: false,
    }),
    prop: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 }),
    lens: new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.1, metalness: 0.2, emissive: 0x000000 }),
  };

  // --- Rumpf
  const fus = getFuselage();
  const skin = mesh(fus.skin, M.paint, { name: 'fuselage' });
  group.add(skin);
  const win = mesh(fus.glass, M.glass, { cast: false, receive: false, name: 'windows' });
  win.renderOrder = 1;
  group.add(win);

  // --- Tragflächen
  const PN = 20;
  const full = naca4(0.02, 0.4, 0.12, PN);
  const trunc = naca4(0.02, 0.4, 0.12, PN, 0, 0.74);
  const whiteStatic = [];
  // Mittelstück über der Kabine (volle Tiefe)
  whiteStatic.push(surfaceLoft([wingStation(-0.6), wingStation(0), wingStation(0.6)], full, { capStart: true, capEnd: true }));
  const inner = [wingStation(0.58), wingStation(1.5), wingStation(2.54), wingStation(3.4), wingStation(4.3), wingStation(5.05)];
  const outer = [wingStation(5.05), wingStation(5.3), wingStation(5.4, 1.0, 0.03, -0.004), wingStation(5.46, 0.74, 0.12, -0.008), wingStation(5.49, 0.36, 0.33, -0.01)];
  for (const st of [inner, mirror(inner)]) whiteStatic.push(surfaceLoft(st, trunc));
  for (const st of [outer, mirror(outer)]) whiteStatic.push(surfaceLoft(st, full));

  // Klappen (0,60–2,85 m) und Querruder (2,95–5,05 m)
  const flapProf = naca4(0.02, 0.4, 0.12, 10, 0.745, 1);
  const ailProf = naca4(0.02, 0.4, 0.12, 10, 0.755, 1);
  const flapSt = [wingStation(0.6), wingStation(1.7), wingStation(2.85)];
  const ailSt = [wingStation(2.95), wingStation(4.0), wingStation(5.05)];
  const parts = {};
  const hingeF = (y) => wingPoint(y, 0.75, -0.035);
  const hingeA = (y) => wingPoint(y, 0.76, 0.0);
  parts.flapR = hinge(group, hingeF(0.6), hingeF(2.85), surfaceLoft(flapSt, flapProf), M.white, 'flapR');
  parts.flapL = hinge(group, hingeF(-2.85), hingeF(-0.6), surfaceLoft(mirror(flapSt), flapProf), M.white, 'flapL');
  parts.aileronR = hinge(group, hingeA(2.95), hingeA(5.05), surfaceLoft(ailSt, ailProf), M.white, 'aileronR');
  parts.aileronL = hinge(group, hingeA(-5.05), hingeA(-2.95), surfaceLoft(mirror(ailSt), ailProf), M.white, 'aileronL');

  // Streben (stromlinienförmig) Rumpf → Flügel
  const strutProf = naca4(0, 0, 0.3, 8);
  for (const s of [1, -1]) {
    const pF = [-0.12, s * 0.54, 0.4];
    const pW = [0.05, s * 2.55, wingZ(2.55) + 0.06];
    const dir = [pW[0] - pF[0], pW[1] - pF[1], pW[2] - pF[2]];
    const st = (p) => ({ le: [p[0] + 0.05, p[1], p[2]], aft: [-1, 0, 0], up: norm3(cross3(dir, [-1, 0, 0])), c: 0.1 });
    whiteStatic.push(surfaceLoft([st(pF), st(pW)], strutProf));
    // Beschläge
    whiteStatic.push(beam([pF[0], pF[1] * 0.97, pF[2]], [pF[0], pF[1] * 1.04, pF[2] + 0.02], 0.06, 0.06, [1, 0, 0]));
  }

  // Höhenleitwerk (fest) + Höhenruder (ein Stück, Mittelausschnitt fürs Seitenruder)
  const HT_LE = -3.9, HT_Z = -0.07;
  const htSt = (y, c, leShift = 0) => ({ le: [HT_LE - leShift, y, HT_Z], aft: [-1, 0, 0], up: [0, 0, -1], c });
  const sym = naca4(0, 0, 0.09, 14);
  const symT = naca4(0, 0, 0.09, 14, 0, 0.6);
  const htIn = [htSt(0, 1.05), htSt(0.5, 1.0, 0.02), htSt(1.0, 0.95, 0.04), htSt(1.55, 0.88, 0.07)];
  const htTip = [htSt(1.55, 0.88, 0.07), htSt(1.66, 0.74, 0.13), htSt(1.72, 0.45, 0.3)];
  for (const st of [htIn, mirror(htIn)]) whiteStatic.push(surfaceLoft(st, symT));
  for (const st of [htTip, mirror(htTip)]) whiteStatic.push(surfaceLoft(st, sym));
  const elevProf = naca4(0, 0, 0.09, 10, 0.605, 1);
  const elSt = [htSt(0.1, 1.045, 0.0), htSt(0.5, 1.0, 0.02), htSt(1.0, 0.95, 0.04), htSt(1.55, 0.88, 0.07)];
  const elevGeo = mergeGeometries([surfaceLoft(elSt, elevProf), surfaceLoft(mirror(elSt), elevProf)]);
  const hE = (y) => [HT_LE - 0.61 * 1.0, y, HT_Z];
  parts.elevator = hinge(group, hE(-1.55), hE(1.55), elevGeo, M.white, 'elevator');
  // Trimmruder am rechten Höhenruder (Hinterkante, innen)
  {
    const teX = HT_LE - 1.03;
    const tabGeo = beam([teX + 0.02, 0.4, HT_Z], [teX + 0.02 - 0.075, 0.4, HT_Z], 0.012, 0.36, [0, 1, 0]);
    // Tab-Scharnier an der Höhenruder-Hinterkante; Gruppe als Kind des Höhenruders
    const tabPivot = new THREE.Group();
    tabPivot.name = 'trimTab';
    const hp = B(teX + 0.02, 0.4, HT_Z);
    tabPivot.position.copy(hp).sub(parts.elevator.position);
    tabGeo.translate(-hp.x, -hp.y, -hp.z);
    tabPivot.add(mesh(tabGeo, M.white, { name: 'trimTabMesh' }));
    tabPivot.userData.axis = new THREE.Vector3(1, 0, 0);
    parts.elevator.add(tabPivot);
    parts.trimTab = tabPivot;
  }

  // Seitenflosse (fest) + Seitenruder
  const finSt = [
    { z: -0.2, le: -3.52, hx: -4.64 },
    { z: -0.8, le: -4.02, hx: -4.68 },
    { z: -1.4, le: -4.42, hx: -4.74 },
  ];
  const finRings = [];
  // feste Flosse endet stumpf an der Scharnierlinie (70 % ihrer gedachten Profiltiefe)
  for (const f of finSt) {
    const c = (f.le - f.hx) / 0.7;
    const st = { le: [f.le, 0, f.z], aft: [-1, 0, 0], up: [0, 1, 0], c };
    finRings.push(profileRings([st], () => naca4(0, 0, 0.1, 12, 0, 0.7))[0]);
  }
  // Flossenspitze (abgerundet, fast volle Tiefe; gleiche Punktzahl wie die gekappten Profile)
  const tipRing = (z, le, c) => profileRings([{ le: [le, 0, z], aft: [-1, 0, 0], up: [0, 1, 0], c }], () => naca4(0, 0, 0.1, 12, 0, 0.999))[0];
  finRings.push(tipRing(-1.5, -4.5, 0.62), tipRing(-1.56, -4.62, 0.34));
  whiteStatic.push(loft(finRings, { capStart: true, capEnd: true }));
  // Rückenflosse
  whiteStatic.push(extrudeXZ([[-2.45, fZt(-2.45) + 0.02], [-3.86, -0.6], [-3.6, fZt(-3.6) + 0.03]], -0.022, 0.022));
  // Seitenruder: eigenes Profil von der Scharnierlinie bis zur Hinterkante
  const rudSt = [
    { z: 0.12, hx: -4.64, te: -4.96 },
    { z: -0.2, hx: -4.64, te: -5.06 },
    { z: -0.8, hx: -4.68, te: -5.09 },
    { z: -1.4, hx: -4.74, te: -5.12 },
    { z: -1.49, hx: -4.76, te: -5.0 },
  ];
  const rudProf = naca4(0, 0, 0.1, 10, 0.55, 1);
  const rudRings = rudSt.map((r) => {
    const cv = (r.hx - r.te) / 0.45;
    const le = r.hx + 0.55 * cv;
    return profileRings([{ le: [le, 0, r.z], aft: [-1, 0, 0], up: [0, 1, 0], c: cv }], () => rudProf)[0];
  });
  parts.rudder = hinge(group, [-4.64, 0, 0.12], [-4.76, 0, -1.49], loft(rudRings, { capStart: true, capEnd: true }), M.white, 'rudder');

  // --- Motorhaube: Lufteinlässe, Auspuff, Spinner
  const darkStatic = [];
  for (const s of [1, -1]) {
    const g = new THREE.CircleGeometry(0.075, 20);
    g.scale(1, 0.7, 1);
    g.rotateY(Math.PI); // Normal nach vorn (−z lokal)
    const p = B(1.972, s * 0.2, 0.05);
    g.translate(p.x, p.y, p.z);
    darkStatic.push(g);
  }
  darkStatic.push(rod([1.3, 0.08, 0.5], [1.22, 0.1, 0.56], 0.022, 0.022, 10));
  {
    const prof = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      prof.push(new THREE.Vector2(0.17 * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.15 * t), t * 0.31));
    }
    const sp = new THREE.LatheGeometry(prof, 32);
    sp.rotateX(-Math.PI / 2);
    const p = B(1.965, 0, -0.05);
    sp.translate(p.x, p.y, p.z);
    group.add(mesh(sp, M.white, { name: 'spinner' }));
  }

  // --- Propeller
  const prop = new THREE.Group();
  prop.name = 'prop';
  prop.position.copy(B(2.02, 0, -0.05));
  group.add(prop);
  const blades = mesh(buildBlades(), M.prop, { name: 'propBlades' });
  prop.add(blades);
  const discMat = propDiscMaterial();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.96, 96), discMat);
  disc.name = 'propDisc';
  disc.renderOrder = 2;
  disc.visible = false;
  group.add(disc);
  disc.position.copy(B(2.03, 0, -0.05));
  parts.prop = prop;
  parts.propBlades = blades;
  parts.propDisc = disc;

  // --- Fahrwerk
  const gear = C172.gear;
  parts.wheels = [];
  const tireGeo = (R, r) => {
    const t = new THREE.TorusGeometry(R, r, 12, 28);
    t.rotateY(Math.PI / 2);
    return t;
  };
  const hubGeo = (r, w) => {
    const h = new THREE.CylinderGeometry(r, r, w, 16);
    h.rotateZ(Math.PI / 2);
    return h;
  };
  const pantGeo = (sx, sy, sz) => {
    const s = new THREE.SphereGeometry(1, 24, 14);
    s.scale(sx, sy, sz);
    return s;
  };
  for (let i = 0; i < 3; i++) {
    const gp = gear[i];
    const rad = gp.radius;
    const axle = [gp.pos[0], gp.pos[1], gp.pos[2] - rad];
    const leg = new THREE.Group(); // federt ein (Achse + Rad + Verkleidung)
    leg.name = 'gear_' + gp.name;
    group.add(leg);
    const wheel = new THREE.Group();
    wheel.position.copy(B(...axle));
    const tire = tireGeo(rad - (i === 0 ? 0.055 : 0.065), i === 0 ? 0.055 : 0.065);
    const spinGroup = new THREE.Group();
    spinGroup.add(mesh(tire, M.rubber, { name: 'tire' }));
    spinGroup.add(mesh(hubGeo(i === 0 ? 0.075 : 0.09, 0.11), M.grey, { name: 'hub' }));
    // Speichen-Andeutung, damit die Drehung sichtbar ist
    const spoke = new THREE.BoxGeometry(0.115, 0.02, i === 0 ? 0.13 : 0.16);
    spinGroup.add(mesh(spoke, M.dark, { name: 'hubMark' }));
    wheel.add(spinGroup);
    const pant = mesh(pantGeo(i === 0 ? 0.1 : 0.12, i === 0 ? 0.16 : 0.19, i === 0 ? 0.38 : 0.46), M.white, { name: 'pant' });
    pant.position.set(0, 0.02, 0.06);
    wheel.add(pant);
    leg.add(wheel);
    parts.wheels.push({ leg, wheel, spin: spinGroup, base: wheel.position.clone() });
    if (i > 0) {
      const s = Math.sign(gp.pos[1]);
      // Federstahl-Bein (statisch, endet in der Verkleidung)
      whiteStatic.push(beam([-0.4, s * 0.5, 0.5], [axle[0], s * (Math.abs(axle[1]) - 0.07), axle[2] - 0.02], 0.028, 0.075, [1, 0, 0]));
    }
  }
  // Bugfahrwerk: oberes Federbein statisch, unteres Teil federt mit dem Rad
  {
    const g0 = gear[0];
    const axle = [g0.pos[0], 0, g0.pos[2] - g0.radius];
    const chromeGeo = mergeGeometries([rod([1.36, 0, 0.42], [1.29, 0, 0.8], 0.036, 0.034, 14)]);
    group.add(mesh(chromeGeo, M.grey, { name: 'noseStrutUpper' }));
    const lower = mergeGeometries([
      rod([1.29, 0, 0.78], [1.245, 0, 0.99], 0.026, 0.026, 12),
      beam([1.245, -0.07, 0.99], [axle[0], -0.07, axle[2]], 0.02, 0.03, [1, 0, 0]),
      beam([1.245, 0.07, 0.99], [axle[0], 0.07, axle[2]], 0.02, 0.03, [1, 0, 0]),
      beam([1.245, -0.08, 0.985], [1.245, 0.08, 0.985], 0.04, 0.03, [1, 0, 0]),
    ]);
    const w = parts.wheels[0];
    const steer = new THREE.Group(); // Lenkung um die Federbeinachse
    const pivotP = NOSE_PIVOT;
    steer.position.copy(pivotP);
    lower.translate(-pivotP.x, -pivotP.y, -pivotP.z);
    steer.add(mesh(lower, M.chrome, { name: 'noseStrutLower' }));
    w.leg.remove(w.wheel);
    w.wheel.position.sub(pivotP);
    w.base = w.wheel.position.clone();
    steer.add(w.wheel);
    w.leg.add(steer);
    w.steer = steer;
  }

  // --- Details: Antennen, Tankdeckel, Stufe, Leuchtenhalter
  darkStatic.push(rod([-1.9, 0, fZt(-1.9) + 0.02], [-2.05, 0, fZt(-1.9) - 0.32], 0.006, 0.004, 6));
  darkStatic.push(rod([-2.6, 0, fZt(-2.6) + 0.02], [-2.72, 0, fZt(-2.6) - 0.26], 0.006, 0.004, 6));
  for (const s of [1, -1]) {
    darkStatic.push(rod([-4.5, 0, -1.5], [-4.3, s * 0.45, -1.42], 0.005, 0.004, 6)); // VOR-Antenne
    const fc = wingPoint(s * 2.2, 0.35, 0.09);
    darkStatic.push(rod([fc[0], fc[1], fc[2] + 0.01], [fc[0], fc[1], fc[2] - 0.012], 0.035, 0.035, 14));
    darkStatic.push(beam([-0.05, s * 0.56, 0.33], [-0.05, s * 0.72, 0.36], 0.02, 0.08, [1, 0, 0])); // Einstiegsstufe
  }
  darkStatic.push(rod([-4.45, 0, 0.18], [-4.45, 0, 0.27], 0.02, 0.012, 8)); // Heck-Schleifsporn

  group.add(mesh(mergeGeometries(whiteStatic), M.white, { name: 'airframe' }));
  group.add(mesh(mergeGeometries(darkStatic), M.dark, { name: 'details' }));

  // --- Lichter
  const glowTex = glowTexture(64);
  const mkGlow = (color, size) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    }));
    s.scale.set(size, size, size);
    s.visible = false;
    s.renderOrder = 3;
    return s;
  };
  const tipL = wingPoint(-5.46, 0.12, 0.0), tipR = wingPoint(5.46, 0.12, 0.0);
  const lamp = (color, p) => {
    const m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: color, emissiveIntensity: 0.0, roughness: 0.3 });
    const g = new THREE.SphereGeometry(0.025, 10, 8);
    const mm = mesh(g, m, { cast: false, name: 'lamp' });
    mm.position.copy(B(...p));
    group.add(mm);
    return mm;
  };
  const lights = {
    navL: { lamp: lamp(0xff1a10, [tipL[0], tipL[1] - 0.03, tipL[2]]), glow: mkGlow(0xff2a1a, 0.5) },
    navR: { lamp: lamp(0x19ff4a, [tipR[0], tipR[1] + 0.03, tipR[2]]), glow: mkGlow(0x30ff60, 0.5) },
    tail: { lamp: lamp(0xffffff, [-5.13, 0, -1.3]), glow: mkGlow(0xffffff, 0.4) },
    strobeL: { glow: mkGlow(0xeaf2ff, 1.6), pos: [tipL[0] - 0.08, tipL[1] - 0.03, tipL[2]] },
    strobeR: { glow: mkGlow(0xeaf2ff, 1.6), pos: [tipR[0] - 0.08, tipR[1] + 0.03, tipR[2]] },
    beacon: { lamp: lamp(0xff2010, [-4.64, 0, -1.6]), glow: mkGlow(0xff3020, 0.9) },
    landing: { glow: mkGlow(0xfff4dd, 1.2), pos: [WING_LE + 0.01, -2.35, wingZ(2.35) + 0.03] },
  };
  for (const k of Object.keys(lights)) {
    const l = lights[k];
    const p = l.pos || [-l.lamp.position.z, l.lamp.position.x, -l.lamp.position.y];
    l.glow.position.copy(B(...p));
    group.add(l.glow);
  }
  // Landescheinwerfer-Linse + Spotlicht
  {
    const g = new THREE.CircleGeometry(0.055, 18);
    g.rotateY(Math.PI);
    const p = B(...lights.landing.pos);
    g.translate(p.x, p.y, p.z);
    lights.landing.lens = mesh(g, M.lens, { cast: false, name: 'landingLens' });
    group.add(lights.landing.lens);
    const spot = new THREE.SpotLight(0xfff1dc, 0, 900, 0.2, 0.55, 1.3);
    spot.position.copy(p);
    spot.target.position.copy(B(60, -2.35, 6));
    spot.layers.enableAll();
    group.add(spot, spot.target);
    lights.landing.spot = spot;
  }
  parts.lights = lights;

  // ---------------------------------------------------------------- Animation
  const setHinge = (pivot, deg) => {
    pivot.quaternion.setFromAxisAngle(pivot.userData.axis, deg * D);
  };
  let ghost = 0;
  const sunLocal = new THREE.Vector3();

  /**
   * Modell an den Physikzustand anpassen.
   * opts: { time, dt, lights: {nav, strobe, beacon, landing}, darkness 0..1, sunLocal (Vector3, lokale Achsen) }
   */
  function update(s, ctl, opts = {}) {
    const dt = opts.dt ?? 0;
    // Ruderflächen (Vorzeichen: siehe Kommentar in hinge(): Achse +x lokal, +Winkel = Hinterkante runter)
    setHinge(parts.elevator, -s.elevatorDeg);
    setHinge(parts.trimTab, s.trimDeg); // Nase-hoch-Trimm: Tab-Hinterkante runter
    setHinge(parts.aileronR, -s.aileronDeg);
    setHinge(parts.aileronL, s.aileronDeg);
    parts.rudder.quaternion.setFromAxisAngle(parts.rudder.userData.axis, s.rudderDeg * D); // Achse ≈ +y: + = Hinterkante rechts
    // Klappen: Drehung + Fowler-Weg nach hinten/unten
    const f = s.flapsDeg;
    for (const fl of [parts.flapL, parts.flapR]) {
      setHinge(fl, f);
      const t = f / 30;
      fl.position.copy(fl.userData.base);
      fl.position.z += 0.1 * t;
      fl.position.y -= 0.025 * t;
    }

    // Propeller: Blätter bis 600 RPM, darüber Blur-Scheibe
    parts.prop.rotation.z = -s.propAngle;
    const blur = s.rpm >= 600;
    parts.propBlades.visible = !blur;
    parts.propDisc.visible = blur;
    if (blur) {
      const u = discMat.uniforms;
      u.uOpacity.value = lerp(0.55, 0.26, clamp((s.rpm - 600) / 2100, 0, 1));
      ghost += dt * (0.8 + s.rpm / 3000);
      u.uGhost.value = ghost % (2 * Math.PI);
      if (opts.sunLocal) {
        sunLocal.copy(opts.sunLocal);
        u.uSun.value.set(sunLocal.x, sunLocal.y, 0);
        u.uGlint.value = clamp(Math.hypot(sunLocal.x, sunLocal.y) * 1.2, 0, 1) * clamp(opts.sunUp ?? 1, 0, 1) * 0.3;
      }
    }

    // Räder: Einfederung (entlang Body-z) und Rotation; Bugrad-Lenkung am Boden
    for (let i = 0; i < 3; i++) {
      const w = parts.wheels[i];
      w.spin.rotation.x = -s.wheelSpin[i];
      if (i === 0) continue;
      w.wheel.position.copy(w.base);
      w.wheel.position.y += s.gearCompression[i];
    }
    // Bugrad: unteres Federbein + Rad fahren ein, Lenkung über das Seitenruder nur mit Bodenkontakt
    const nose = parts.wheels[0];
    const steerDeg = s.wheelContact[0] ? clamp(ctl.rudder, -1, 1) * C172.controls.noseSteer : 0;
    nose.steer.rotation.y = -steerDeg * D;
    nose.steer.position.y = NOSE_PIVOT.y + s.gearCompression[0];

    // Lichter
    const L = opts.lights || {};
    const dark = clamp(opts.darkness ?? 0, 0, 1);
    const t = opts.time ?? s.time;
    const glowScale = 0.25 + 0.75 * dark;
    const setLamp = (l, on, k = 1) => {
      if (l.lamp) l.lamp.material.emissiveIntensity = on ? 2.5 * k : 0;
      l.glow.visible = on;
      l.glow.material.opacity = glowScale * k;
    };
    setLamp(lights.navL, !!L.nav);
    setLamp(lights.navR, !!L.nav);
    setLamp(lights.tail, !!L.nav);
    const strobeOn = !!L.strobe && t % 1.1 < 0.06;
    setLamp(lights.strobeL, strobeOn, 1.4);
    setLamp(lights.strobeR, strobeOn && t % 1.1 < 0.06, 1.4);
    const bcn = (t * 1.1) % 1;
    setLamp(lights.beacon, !!L.beacon && bcn < 0.14, 1);
    lights.landing.glow.visible = !!L.landing;
    lights.landing.glow.material.opacity = glowScale;
    lights.landing.lens.material.emissive.setHex(L.landing ? 0xfff1dc : 0x000000);
    lights.landing.lens.material.emissiveIntensity = L.landing ? 3 : 0;
    lights.landing.spot.intensity = L.landing ? 60000 * (0.3 + 0.7 * dark) : 0;
  }

  return { group, parts, update, materials: M };
}

// kleine Vektor-Helfer (Body-Arrays)
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
