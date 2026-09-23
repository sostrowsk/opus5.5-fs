// Cockpit-Innenraum der C172P (Blick vom linken Sitz): Instrumentenbrett mit Six-Pack nach SPEC §3.7,
// Glareshield, Windschutzscheibe, A-Säulen, Türen mit Fenstern, Dachhimmel, Sitze, Yoke, Gas/Gemisch,
// Klappenschalter mit Anzeige, Trimmrad, Zündschloss, Lichtschalter, Parkbremse, Pedale, Magnetkompass.
// Opake Teile liegen auf Layer 1, Gläser auf Layer 2 (Zwei-Pass-Rendering, PLAN §2.4).
// Alle Maße in Body-Koordinaten (x vorn, y rechts, z unten; Ursprung Schwerpunkt).
import * as THREE from 'three';
import { B, beam, rod, extrudeXZ, extrudeYZ, mergeGeometries, mesh } from '../aircraft/shapes.js';
import { fuselageHalfWidth, fuselageTop, fuselageBottom, getFuselage, pointInPoly, nearestOnPoly } from '../aircraft/model.js';
import { cellUV, CELLS, RADIO_PX_PER_M } from './instruments.js';
import { clamp } from '../sim/math.js';

const D = Math.PI / 180;

/** Pilotenauge (Body): 0,76 m hinter dem Panel, 0,12 m über der Glareshield-Oberkante. */
export const EYE = [0.0, -0.27, -0.45];
export const PANEL_X = 0.76;
const PANEL_Y = 0.515; // halbe Breite (innerhalb der Rumpfhaut)
const PANEL_TOP = -0.3;
const PANEL_BOT = 0.14;
const DIAL_X = 0.774; // Zifferblatt 14 mm hinter der Panelfront (vom Auge aus weiter weg)
export const R_MAIN = 0.047; // sichtbarer Zifferblatt-Radius Six-Pack (Ø 94 mm)
const R_SMALL = 0.029;

/** Instrumente: Mittelpunkt (Body y, z) und Radius. Layout verbindlich nach SPEC §3.7. */
const ROW1 = -0.228, ROW2 = -0.12;
export const INSTRUMENTS = {
  asi: { y: -0.382, z: ROW1, r: R_MAIN },
  ai: { y: -0.271, z: ROW1, r: R_MAIN },
  alt: { y: -0.16, z: ROW1, r: R_MAIN },
  tc: { y: -0.382, z: ROW2, r: R_MAIN },
  hi: { y: -0.271, z: ROW2, r: R_MAIN },
  vsi: { y: -0.16, z: ROW2, r: R_MAIN },
  tach: { y: -0.049, z: ROW2, r: R_MAIN },
  egt: { y: -0.049, z: ROW1, r: R_SMALL },
  clock: { y: -0.478, z: ROW1, r: R_SMALL },
  suction: { y: -0.478, z: ROW2, r: R_SMALL },
  fuel: { y: 0.218, z: ROW1, r: R_SMALL },
  oil: { y: 0.218, z: ROW2, r: R_SMALL },
  amp: { y: 0.28, z: ROW1, r: R_SMALL },
};
const RADIO_Y0 = 0.012;
const RADIOS = [
  // Name, Oberkante z (Body); Höhe aus der Atlaszelle (3200 px/m)
  ['audio', -0.287],
  ['com1', -0.257],
  ['com2', -0.203],
  ['xpdr', -0.149],
];
const radioSize = (name) => [CELLS[name][2] / RADIO_PX_PER_M, CELLS[name][3] / RADIO_PX_PER_M];

// Bedienelemente (Body y, z an der Panelfront)
const CTRL = {
  throttle: { y: -0.012, z: 0.035 },
  carb: { y: -0.075, z: 0.035 },
  mixture: { y: 0.047, z: 0.035 },
  flap: { y: 0.118, zTop: -0.072, zBot: 0.058 },
  key: { y: -0.476, z: 0.05 },
  master: { y: -0.43, z: 0.05 },
  rockers: { y0: -0.385, dy: 0.034, z: 0.052, names: ['BCN', 'LAND', 'TAXI', 'NAV', 'STROBE'] },
  park: { y: -0.33, z: 0.128 },
  yokeY: [-0.271, 0.271],
  yokeZ: -0.056,
  yokeX: 0.56,
  trim: { x: 0.6, y: 0.0, z: 0.39, r: 0.075 },
};

// ------------------------------------------------------------------ Panel-Textur (statisch)
const PT_W = 2048, PT_H = 1024;
const PT_S = PT_W / (2 * PANEL_Y); // px pro m
const ptX = (y) => (y + PANEL_Y) * PT_S;
const ptY = (z) => (z - PANEL_TOP) * PT_S;

function panelTexture() {
  const c = document.createElement('canvas');
  c.width = PT_W;
  c.height = PT_H;
  const x = c.getContext('2d', { willReadFrequently: true });
  // Grundfarbe mit leichtem Verlauf und Struktur
  const g = x.createLinearGradient(0, 0, 0, ptY(PANEL_BOT));
  g.addColorStop(0, '#55585d');
  g.addColorStop(1, '#484a4e');
  x.fillStyle = g;
  x.fillRect(0, 0, PT_W, PT_H);
  const img = x.getImageData(0, 0, PT_W, 900);
  const d = img.data;
  let seed = 7;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed >>> 24) - 128) * 0.035;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  // Trennlinie Pilotenseite / Mitte / Copilot (Blenden)
  x.strokeStyle = 'rgba(0,0,0,0.45)';
  x.lineWidth = 3;
  for (const yy of [-0.012, 0.31]) {
    x.beginPath();
    x.moveTo(ptX(yy), 0);
    x.lineTo(ptX(yy), ptY(0.0));
    x.stroke();
  }
  const label = (s, y, z, size = 18, color = '#e9e6dc', weight = '700') => {
    x.font = `${weight} ${size}px ui-sans-serif, system-ui, Arial, sans-serif`;
    x.fillStyle = color;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(s, ptX(y), ptY(z));
  };
  const screw = (y, z) => {
    const px = ptX(y), py = ptY(z);
    const gr = x.createRadialGradient(px - 2, py - 2, 1, px, py, 7);
    gr.addColorStop(0, '#6a6d70');
    gr.addColorStop(1, '#141516');
    x.beginPath();
    x.arc(px, py, 7, 0, Math.PI * 2);
    x.fillStyle = gr;
    x.fill();
    x.strokeStyle = '#0b0b0b';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(px - 5, py + 2);
    x.lineTo(px + 5, py - 2);
    x.stroke();
  };
  // Instrumenten-Schrauben (Diagonalmuster) + Schattenring
  for (const k of Object.keys(INSTRUMENTS)) {
    const I = INSTRUMENTS[k];
    const o = I.r * 0.93;
    for (const [sy, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) screw(I.y + sy * o, I.z + sz * o);
    x.beginPath();
    x.arc(ptX(I.y), ptY(I.z), (I.r + 0.009) * PT_S, 0, Math.PI * 2);
    x.strokeStyle = 'rgba(0,0,0,0.35)';
    x.lineWidth = 6;
    x.stroke();
  }
  // Beschriftungen
  const ro = CTRL.rockers;
  ro.names.forEach((n, i) => label(n, ro.y0 + i * ro.dy, ro.z + 0.03, 15));
  label('MASTER', CTRL.master.y, CTRL.master.z + 0.03, 15);
  label('BAT ALT', CTRL.master.y, CTRL.master.z - 0.027, 13, '#cfcac0', '600');
  label('OFF  R  L  BOTH  START', CTRL.key.y + 0.004, CTRL.key.z - 0.031, 11);
  label('THROTTLE', CTRL.throttle.y, CTRL.throttle.z + 0.035, 15);
  label('MIXTURE', CTRL.mixture.y, CTRL.mixture.z + 0.035, 15);
  label('CARB HEAT', CTRL.carb.y, CTRL.carb.z + 0.035, 15);
  label('PARKING BRAKE', CTRL.park.y, CTRL.park.z - 0.028, 12);
  label('FLAPS', CTRL.flap.y - 0.024, CTRL.flap.zTop - 0.018, 15);
  const fl = CTRL.flap;
  ['0°', '10°', '20°', 'FULL'].forEach((s, i) => {
    const z = fl.zTop + (i / 3) * (fl.zBot - fl.zTop);
    label(s, fl.y - 0.034, z, 13);
    x.fillStyle = '#e9e6dc';
    x.fillRect(ptX(fl.y - 0.022), ptY(z) - 1.5, 14, 3);
  });
  // Klappenschlitz
  x.fillStyle = '#0b0b0b';
  x.fillRect(ptX(fl.y) - 7, ptY(fl.zTop) - 6, 14, (fl.zBot - fl.zTop) * PT_S + 12);
  // Glovebox, Sicherungsautomaten, Placards
  x.strokeStyle = 'rgba(0,0,0,0.6)';
  x.lineWidth = 4;
  const gb = [ptX(0.335), ptY(-0.05), (0.5 - 0.335) * PT_S, 0.13 * PT_S];
  x.strokeRect(...gb);
  x.fillStyle = 'rgba(0,0,0,0.12)';
  x.fillRect(...gb);
  x.fillStyle = '#1a1a1a';
  x.fillRect(ptX(0.405), ptY(-0.052) - 18, 0.035 * PT_S, 14);
  for (let i = 0; i < 9; i++) {
    const cy = 0.305 + i * 0.024;
    const px = ptX(cy), py = ptY(0.115);
    x.beginPath();
    x.arc(px, py, 11, 0, Math.PI * 2);
    x.fillStyle = '#121212';
    x.fill();
    x.beginPath();
    x.arc(px, py, 6, 0, Math.PI * 2);
    x.fillStyle = '#cfcfcf';
    x.fill();
    label(String([5, 5, 10, 15, 5, 20, 10, 5, 2][i]), cy, 0.094, 11);
  }
  label('CIRCUIT BREAKERS', 0.4, 0.075, 12);
  const plac = [
    'THIS AIRPLANE MUST BE OPERATED IN THE',
    'NORMAL CATEGORY IN COMPLIANCE WITH THE',
    'OPERATING LIMITATIONS IN THE POH.',
    'NO ACROBATIC MANEUVERS INCLUDING SPINS',
  ];
  x.fillStyle = '#d9d4c5';
  x.fillRect(ptX(0.34), ptY(-0.29), 0.16 * PT_S, 0.05 * PT_S);
  plac.forEach((s, i) => label(s, 0.42, -0.281 + i * 0.011, 9.5, '#1a1a1a', '700'));
  label('MANEUVERING SPEED 99 KIAS', 0.42, -0.225, 13, '#e9e6dc');
  label('C172 WEB', 0.42, -0.2, 13, '#8f8b82');
  label('XTAL', -0.478, -0.18, 14, '#bfbab0');
  label('VACUUM', -0.478, -0.075, 11, '#bfbab0');
  label('MODEL 172P', -0.27, 0.105, 16, '#b8b3a8', '700');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Leichte Spiegelung für Instrumentengläser (weicher Diagonal-Lichtreflex). */
function glassTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  const g = x.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.32, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.0)');
  g.addColorStop(1, 'rgba(255,255,255,0.03)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  x.beginPath();
  x.ellipse(s * 0.32, s * 0.24, s * 0.22, s * 0.07, -0.6, 0, Math.PI * 2);
  x.fillStyle = 'rgba(255,255,255,0.18)';
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Windschutzscheibe: kaum sichtbare Kratzer/Schlieren + Randverdunkelung. */
function windshieldTexture() {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.clearRect(0, 0, s, s);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  x.strokeStyle = 'rgba(255,255,255,0.10)';
  x.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const cx = rnd() * s, cy = rnd() * s, r = 30 + rnd() * 140, a = rnd() * 6.28;
    x.beginPath();
    x.arc(cx, cy, r, a, a + 0.3 + rnd() * 0.6);
    x.stroke();
  }
  const g = x.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.72);
  g.addColorStop(0, 'rgba(120,130,140,0)');
  g.addColorStop(1, 'rgba(120,130,140,0.16)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Kreisscheibe in der Panel-Ebene (Normal nach hinten zum Piloten), UV auf Atlaszelle. */
function dialDisc(I, x, r, cell) {
  const g = new THREE.CircleGeometry(r, 48);
  const uv = g.attributes.uv;
  if (cell) {
    const { u0, u1, v0, v1 } = cellUV(cell);
    // Die Zelle bildet genau den Zifferblattkreis ab (Zellenrand = Kreisrand)
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  const p = B(x, I.y, I.z);
  g.translate(p.x, p.y, p.z);
  return g;
}
/** Rechteck in der Panel-Ebene mit Atlas-UV. */
function panelQuad(y0, z0, w, h, x, cell) {
  const g = new THREE.PlaneGeometry(w, h);
  if (cell) {
    const { u0, u1, v0, v1 } = cellUV(cell);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  const p = B(x, y0 + w / 2, z0 + h / 2);
  g.translate(p.x, p.y, p.z);
  return g;
}
/** Achse entlang Body-x (für Knöpfe): Zylinder vom Panel nach hinten. */
const knobRod = (y, z, x0, x1, r, seg = 16) => rod([x0, y, z], [x1, y, z], r, r, seg);

// ------------------------------------------------------------------ Kabinenschale (Hilfsfunktionen)
const INSET = 0.018; // Verkleidung liegt so weit innerhalb der Außenhaut
const ROOF_GAP = 0.03; // Dachhimmel unter der Rumpf-Oberkante
const FLOOR_Z = 0.5;
const WS_BASE = [1.05, -0.285], WS_TOP = [0.44, -0.84]; // Windschutzscheibe unten/oben (x, z) an der A-Säule
/** Fensteröffnungen in den Seitenwänden (Body x, z) – etwas kleiner als DOOR_WINDOW/REAR_WINDOW der Außenhaut. */
const DOOR = [[0.44, -0.79], [0.815, -0.3], [0.815, -0.24], [-0.605, -0.24], [-0.605, -0.79]];
const REAR = [[-0.755, -0.78], [-0.755, -0.29], [-1.335, -0.46], [-1.335, -0.77]];
const hwIn = (x, z) => Math.max(0, fuselageHalfWidth(x, z) - INSET);
/** A-Säulen-Linie: an der oberen Rumpfkante (Übergang Scheibe → Seitenwand), ca. 5 cm unter der Oberkante. */
const pillarZ = (x) => fuselageTop(x) + 0.05;

/** Indiziertes Raster → BufferGeometry; Normalen zeigen in Richtung wantDir (lokaler Vektor). */
function gridGeometry(P, UV, idx, wantDir) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;
  let s = 0;
  for (let i = 0; i < n.count; i++) s += n.getX(i) * wantDir.x + n.getY(i) * wantDir.y + n.getZ(i) * wantDir.z;
  if (s < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}
/** Seitenwand einer Rumpfseite (side = −1 links, +1 rechts) mit Fensteröffnungen (Kanten eingerastet). */
function shellWall(side, holes) {
  const X0 = 1.04, X1 = -1.99, DX = 0.025, NZ = 52;
  const nx = Math.round((X0 - X1) / DX);
  const zTop = (x) => (x > WS_TOP[0] ? pillarZ(x) + 0.01 : x < -1.3 ? fuselageTop(x) + 0.13 : fuselageTop(x) + ROOF_GAP);
  const zBot = (x) => Math.min(FLOOR_Z, fuselageBottom(x) - 0.07);
  const P = [], UV = [], XZ = [];
  for (let i = 0; i <= nx; i++) {
    const x0 = X0 - i * DX;
    const zt = zTop(x0), zb = zBot(x0);
    for (let j = 0; j <= NZ; j++) {
      let x = x0, z = zt + ((zb - zt) * j) / NZ;
      for (const h of holes) {
        const q = nearestOnPoly(h, x, z);
        if (q.d < 0.55 * DX) {
          x = q.x;
          z = q.z;
        }
      }
      const p = B(x, side * hwIn(x, z), z);
      P.push(p.x, p.y, p.z);
      UV.push(x, z);
      XZ.push([x, z]);
    }
  }
  const idx = [];
  const W = NZ + 1;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < NZ; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
      const cx = (XZ[a][0] + XZ[b][0] + XZ[c][0] + XZ[d][0]) / 4, cz = (XZ[a][1] + XZ[b][1] + XZ[c][1] + XZ[d][1]) / 4;
      if (holes.some((h) => pointInPoly(h, cx, cz))) continue;
      idx.push(a, b, c, b, d, c);
    }
  }
  return gridGeometry(P, UV, idx, new THREE.Vector3(-side, 0, 0));
}
/** Horizontale Fläche (Dach bzw. Boden) über x ∈ [x0, x1] in der Höhe zFn(x), Breite = Innenkontur; normalZ = Body-z der Normale. */
function shellStrip(x0, x1, nx, ny, zFn, normalZ) {
  const P = [], UV = [], idx = [];
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx, z = zFn(x), w = hwIn(x, z);
    for (let j = 0; j <= ny; j++) {
      const y = -w + (2 * w * j) / ny;
      const p = B(x, y, z);
      P.push(p.x, p.y, p.z);
      UV.push(x, y);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const a = i * (ny + 1) + j, b = a + 1, c = a + ny + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return gridGeometry(P, UV, idx, new THREE.Vector3(0, -normalZ, 0));
}
/** Senkrechte Querwand bei x zwischen z0 (oben) und z1 (unten); normalX = Blickrichtung der Vorderseite (Body x). */
function shellBulkhead(x, z0, z1, normalX) {
  const P = [], UV = [], idx = [];
  const nz = 16, ny = 12;
  for (let j = 0; j <= nz; j++) {
    const z = z0 + ((z1 - z0) * j) / nz, w = hwIn(x, z);
    for (let i = 0; i <= ny; i++) {
      const y = -w + (2 * w * i) / ny;
      const p = B(x, y, z);
      P.push(p.x, p.y, p.z);
      UV.push(y, z);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < ny; i++) {
      const a = j * (ny + 1) + i, b = a + 1, c = a + ny + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return gridGeometry(P, UV, idx, new THREE.Vector3(0, 0, -normalX));
}

// ------------------------------------------------------------------ Aufbau
export function createCockpit(instruments) {
  const group = new THREE.Group();
  group.name = 'cockpit';
  const L1 = 1, L2 = 2;

  const std = (color, rough = 0.8, metal = 0, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, fog: false, ...extra });
  const M = {
    panel: std(0xffffff, 0.78, 0, { map: panelTexture() }),
    dark: std(0x17181a, 0.55),
    darkDouble: std(0x0c0c0d, 0.7, 0, { side: THREE.DoubleSide }),
    glare: std(0x1c1c1d, 0.9),
    yoke: std(0x1e1f21, 0.38),
    trim: std(0x80786c, 0.92), // Innenverkleidung: mattes Grau-Beige (Taupe), klar dunkler als Pistenmarkierungen draußen
    trimDark: std(0x4d4841, 0.9),
    headliner: std(0xbdb6a8, 0.95),
    carpet: std(0x3a3632, 1.0),
    seat: std(0x544a40, 0.95),
    chrome: std(0xc0c4c8, 0.25, 0.9),
    red: std(0x9a1712, 0.45),
    white: std(0xe8e6df, 0.6),
    black: std(0x0a0a0a, 0.45),
    dial: new THREE.MeshStandardMaterial({
      map: instruments.texture, roughness: 0.7, metalness: 0, fog: false,
      emissive: 0xffffff, emissiveMap: instruments.texture, emissiveIntensity: 0.06,
    }),
    radio: new THREE.MeshStandardMaterial({
      map: instruments.texture, roughness: 0.6, metalness: 0, fog: false,
      emissive: 0xffffff, emissiveMap: instruments.texture, emissiveIntensity: 0.35,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xffffff, map: glassTexture(), transparent: true, opacity: 1, roughness: 0.05, metalness: 0.0,
      depthWrite: false, fog: false,
    }),
    windshield: new THREE.MeshStandardMaterial({
      color: 0xdfe8ee, map: windshieldTexture(), transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.0,
      depthWrite: false, fog: false, side: THREE.BackSide,
    }),
    hit: new THREE.MeshBasicMaterial({ visible: false }),
  };

  const S = {}; // statische Geometrien je Material
  const add = (mat, g) => (S[mat] || (S[mat] = [])).push(g);

  // ---------------------------------------------------------------- Instrumentenbrett
  {
    const holes = [];
    for (const k of Object.keys(INSTRUMENTS)) {
      const I = INSTRUMENTS[k];
      holes.push({ circle: [I.y, I.z, I.r + 0.0015] });
    }
    for (const [name, top] of RADIOS) {
      const [w, h] = radioSize(name);
      holes.push([[RADIO_Y0, top], [RADIO_Y0, top + h], [RADIO_Y0 + w, top + h], [RADIO_Y0 + w, top]]);
    }
    const r = 0.02;
    const outline = [];
    const corner = (cy, cz, a0) => {
      for (let i = 0; i <= 4; i++) {
        const a = a0 + (i / 4) * (Math.PI / 2);
        outline.push([cy + Math.cos(a) * r, cz - Math.sin(a) * r]);
      }
    };
    corner(PANEL_Y - r, PANEL_TOP + r, 0);
    corner(-PANEL_Y + r, PANEL_TOP + r, Math.PI / 2);
    corner(-PANEL_Y + r, PANEL_BOT - r, Math.PI);
    corner(PANEL_Y - r, PANEL_BOT - r, 1.5 * Math.PI);
    const g = extrudeYZ(outline, PANEL_X, PANEL_X + 0.012, holes, 36);
    // UV der Frontfläche (Shape-Koordinaten u = y, v = −z) auf die Panel-Textur abbilden
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const y = uv.getX(i), z = -uv.getY(i);
      uv.setXY(i, ptX(y) / PT_W, 1 - ptY(z) / PT_H);
    }
    group.add(mesh(g, M.panel, { layer: L1, name: 'panel' }));
  }
  // Instrumente: Zifferblätter (Atlas), Gehäuse-Tuben, Lünetten, Gläser
  {
    const dials = [], cans = [], bezels = [], glass = [];
    for (const k of Object.keys(INSTRUMENTS)) {
      const I = INSTRUMENTS[k];
      dials.push(dialDisc(I, DIAL_X, I.r, k));
      const can = new THREE.CylinderGeometry(I.r + 0.0015, I.r + 0.0015, DIAL_X - PANEL_X + 0.001, 40, 1, true);
      can.rotateX(Math.PI / 2);
      const p = B((PANEL_X + DIAL_X) / 2, I.y, I.z);
      can.translate(p.x, p.y, p.z);
      cans.push(can);
      const ring = new THREE.RingGeometry(I.r + 0.0012, I.r + 0.0052, 40);
      const q = B(PANEL_X - 0.0006, I.y, I.z);
      ring.translate(q.x, q.y, q.z);
      bezels.push(ring);
      glass.push(dialDisc(I, PANEL_X + 0.004, I.r + 0.0015, null)); // zwischen Panelfront und Zifferblatt
    }
    // Magnetkompass-Karte im Gehäusefenster (auf dem Glareshield)
    const cw = 0.07, ch = 0.035;
    const cp = { x: 0.806, y: -0.02, z: -0.372 }; // Kartenfenster an der Rückseite des Gehäuses
    const card = panelQuad(cp.y - cw / 2, cp.z - ch / 2, cw, ch, cp.x, 'compass');
    dials.push(card);
    group.add(mesh(mergeGeometries(dials), M.dial, { layer: L1, name: 'dials' }));
    group.add(mesh(mergeGeometries(cans), M.darkDouble, { layer: L1, name: 'instrumentCans' }));
    add('black', mergeGeometries(bezels));
    const gm = mesh(mergeGeometries(glass), M.glass, { layer: L2, cast: false, receive: false, name: 'instrumentGlass' });
    group.add(gm);
    // Radios
    const radios = [];
    for (const [name, top] of RADIOS) {
      const [w, h] = radioSize(name);
      radios.push(panelQuad(RADIO_Y0, top, w, h, PANEL_X + 0.004, name));
    }
    group.add(mesh(mergeGeometries(radios), M.radio, { layer: L1, name: 'radios' }));
    // Kompassgehäuse
    add('dark', beam([cp.x + 0.034, cp.y, -0.312], [cp.x + 0.034, cp.y, -0.397], 0.09, 0.064, [1, 0, 0]));
    add('black', beam([cp.x + 0.06, cp.y, -0.397], [cp.x + 0.06, cp.y, -0.41], 0.02, 0.02, [1, 0, 0]));
  }

  // ---------------------------------------------------------------- Glareshield (gepolstert, Nase zum Piloten)
  {
    // Der Teil unterhalb der Panel-Oberkante liegt HINTER dem Panel (x ≥ Panel-Rückseite + 3 mm): eine Fläche
    // bei x = PANEL_X wäre koplanar mit der Panelfront (Z-Fighting → gezackte schwarze Splitter über der
    // oberen Instrumentenreihe, dem Audio-Panel und dem Placard).
    const xb = PANEL_X + 0.015;
    const prof = [
      [0.726, -0.3], [0.714, -0.307], [0.716, -0.318], [0.735, -0.326], [0.8, -0.33],
      [0.9, -0.322], [1.0, -0.3], [1.055, -0.284], [1.055, -0.26], [xb, -0.26], [xb, -0.3],
    ];
    const g = extrudeXZ(prof, -PANEL_Y + 0.005, PANEL_Y - 0.005);
    // Ecken an die Rumpfkontur anpassen (unter der Scheibenwölbung)
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const bx = -p.getZ(i), bz = -p.getY(i);
      const w = hwIn(bx, bz - 0.004) - 0.004;
      if (Math.abs(p.getX(i)) > w) p.setX(i, Math.sign(p.getX(i)) * Math.max(0, w));
    }
    g.computeVertexNormals();
    add('glare', g);
  }

  // ---------------------------------------------------------------- Kabinenschale (folgt der Außenhaut)
  // Seitenwände, Dachhimmel, Boden, Brandschott und Gepäckraum-Trennwand liegen INSET innerhalb der Haut,
  // damit von außen nichts durchsticht und die Dachkanten der Rumpfrundung folgen.
  {
    for (const s of [-1, 1]) add('trim', shellWall(s, [DOOR, REAR]));
    add('headliner', shellStrip(0.43, -1.3, 70, 18, (x) => fuselageTop(x) + ROOF_GAP, 1)); // Normale nach unten
    add('carpet', shellStrip(1.0, -2.0, 60, 18, (x) => Math.min(FLOOR_Z, fuselageBottom(x) - 0.07), -1)); // Normale nach oben
    add('dark', shellBulkhead(0.995, PANEL_BOT - 0.01, FLOOR_Z + 0.005, -1)); // Brandschott unter dem Panel
    add('trim', shellBulkhead(-1.99, fuselageTop(-1.99) + 0.13, Math.min(FLOOR_Z, fuselageBottom(-1.99) - 0.07), 1));
    for (const s of [-1, 1]) {
      // A-Säule (Rohr entlang der Scheibenkante, folgt der Haut)
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const x = WS_BASE[0] + ((WS_TOP[0] - WS_BASE[0]) * i) / 12, z = pillarZ(x);
        pts.push(B(x, s * (hwIn(x, z) - 0.014), z + 0.006));
      }
      add('trimDark', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.019, 10, false));
      // Gummidichtung um Tür- und hinteres Seitenfenster
      for (const poly of [DOOR, REAR]) {
        const sp = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.03));
          for (let k = 0; k < n; k++) {
            const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
            sp.push(B(x, s * (hwIn(x, z) - 0.004), z));
          }
        }
        add('black', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sp, true, 'catmullrom', 0.2), sp.length * 2, 0.008, 6, true));
      }
      // Frischluftdüse (Flügelwurzel)
      add('dark', rod([0.36, s * 0.44, -0.8], [0.33, s * 0.43, -0.765], 0.022, 0.018, 14));
      add('chrome', rod([0.33, s * 0.43, -0.765], [0.322, s * 0.43, -0.752], 0.012, 0.012, 10));
      // Armlehne, Türgriff, Kartentasche
      add('trimDark', beam([0.3, s * (hwIn(0, -0.06) - 0.024), -0.06], [-0.45, s * (hwIn(0, -0.06) - 0.024), -0.06], 0.05, 0.045, [0, 0, -1]));
      add('dark', beam([-0.3, s * (hwIn(0, -0.14) - 0.012), -0.14], [-0.14, s * (hwIn(0, -0.14) - 0.012), -0.14], 0.02, 0.022, [0, 0, -1]));
      add('trimDark', beam([0.35, s * (hwIn(0, 0.22) - 0.01), 0.22], [-0.35, s * (hwIn(0, 0.22) - 0.01), 0.22], 0.016, 0.16, [0, 0, -1]));
      // Sonnenblende (hochgeklappt unter dem Dachhimmel)
      const zv = fuselageTop(0.33) + ROOF_GAP + 0.008;
      add('trim', beam([0.33, s * 0.1, zv], [0.33, s * 0.44, zv], 0.14, 0.006, [0, 0, -1]));
    }
    // Querträger über der Scheibe (Dachvorderkante)
    {
      const z = fuselageTop(0.43) + ROOF_GAP + 0.012, w = hwIn(0.43, z) - 0.01;
      add('trimDark', rod([0.43, -w, z], [0.43, w, z], 0.024, 0.024, 12));
    }
    // Dachhimmel-Nähte
    for (const xx of [-0.2, -0.8]) {
      const z = fuselageTop(xx) + ROOF_GAP - 0.003, w = hwIn(xx, z + 0.01) - 0.01;
      add('trimDark', beam([xx, -w, z], [xx, w, z], 0.012, 0.004, [0, 0, -1]));
    }
    // Innenseite aller Fenster (Glas der Außenhaut, von innen gesehen): leichte Schlieren
    const glass = mesh(getFuselage().glass, M.windshield, { layer: L2, cast: false, receive: false, name: 'windowGlassInside' });
    group.add(glass);
  }

  // ---------------------------------------------------------------- Mittelkonsole, Sitze
  add('trimDark', beam([PANEL_X + 0.02, -0.075, 0.14], [0.52, -0.075, FLOOR_Z], 0.02, 0.2, [1, 0, 0])); // Konsole links
  add('trimDark', beam([PANEL_X + 0.02, 0.075, 0.14], [0.52, 0.075, FLOOR_Z], 0.02, 0.2, [1, 0, 0])); // rechts
  add('trimDark', beam([PANEL_X, 0, 0.14], [0.52, 0, FLOOR_Z], 0.15, 0.02, [0, 0, -1])); // Deckel (mit Trimmrad-Schlitz)
  add('dark', rod([0.46, 0, FLOOR_Z], [0.46, 0, FLOOR_Z - 0.03], 0.045, 0.045, 18)); // Tankwahlschalter
  add('red', beam([0.46, -0.03, FLOOR_Z - 0.035], [0.46, 0.03, FLOOR_Z - 0.035], 0.02, 0.012, [0, 0, -1]));
  for (const s of [-1, 1]) {
    const y = s * 0.26;
    add('seat', beam([-0.05, y, 0.25], [-0.52, y, 0.25], 0.42, 0.1, [0, 0, -1])); // Sitzkissen
    add('seat', beam([-0.5, y, 0.22], [-0.66, y, -0.42], 0.42, 0.1, [1, 0, 0])); // Lehne
    add('dark', beam([-0.1, y - 0.19, FLOOR_Z - 0.02], [-0.5, y - 0.19, FLOOR_Z - 0.02], 0.03, 0.04, [0, 0, -1])); // Sitzschienen
    add('dark', beam([-0.1, y + 0.19, FLOOR_Z - 0.02], [-0.5, y + 0.19, FLOOR_Z - 0.02], 0.03, 0.04, [0, 0, -1]));
    add('dark', beam([-0.3, y, FLOOR_Z - 0.02], [-0.3, y, 0.31], 0.3, 0.05, [1, 0, 0]));
  }
  add('seat', beam([-0.85, 0, 0.28], [-1.3, 0, 0.28], 0.94, 0.1, [0, 0, -1])); // Rückbank
  add('seat', beam([-1.3, 0, 0.26], [-1.4, 0, -0.35], 0.94, 0.1, [1, 0, 0]));

  // ---------------------------------------------------------------- Statische Bedienelemente
  // Knöpfe Gemisch & Vergaservorwärmung (fest), Primer, Kabinenluft
  add('chrome', knobRod(CTRL.carb.y, CTRL.carb.z, PANEL_X, PANEL_X - 0.02, 0.004));
  add('trimDark', knobRod(CTRL.carb.y, CTRL.carb.z, PANEL_X - 0.02, PANEL_X - 0.04, 0.014, 20));
  add('chrome', knobRod(CTRL.mixture.y, CTRL.mixture.z, PANEL_X, PANEL_X - 0.012, 0.004));
  add('red', knobRod(CTRL.mixture.y, CTRL.mixture.z, PANEL_X - 0.012, PANEL_X - 0.036, 0.016, 12));
  for (const [y, z] of [[0.3, 0.1], [0.36, 0.1]]) {
    add('chrome', knobRod(y, z, PANEL_X, PANEL_X - 0.015, 0.004));
    add('black', knobRod(y, z, PANEL_X - 0.015, PANEL_X - 0.03, 0.012, 16));
  }
  // Gashebel-Führung (Buchse), Klappenschalter-Kulisse, Zündschloss-Rosette
  add('black', knobRod(CTRL.throttle.y, CTRL.throttle.z, PANEL_X + 0.002, PANEL_X - 0.006, 0.009, 16));
  add('chrome', knobRod(CTRL.key.y, CTRL.key.z, PANEL_X + 0.002, PANEL_X - 0.006, 0.017, 24));
  add('black', knobRod(CTRL.key.y, CTRL.key.z, PANEL_X - 0.006, PANEL_X - 0.01, 0.011, 24));
  // Hauptschalter (rot, zweiteilig)
  add('red', beam([PANEL_X - 0.012, CTRL.master.y - 0.009, CTRL.master.z], [PANEL_X - 0.012, CTRL.master.y - 0.001, CTRL.master.z], 0.03, 0.024, [1, 0, 0]));
  add('red', beam([PANEL_X - 0.012, CTRL.master.y + 0.001, CTRL.master.z], [PANEL_X - 0.012, CTRL.master.y + 0.009, CTRL.master.z], 0.03, 0.024, [1, 0, 0]));
  // Kollsman- und HI-Knopf, Uhr-/Horizont-Knöpfe
  const knobs = [];
  for (const [k, dy, dz] of [['alt', -0.04, 0.04], ['hi', -0.04, 0.04], ['ai', 0, 0.05], ['clock', -0.023, 0.023]]) {
    const I = INSTRUMENTS[k];
    knobs.push(knobRod(I.y + dy, I.z + dz, PANEL_X, PANEL_X - 0.018, 0.009, 18));
  }
  add('black', mergeGeometries(knobs));
  // Pedal-Hebel (statischer Teil) und Brandschott-Pedalbock
  for (const y of [-0.38, -0.16, 0.16, 0.38]) add('dark', beam([0.99, y, 0.2], [0.99, y, 0.28], 0.03, 0.03, [1, 0, 0]));

  // ---------------------------------------------------------------- Animierte Teile
  const parts = {};
  const animated = (name, geosByMat, pivot, layer = L1) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.copy(pivot);
    for (const [mat, list] of Object.entries(geosByMat)) {
      const merged = mergeGeometries(list);
      merged.translate(-pivot.x, -pivot.y, -pivot.z);
      g.add(mesh(merged, M[mat], { layer, name: name + '_' + mat }));
    }
    group.add(g);
    g.userData.base = g.position.clone();
    parts[name] = g;
    return g;
  };

  // Yokes (Pilot & Copilot): Säule gleitet längs Body-x, Horn dreht um die Säulenachse
  parts.yokes = [];
  for (const yy of CTRL.yokeY) {
    const hubX = CTRL.yokeX, zc = CTRL.yokeZ;
    const pts = [
      [-0.14, 0.118], [-0.15, 0.07], [-0.145, 0.02], [-0.12, -0.025], [-0.07, -0.045], [0, -0.048],
      [0.07, -0.045], [0.12, -0.025], [0.145, 0.02], [0.15, 0.07], [0.14, 0.118],
    ];
    const curve = new THREE.CatmullRomCurve3(pts.map(([u, v]) => B(hubX - 0.01 - Math.abs(u) * 0.12, yy + u, zc - v)));
    const horn = new THREE.TubeGeometry(curve, 64, 0.016, 10, false);
    const grips = [];
    for (const s of [-1, 1]) {
      // Griffmulden (dicker) an den Hornenden
      const c2 = new THREE.CatmullRomCurve3([[s * 0.15, 0.07], [s * 0.145, 0.1], [s * 0.14, 0.118], [s * 0.132, 0.13]].map(([u, v]) => B(hubX - 0.01 - Math.abs(u) * 0.12, yy + u, zc - v)));
      grips.push(new THREE.TubeGeometry(c2, 12, 0.021, 10, false));
    }
    const plate = beam([hubX - 0.004, yy - 0.05, zc - 0.004], [hubX - 0.004, yy + 0.05, zc - 0.004], 0.04, 0.03, [0, 0, -1]);
    const hub = rod([hubX + 0.01, yy, zc], [hubX - 0.02, yy, zc], 0.03, 0.028, 20);
    const shaft = rod([PANEL_X + 0.05, yy, zc], [hubX, yy, zc], 0.013, 0.013, 16);
    const logo = beam([hubX - 0.0245, yy - 0.012, zc - 0.006], [hubX - 0.0245, yy + 0.012, zc - 0.006], 0.012, 0.002, [1, 0, 0]);
    const g = animated('yoke' + (yy < 0 ? 'L' : 'R'), { yoke: [horn, ...grips, hub, plate], chrome: [shaft, logo] }, B(hubX, yy, zc));
    parts.yokes.push(g);
  }
  // Manschetten an der Panel-Durchführung
  for (const yy of CTRL.yokeY) add('black', knobRod(yy, CTRL.yokeZ, PANEL_X + 0.001, PANEL_X - 0.012, 0.017, 20));

  // Gashebel: schwarzer Knopf auf Chromstange, Weg 70 mm (Leerlauf = gezogen)
  {
    const { y, z } = CTRL.throttle;
    const shaft = knobRod(y, z, PANEL_X + 0.08, PANEL_X - 0.012, 0.004);
    const knob = knobRod(y, z, PANEL_X - 0.012, PANEL_X - 0.04, 0.019, 24);
    const cap = knobRod(y, z, PANEL_X - 0.04, PANEL_X - 0.043, 0.014, 24);
    animated('throttle', { chrome: [shaft], black: [knob], white: [cap] }, B(PANEL_X, y, z));
  }
  // Klappenschalter: Hebel mit profilförmigem Knauf, gleitet in der Kulisse
  {
    const { y, zTop } = CTRL.flap;
    const stem = beam([PANEL_X, y, zTop], [PANEL_X - 0.02, y, zTop], 0.006, 0.008, [0, 0, -1]);
    const knob = beam([PANEL_X - 0.02, y - 0.018, zTop], [PANEL_X - 0.02, y + 0.018, zTop], 0.022, 0.012, [1, 0, 0]);
    animated('flapLever', { chrome: [stem], white: [knob] }, B(PANEL_X, y, zTop));
    // Stellungsanzeiger (Zeiger links der Kulisse, folgt der Ist-Stellung)
    const ptr = beam([PANEL_X - 0.002, y - 0.03, zTop], [PANEL_X - 0.002, y - 0.017, zTop], 0.003, 0.005, [0, 0, -1]);
    animated('flapIndicator', { red: [ptr] }, B(PANEL_X, y, zTop));
  }
  // Trimmrad in der Mittelkonsole (dreht um Body-y) + Anzeige
  {
    const { x, y, z, r } = CTRL.trim;
    const wheel = new THREE.CylinderGeometry(r, r, 0.022, 36);
    wheel.rotateZ(Math.PI / 2);
    const bumps = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const b = new THREE.BoxGeometry(0.024, 0.008, 0.01);
      b.rotateX(-a);
      b.translate(0, Math.cos(a) * (r + 0.003), Math.sin(a) * (r + 0.003));
      bumps.push(b);
    }
    const mark = new THREE.BoxGeometry(0.024, 0.006, 0.02);
    mark.translate(0, r - 0.01, 0);
    const p = B(x, y, z);
    const g = new THREE.Group();
    g.name = 'trimWheel';
    g.position.copy(p);
    g.add(mesh(mergeGeometries([wheel, ...bumps]), M.black, { layer: L1, name: 'trimWheelMesh' }));
    g.add(mesh(mark, M.white, { layer: L1, name: 'trimWheelMark' }));
    group.add(g);
    parts.trimWheel = g;
    // Anzeige: Schieber in einem Schlitz auf der schrägen Konsole (Nase hoch → nach hinten/unten)
    const ind = beam([0.66, 0.055, 0.29], [0.66, 0.068, 0.29], 0.012, 0.01, [0, 0, -1]);
    animated('trimIndicator', { white: [ind] }, B(0.66, 0.06, 0.29));
    add('black', beam([0.69, 0.06, 0.245], [0.63, 0.06, 0.35], 0.012, 0.006, [0, 0, -1]));
  }
  // Zündschlüssel
  {
    const { y, z } = CTRL.key;
    const key = beam([PANEL_X - 0.01, y, z - 0.012], [PANEL_X - 0.01, y, z + 0.012], 0.004, 0.02, [1, 0, 0]);
    const head = beam([PANEL_X - 0.022, y, z - 0.016], [PANEL_X - 0.022, y, z + 0.016], 0.008, 0.024, [1, 0, 0]);
    animated('key', { chrome: [key], black: [head] }, B(PANEL_X, y, z));
  }
  // Wippschalter Licht
  parts.rockers = {};
  CTRL.rockers.names.forEach((n, i) => {
    const y = CTRL.rockers.y0 + i * CTRL.rockers.dy, z = CTRL.rockers.z;
    const r = beam([PANEL_X - 0.01, y, z - 0.014], [PANEL_X - 0.01, y, z + 0.014], 0.014, 0.012, [1, 0, 0]);
    parts.rockers[n] = animated('rocker' + n, { black: [r] }, B(PANEL_X, y, z));
  });
  // Parkbremse (T-Griff unter dem Panel)
  {
    const { y, z } = CTRL.park;
    const stem = knobRod(y, z, PANEL_X + 0.02, PANEL_X - 0.03, 0.004);
    const t = beam([PANEL_X - 0.03, y - 0.03, z], [PANEL_X - 0.03, y + 0.03, z], 0.012, 0.012, [0, 0, -1]);
    animated('parkingBrake', { chrome: [stem], black: [t] }, B(PANEL_X, y, z));
  }
  // Seitenruderpedale (je zwei gekoppelt)
  {
    const ped = (y) => [
      beam([0.93, y, 0.34], [0.965, y, 0.46], 0.07, 0.018, [1, 0, 0]),
      rod([0.965, y, 0.28], [0.95, y, 0.34], 0.008, 0.008, 8),
    ];
    animated('pedalsL', { dark: [...ped(-0.38), ...ped(0.16)] }, B(0.95, 0, 0.4));
    animated('pedalsR', { dark: [...ped(-0.16), ...ped(0.38)] }, B(0.95, 0, 0.4));
  }

  // ---------------------------------------------------------------- Statische Meshes je Material
  for (const [k, list] of Object.entries(S)) {
    group.add(mesh(mergeGeometries(list), M[k], { layer: L1, name: 'static_' + k }));
  }

  // ---------------------------------------------------------------- Hit-Zonen (unsichtbar, Layer 1)
  const hits = [];
  const hit = (control, center, size, extra = {}) => {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const m = new THREE.Mesh(g, M.hit);
    m.position.copy(B(...center));
    m.layers.set(L1);
    m.userData = { control, ...extra };
    m.name = 'hit_' + control;
    group.add(m);
    hits.push(m);
    return m;
  };
  hit('throttle', [PANEL_X - 0.03, CTRL.throttle.y, CTRL.throttle.z], [0.06, 0.06, 0.1], { mode: 'drag', tip: 'Gas' });
  hit('mixture', [PANEL_X - 0.025, CTRL.mixture.y, CTRL.mixture.z], [0.045, 0.045, 0.06], { mode: 'drag', tip: 'Gemisch' });
  hit('flaps', [PANEL_X - 0.02, CTRL.flap.y, (CTRL.flap.zTop + CTRL.flap.zBot) / 2], [0.05, 0.16, 0.05], { mode: 'click', tip: 'Klappen' });
  hit('trim', [CTRL.trim.x, 0, CTRL.trim.z], [0.05, 0.2, 0.2], { mode: 'drag', tip: 'Trimmung' });
  hit('ignition', [PANEL_X - 0.015, CTRL.key.y, CTRL.key.z], [0.04, 0.045, 0.045], { mode: 'click', tip: 'Zündung' });
  hit('beacon', [PANEL_X - 0.01, CTRL.rockers.y0, CTRL.rockers.z], [0.025, 0.035, 0.03], { mode: 'click', tip: 'Beacon' });
  hit('landingLight', [PANEL_X - 0.01, CTRL.rockers.y0 + CTRL.rockers.dy, CTRL.rockers.z], [0.025, 0.035, 0.03], { mode: 'click', tip: 'Landelicht' });
  hit('navLights', [PANEL_X - 0.01, CTRL.rockers.y0 + 3 * CTRL.rockers.dy, CTRL.rockers.z], [0.025, 0.035, 0.03], { mode: 'click', tip: 'Positionslichter' });
  hit('strobe', [PANEL_X - 0.01, CTRL.rockers.y0 + 4 * CTRL.rockers.dy, CTRL.rockers.z], [0.025, 0.035, 0.03], { mode: 'click', tip: 'Strobe' });
  hit('parkingBrake', [PANEL_X - 0.03, CTRL.park.y, CTRL.park.z], [0.06, 0.08, 0.04], { mode: 'click', tip: 'Parkbremse' });
  hit('kollsman', [PANEL_X - 0.01, INSTRUMENTS.alt.y - 0.04, INSTRUMENTS.alt.z + 0.04], [0.03, 0.03, 0.03], { mode: 'wheel', tip: 'Höhenmesser einstellen' });
  hit('hiKnob', [PANEL_X - 0.01, INSTRUMENTS.hi.y - 0.04, INSTRUMENTS.hi.z + 0.04], [0.03, 0.03, 0.03], { mode: 'wheel', tip: 'Kurskreisel einstellen' });

  /** Raycast gegen die Hit-Zonen; liefert das getroffene Bedienelement oder null. */
  function pick(raycaster) {
    const r = raycaster.intersectObjects(hits, false);
    return r.length ? r[0].object.userData : null;
  }

  // ---------------------------------------------------------------- Animation
  /**
   * Hebel & Anzeigen an Controls/Zustand anpassen.
   * extra: { lights: {landing, nav, strobe, beacon} }
   */
  function update(s, ctl, extra = {}) {
    const e = clamp(ctl.elevator, -1, 1), a = clamp(ctl.aileron, -1, 1);
    const travel = e > 0 ? -0.09 * e : -0.07 * e; // ziehen → nach hinten (−x)
    for (const y of parts.yokes) {
      y.position.copy(y.userData.base);
      y.position.z -= travel; // lokal +z = Body −x
      y.rotation.z = -a * 55 * D; // Rechtsrollen = Horn im Uhrzeigersinn (aus Pilotensicht)
    }
    const thr = parts.throttle;
    thr.position.copy(thr.userData.base);
    thr.position.z += (1 - clamp(ctl.throttle, 0, 1)) * 0.07;

    const fl = CTRL.flap;
    const cmd = clamp(Math.round(ctl.flapsCmd), 0, 3);
    parts.flapLever.position.copy(parts.flapLever.userData.base);
    parts.flapLever.position.y -= (cmd / 3) * (fl.zBot - fl.zTop);
    parts.flapIndicator.position.copy(parts.flapIndicator.userData.base);
    parts.flapIndicator.position.y -= clamp(s.flapsDeg / 30, 0, 1) * (fl.zBot - fl.zTop);

    const trim = clamp(ctl.trim, -1, 1);
    parts.trimWheel.rotation.x = trim * 2.4 * Math.PI; // Nase hoch = Rad nach hinten (oben nach hinten)
    parts.trimIndicator.position.copy(parts.trimIndicator.userData.base);
    parts.trimIndicator.position.z += trim * 0.0125; // Nase-hoch-Trimm → Anzeige nach hinten/unten
    parts.trimIndicator.position.y -= trim * 0.0218;

    const ign = ctl.ignition;
    parts.key.rotation.z = -(ign === 'OFF' ? -50 : ign === 'START' ? 75 : 40) * D;
    const L = extra.lights || {};
    const rk = { BCN: L.beacon, LAND: L.landing, TAXI: false, NAV: L.nav, STROBE: L.strobe };
    for (const [n, g] of Object.entries(parts.rockers)) g.rotation.x = (rk[n] ? -14 : 14) * D;

    parts.parkingBrake.position.copy(parts.parkingBrake.userData.base);
    parts.parkingBrake.position.z += ctl.parkingBrake ? 0.05 : 0;

    const r = clamp(ctl.rudder, -1, 1) * 0.045;
    parts.pedalsL.position.copy(parts.pedalsL.userData.base);
    parts.pedalsL.position.z += r; // rechtes Pedal vor → linkes zurück
    parts.pedalsR.position.copy(parts.pedalsR.userData.base);
    parts.pedalsR.position.z -= r;
  }

  /** Instrumentenbeleuchtung (0 = Tag, 1 = volle rötliche Nachtbeleuchtung). */
  function setPanelLight(level) {
    const l = clamp(level, 0, 1);
    M.dial.emissive.setRGB(1, 0.55 + 0.45 * (1 - l), 0.45 + 0.55 * (1 - l));
    M.dial.emissiveIntensity = 0.06 + 0.6 * l;
    M.radio.emissiveIntensity = 0.35 + 0.4 * l;
  }

  return { group, parts, hits, pick, update, setPanelLight, materials: M };
}
