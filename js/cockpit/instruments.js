// Rundinstrumente per Canvas 2D in einem Atlas (2048 × 1024) → CanvasTexture fürs Panel.
// Statische Teile (Skalen, Beschriftung) werden einmalig in Offscreen-Canvases gecacht,
// pro Neuzeichnen kommen nur die beweglichen Teile (Zeiger, Kugel, Rosen) dazu.
// Anzeige-Dynamik (Verzögerungen, Kreisel, Kompassfehler) lebt hier, nicht in der Physik.
import * as THREE from 'three';
import { altimeterAltitude } from '../sim/atmosphere.js';
import { bodyToThree, FT, RAD, DEG, clamp, wrap360, interp } from '../sim/math.js';

export const ATLAS_W = 2048;
export const ATLAS_H = 1024;
const M = 320; // Zellengröße Hauptinstrumente (px)
const SM = 160; // Zellengröße kleine Instrumente

/** Atlas-Zellen [x, y, w, h] in Canvas-Pixeln (y nach unten). */
export const CELLS = {
  asi: [0, 0, M, M],
  ai: [M, 0, M, M],
  alt: [2 * M, 0, M, M],
  tc: [3 * M, 0, M, M],
  hi: [4 * M, 0, M, M],
  vsi: [5 * M, 0, M, M],
  tach: [0, M, M, M],
  clock: [M, M, SM, SM],
  suction: [M + SM, M, SM, SM],
  fuel: [M + 2 * SM, M, SM, SM],
  oil: [M + 3 * SM, M, SM, SM],
  amp: [M + 4 * SM, M, SM, SM],
  egt: [M + 5 * SM, M, SM, SM],
  compass: [M + 6 * SM, M, 640, 320],
  // Funkgeräte (3200 px/m → 0,16 m breit)
  audio: [0, 2 * M, 512, 80],
  com1: [0, 2 * M + 80, 512, 160],
  com2: [512, 2 * M, 512, 160],
  xpdr: [512, 2 * M + 160, 512, 128],
};
export const RADIO_PX_PER_M = 3200;

/** UV-Rechteck einer Zelle {u0, v0, u1, v1} (flipY der CanvasTexture berücksichtigt). */
export function cellUV(name) {
  const [x, y, w, h] = CELLS[name];
  return { u0: x / ATLAS_W, u1: (x + w) / ATLAS_W, v0: 1 - (y + h) / ATLAS_H, v1: 1 - y / ATLAS_H };
}

// ------------------------------------------------------------------ Zeichen-Helfer
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const WHITE = '#f2f0ea';
const GREY = '#9a9a96';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
/** Winkel im Uhrzeigersinn ab 12 Uhr (Grad) → Canvas-Winkel (rad). */
const ca = (deg) => (deg - 90) * DEG;

function face(ctx, r, cx = r, cy = r) {
  // Gehäuse-Innenwand (dunkler Rand) + mattschwarzes Zifferblatt mit leichtem Verlauf
  const g = ctx.createRadialGradient(cx, cy - r * 0.25, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#202122');
  g.addColorStop(0.85, '#141516');
  g.addColorStop(1, '#070707');
  ctx.fillStyle = '#050505';
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.985, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}
function innerShadow(ctx, r, cx = r, cy = r) {
  // Schatten der Lünette auf dem Zifferblatt (oben stärker)
  const g = ctx.createRadialGradient(cx, cy + r * 0.12, r * 0.78, cx, cy, r * 1.0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}
function tick(ctx, cx, cy, deg, r1, r2, w, color = WHITE) {
  const a = ca(deg);
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
  ctx.lineWidth = w;
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.stroke();
}
function arcBand(ctx, cx, cy, r, w, d0, d1, color) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, ca(d0), ca(d1));
  ctx.lineWidth = w;
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.stroke();
}
function text(ctx, s, x, y, size, color = WHITE, weight = '600', align = 'center') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
function numberAt(ctx, s, cx, cy, deg, r, size, color = WHITE) {
  const a = ca(deg);
  text(ctx, s, cx + Math.cos(a) * r, cy + Math.sin(a) * r, size, color, '700');
}
/** Klassischer weißer Zeiger mit Gegengewicht; Winkel im Uhrzeigersinn ab 12 Uhr. */
function needle(ctx, cx, cy, deg, len, width = 9, tail = 0.22, color = WHITE) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(deg * DEG);
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.moveTo(-width * 0.5, len * tail);
  ctx.lineTo(-width * 0.5, -len * 0.72);
  ctx.lineTo(0, -len);
  ctx.lineTo(width * 0.5, -len * 0.72);
  ctx.lineTo(width * 0.5, len * tail);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  // dunkler Fuß
  ctx.beginPath();
  ctx.rect(-width * 0.5, -len * 0.18, width, len * (0.18 + tail));
  ctx.fillStyle = '#1b1b1b';
  ctx.fill();
  ctx.restore();
  hub(ctx, cx, cy, width * 1.25);
}
function hub(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#5a5a5a');
  g.addColorStop(1, '#0c0c0c');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}
function knob(ctx, cx, cy, r) {
  // Einstellknopf unten links am Gehäuse (nur angedeutet, Lünette verdeckt den Rest)
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#4d4d4d');
  g.addColorStop(1, '#101010');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ------------------------------------------------------------------ Skalen-Funktionen
const ASI_KT = [0, 40, 60, 80, 100, 120, 140, 160, 180, 200];
const ASI_DEG = [0, 36, 78, 122, 166, 208, 247, 283, 316, 344];
export const asiAngle = (kt) => interp(ASI_KT, ASI_DEG, clamp(kt, 0, 200));
export const vsiAngle = (fpm) => 270 + (clamp(fpm, -2000, 2000) / 2000) * 172; // 0 bei 9 Uhr, Steigen im Uhrzeigersinn
export const tachAngle = (rpm) => 225 + (clamp(rpm, 0, 3500) / 3500) * 270;
export const suctionAngle = (inHg) => 150 + clamp(inHg, 0, 8) * 40; // 2 bei 230°, 4 bei 310° …

// ------------------------------------------------------------------ Statische Hintergründe
function bgASI(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  const cx = r, cy = r;
  // Bögen (Innen nach außen: weiß, grün, gelb) + rote Linie
  arcBand(x, cx, cy, r * 0.86, r * 0.07, asiAngle(33), asiAngle(85), '#f4f4f0');
  arcBand(x, cx, cy, r * 0.79, r * 0.07, asiAngle(44), asiAngle(127), '#1fae4a');
  arcBand(x, cx, cy, r * 0.79, r * 0.07, asiAngle(127), asiAngle(158), '#f2c318');
  tick(x, cx, cy, asiAngle(158), r * 0.72, r * 0.92, 6, '#e0231c');
  for (let kt = 40; kt <= 200; kt += 5) {
    const major = kt % 10 === 0;
    tick(x, cx, cy, asiAngle(kt), r * (major ? 0.72 : 0.8), r * 0.93, major ? 4 : 2.5);
  }
  for (let kt = 40; kt <= 200; kt += 20) numberAt(x, String(kt), cx, cy, asiAngle(kt), r * 0.56, r * 0.19);
  text(x, 'AIRSPEED', cx, cy - r * 0.22, r * 0.09, GREY, '600');
  text(x, 'KNOTS', cx, cy + r * 0.3, r * 0.1, WHITE, '700');
  innerShadow(x, r);
  return c;
}

function bgVSI(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  const cx = r, cy = r;
  for (let f = -2000; f <= 2000; f += 100) {
    const major = f % 500 === 0;
    tick(x, cx, cy, vsiAngle(f), r * (major ? 0.72 : 0.8), r * 0.93, major ? 4.5 : 2.5);
  }
  for (const f of [5, 10, 15, 20]) {
    numberAt(x, String(f), cx, cy, vsiAngle(f * 100), r * 0.57, r * 0.19);
    if (f !== 20) numberAt(x, String(f), cx, cy, vsiAngle(-f * 100), r * 0.57, r * 0.19);
  }
  numberAt(x, '0', cx, cy, 270, r * 0.57, r * 0.2);
  text(x, 'UP', cx - r * 0.3, cy - r * 0.3, r * 0.1, WHITE, '700');
  text(x, 'DOWN', cx - r * 0.3, cy + r * 0.3, r * 0.1, WHITE, '700');
  text(x, 'VERTICAL SPEED', cx + r * 0.18, cy - r * 0.2, r * 0.075, GREY);
  text(x, '100 FEET PER MIN', cx + r * 0.18, cy + r * 0.2, r * 0.075, GREY);
  innerShadow(x, r);
  return c;
}

function bgTach(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  const cx = r, cy = r;
  arcBand(x, cx, cy, r * 0.82, r * 0.09, tachAngle(2100), tachAngle(2700), '#1fae4a');
  tick(x, cx, cy, tachAngle(2700), r * 0.7, r * 0.93, 7, '#e0231c');
  for (let v = 0; v <= 3500; v += 100) {
    const major = v % 500 === 0;
    tick(x, cx, cy, tachAngle(v), r * (major ? 0.72 : 0.82), r * 0.93, major ? 4.5 : 2.5);
  }
  for (let v = 0; v <= 35; v += 5) numberAt(x, String(v), cx, cy, tachAngle(v * 100), r * 0.57, r * 0.19);
  text(x, 'RPM', cx, cy - r * 0.3, r * 0.12, WHITE, '700');
  text(x, 'X100', cx, cy - r * 0.16, r * 0.08, GREY);
  // Betriebsstundenzähler
  x.fillStyle = '#000';
  x.fillRect(cx - r * 0.3, cy + r * 0.3, r * 0.6, r * 0.16);
  x.strokeStyle = '#555';
  x.lineWidth = 2;
  x.strokeRect(cx - r * 0.3, cy + r * 0.3, r * 0.6, r * 0.16);
  x.font = `600 ${r * 0.12}px ui-monospace, Menlo, Consolas, monospace`;
  x.fillStyle = '#e8e8e8';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('2 7 4 3 .', cx - r * 0.03, cy + r * 0.385);
  x.fillStyle = '#f2f2f2';
  x.fillRect(cx + r * 0.19, cy + r * 0.31, r * 0.1, r * 0.14);
  x.fillStyle = '#111';
  x.fillText('6', cx + r * 0.24, cy + r * 0.385);
  text(x, 'HOURS', cx, cy + r * 0.56, r * 0.07, GREY);
  innerShadow(x, r);
  return c;
}

function bgAlt(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  const cx = r, cy = r;
  // Kollsman-Fenster (Ausschnitt bei 3 Uhr, Wert kommt dynamisch)
  x.fillStyle = '#000';
  x.fillRect(cx + r * 0.36, cy - r * 0.1, r * 0.4, r * 0.2);
  for (let i = 0; i < 50; i++) {
    const deg = i * 7.2;
    const major = i % 5 === 0;
    tick(x, cx, cy, deg, r * (major ? 0.74 : 0.84), r * 0.93, major ? 4.5 : 2.5);
  }
  for (let n = 0; n <= 9; n++) numberAt(x, String(n), cx, cy, n * 36, r * 0.6, r * 0.21);
  text(x, 'ALT', cx, cy - r * 0.34, r * 0.1, WHITE, '700');
  text(x, '100 FEET', cx - r * 0.02, cy + r * 0.3, r * 0.075, GREY);
  text(x, 'hPa', cx + r * 0.56, cy + r * 0.2, r * 0.07, GREY);
  innerShadow(x, r);
  return c;
}

function bgTC(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  const cx = r, cy = r;
  // Standardraten-Marken (Flügel des Symbols decken sie bei 3°/s)
  for (const s of [-1, 1]) {
    for (const d of [0, 17]) {
      const deg = (s < 0 ? 270 : 90) + (s < 0 ? -d : d);
      tick(x, cx, cy, deg, r * 0.72, r * 0.88, 7);
    }
  }
  text(x, 'L', cx - r * 0.62, cy + r * 0.4, r * 0.15, WHITE, '700');
  text(x, 'R', cx + r * 0.62, cy + r * 0.4, r * 0.15, WHITE, '700');
  text(x, 'TURN COORDINATOR', cx, cy - r * 0.42, r * 0.075, GREY);
  text(x, '2 MIN', cx, cy + r * 0.62, r * 0.09, WHITE, '700');
  text(x, 'NO PITCH', cx, cy + r * 0.76, r * 0.06, GREY);
  text(x, 'INFORMATION', cx, cy + r * 0.84, r * 0.06, GREY);
  text(x, 'D.C. ELEC.', cx, cy - r * 0.6, r * 0.065, GREY);
  // Libelle (gebogenes Glasrohr unten)
  x.save();
  x.beginPath();
  x.arc(cx, cy - r * 0.62, r * 1.02, ca(154), ca(206), false);
  x.lineWidth = r * 0.16;
  x.strokeStyle = '#d9d6c6';
  x.stroke();
  x.beginPath();
  x.arc(cx, cy - r * 0.62, r * 1.02, ca(154), ca(206), false);
  x.lineWidth = r * 0.12;
  const g = x.createLinearGradient(0, cy + r * 0.3, 0, cy + r * 0.48);
  g.addColorStop(0, '#fbf8e6');
  g.addColorStop(1, '#bdb89e');
  x.strokeStyle = g;
  x.stroke();
  x.restore();
  // Mittelmarken der Libelle
  for (const s of [-1, 1]) {
    const a = ca(180 + s * 5.2);
    const px = cx + Math.cos(a) * r * 1.02, py = cy - r * 0.62 + Math.sin(a) * r * 1.02;
    x.fillStyle = '#111';
    x.fillRect(px - 2, py - r * 0.08, 4, r * 0.16);
  }
  innerShadow(x, r);
  return c;
}

function cardHI(r) {
  // Kompassrose des Kurskreisels (dreht sich)
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  const cx = r, cy = r;
  for (let d = 0; d < 360; d += 5) {
    const major = d % 10 === 0;
    tick(x, cx, cy, d, r * (major ? 0.8 : 0.87), r * 0.97, major ? 4 : 2.5);
  }
  const lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    x.save();
    x.translate(cx, cy);
    x.rotate(d * DEG);
    text(x, lab[d] || String(d / 10), 0, -r * 0.63, r * (lab[d] ? 0.21 : 0.18), WHITE, '700');
    x.restore();
  }
  return c;
}
function overlayHI(r) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  const cx = r, cy = r;
  // Flugzeugsymbol (orange) + Steuerstrich-Marken alle 45°
  for (let d = 0; d < 360; d += 45) {
    const a = ca(d);
    x.save();
    x.translate(cx + Math.cos(a) * r * 0.99, cy + Math.sin(a) * r * 0.99);
    x.rotate(d * DEG);
    x.beginPath();
    x.moveTo(-8, -6);
    x.lineTo(8, -6);
    x.lineTo(0, 12);
    x.closePath();
    x.fillStyle = d === 0 ? '#ff8c1a' : WHITE;
    x.fill();
    x.restore();
  }
  x.save();
  x.translate(cx, cy);
  x.fillStyle = '#ff8c1a';
  x.strokeStyle = '#000';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(0, -r * 0.42);
  x.lineTo(r * 0.04, -r * 0.3);
  x.lineTo(r * 0.04, -r * 0.08);
  x.lineTo(r * 0.3, r * 0.04);
  x.lineTo(r * 0.3, r * 0.1);
  x.lineTo(r * 0.04, r * 0.06);
  x.lineTo(r * 0.035, r * 0.26);
  x.lineTo(r * 0.12, r * 0.32);
  x.lineTo(r * 0.12, r * 0.36);
  x.lineTo(-r * 0.12, r * 0.36);
  x.lineTo(-r * 0.12, r * 0.32);
  x.lineTo(-r * 0.035, r * 0.26);
  x.lineTo(-r * 0.04, r * 0.06);
  x.lineTo(-r * 0.3, r * 0.1);
  x.lineTo(-r * 0.3, r * 0.04);
  x.lineTo(-r * 0.04, -r * 0.08);
  x.lineTo(-r * 0.04, -r * 0.3);
  x.closePath();
  x.fill();
  x.stroke();
  x.restore();
  knob(x, cx - r * 0.8, cy + r * 0.8, r * 0.17);
  text(x, 'PUSH', cx - r * 0.8, cy + r * 0.8, r * 0.055, '#ddd', '700');
  innerShadow(x, r);
  return c;
}

function overlayAI(r) {
  // feste Teile: Lünettenring mit Querneigungsskala, Flugzeugsymbol, Knopf
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  const cx = r, cy = r;
  const ri = r * 0.8;
  // Ring (maskiert das Innere)
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.arc(cx, cy, ri, 0, Math.PI * 2, true);
  const g = x.createLinearGradient(0, 0, 0, 2 * r);
  g.addColorStop(0, '#1c1d1e');
  g.addColorStop(1, '#0a0a0a');
  x.fillStyle = g;
  x.fill('evenodd');
  x.beginPath();
  x.arc(cx, cy, ri, 0, Math.PI * 2);
  x.strokeStyle = '#000';
  x.lineWidth = 3;
  x.stroke();
  // Querneigungsskala 10/20/30/60 (+45 klein), weißes Dreieck bei 0
  for (const d of [-60, -30, -20, -10, 10, 20, 30, 60]) {
    const big = Math.abs(d) === 30 || Math.abs(d) === 60;
    tick(x, cx, cy, d, r * 0.82, r * (big ? 0.99 : 0.93), big ? 6 : 4);
  }
  for (const d of [-45, 45]) {
    const a = ca(d);
    x.beginPath();
    x.arc(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9, 5, 0, Math.PI * 2);
    x.fillStyle = WHITE;
    x.fill();
  }
  x.beginPath();
  x.moveTo(cx, cy - r * 0.82);
  x.lineTo(cx - 13, cy - r * 0.98);
  x.lineTo(cx + 13, cy - r * 0.98);
  x.closePath();
  x.fillStyle = WHITE;
  x.fill();
  // Flugzeugsymbol (orange-gelb), fest
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.7)';
  x.shadowBlur = 6;
  x.shadowOffsetY = 4;
  x.fillStyle = '#f5a623';
  x.fillRect(cx - r * 0.52, cy - 5, r * 0.3, 10);
  x.fillRect(cx + r * 0.22, cy - 5, r * 0.3, 10);
  x.beginPath();
  x.moveTo(cx - r * 0.22, cy - 5);
  x.lineTo(cx, cy + r * 0.12);
  x.lineTo(cx + r * 0.22, cy - 5);
  x.lineTo(cx + r * 0.22, cy + 5);
  x.lineTo(cx, cy + r * 0.19);
  x.lineTo(cx - r * 0.22, cy + 5);
  x.closePath();
  x.fill();
  x.beginPath();
  x.arc(cx, cy, 7, 0, Math.PI * 2);
  x.fill();
  // Sockel
  x.fillStyle = '#1a1a1a';
  x.beginPath();
  x.moveTo(cx - r * 0.3, cy + r * 0.8);
  x.lineTo(cx - r * 0.1, cy + r * 0.3);
  x.lineTo(cx + r * 0.1, cy + r * 0.3);
  x.lineTo(cx + r * 0.3, cy + r * 0.8);
  x.closePath();
  x.fill();
  x.restore();
  knob(x, cx, cy + r * 0.86, r * 0.12);
  text(x, 'PULL TO CAGE', cx, cy + r * 0.66, r * 0.05, GREY);
  innerShadow(x, r);
  return c;
}

function smallGauge(r, title, ticks, labels, arcs = []) {
  const c = makeCanvas(2 * r, 2 * r);
  const x = c.getContext('2d');
  face(x, r);
  for (const [d0, d1, color] of arcs) arcBand(x, r, r, r * 0.8, r * 0.1, d0, d1, color);
  for (const d of ticks) tick(x, r, r, d, r * 0.7, r * 0.9, 3);
  for (const [s, d] of labels) numberAt(x, s, r, r, d, r * 0.52, r * 0.2);
  text(x, title, r, r + r * 0.42, r * 0.14, GREY, '700');
  innerShadow(x, r);
  return c;
}

// ------------------------------------------------------------------ Instrumente
export function createInstruments() {
  const canvas = makeCanvas(ATLAS_W, ATLAS_H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  const R = M / 2, r = SM / 2;
  const bg = {
    asi: bgASI(R),
    vsi: bgVSI(R),
    tach: bgTach(R),
    alt: bgAlt(R),
    tc: bgTC(R),
    hiCard: cardHI(R),
    hiOver: overlayHI(R),
    aiOver: overlayAI(R),
    suction: smallGauge(r, 'SUCTION', [0, 1, 2, 3, 4, 5, 6, 7, 8].map(suctionAngle), [2, 4, 6, 8].map((v) => [String(v), suctionAngle(v)]), [[suctionAngle(4.5), suctionAngle(5.5), '#1fae4a']]),
    amp: smallGauge(r, 'AMPS', [240, 270, 300, 330, 0, 30, 60, 90, 120], [['−', 240], ['0', 0], ['+', 120]]),
    egt: smallGauge(r, 'EGT', [240, 270, 300, 330, 0, 30, 60, 90, 120], [], []),
  };

  // Anzeige-Zustand (mit Verzögerungen)
  const d = {
    asi: 0, pitch: 0, bank: 0, alt: 0, kollsman: 1013, turn: 0, ball: 0, ballVel: 0,
    hi: 0, hiOffset: 0, vsi: 0, rpm: 0, compass: 0, compassVel: 0, compassErr: 0,
    oilT: 40, oilP: 0, suction: 0, amp: 0, egt: 0, fuelL: 19, fuelR: 20, clock: 10,
    lastV: null, accLong: 0, initialized: false,
  };

  /** Instrumente sofort auf den Zustand setzen (Reset/Szenariowechsel). */
  function snap(s, env) {
    d.asi = s.ias_kt;
    d.pitch = s.pitch_deg;
    d.bank = s.bank_deg;
    d.kollsman = env ? +env.qnh : d.kollsman;
    d.alt = altimeterAltitude(s.staticPressure, d.kollsman) / FT;
    d.turn = 0;
    d.ball = 0;
    d.ballVel = 0;
    d.hiOffset = 0;
    d.hi = s.heading_deg;
    d.vsi = s.vs_fpm;
    d.rpm = s.rpm;
    d.compass = s.heading_deg;
    d.compassVel = 0;
    d.lastV = null;
    d.accLong = 0;
    d.oilP = s.rpm > 300 ? oilPressure(s.rpm) : 0;
    d.oilT = s.rpm > 300 ? 150 : 60;
    d.suction = s.rpm > 300 ? suction(s.rpm) : 0;
    d.initialized = true;
  }

  const oilPressure = (rpm) => clamp(20 + rpm * 0.018, 0, 70);
  const suction = (rpm) => clamp(rpm / 250, 0, 5.1);
  const lag = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
  const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

  /** Anzeigewerte fortschreiben (dt in s Simulationszeit). */
  function update(s, env, dt) {
    if (!d.initialized) snap(s, env);
    if (dt <= 0) return;
    // Verzögerungen 1. Ordnung sind für jedes dt exakt; die Schwinger (Kugel, Kompass) laufen in Teilschritten
    d.asi = lag(d.asi, s.ias_kt, dt, 0.15);
    // Kreisel-Horizont: leichte Nachlaufträgheit
    d.pitch = lag(d.pitch, s.pitch_deg, dt, 0.12);
    d.bank += wrap180(s.bank_deg - d.bank) * (1 - Math.exp(-dt / 0.12));
    d.alt = lag(d.alt, altimeterAltitude(s.staticPressure, d.kollsman) / FT, dt, 0.1);
    d.vsi = lag(d.vsi, s.vs_fpm, dt, 1.5);
    d.rpm = lag(d.rpm, s.rpm, dt, 0.08);

    // Wendezeiger: Gierrate um die Welt-Hochachse + Anteil Rollrate (Kreisel 30° geneigt)
    const wWorld = bodyToThree(s.q, s.w);
    const yawRate = -wWorld[1] * RAD; // °/s, positiv = Rechtskurve
    d.turn = lag(d.turn, yawRate + 0.25 * s.w[0] * RAD, dt, 0.25);
    // Kugel: folgt der scheinbaren Schwerkraft (−Querbeschleunigung), gedämpft (Flüssigkeit)
    const nz = Math.abs(s.g) > 0.2 ? s.g : 0.2 * Math.sign(s.g || 1);
    const ballT = clamp(-s.ay_g / nz, -1.2, 1.2);
    const kb = 60, cb = 11;
    const nSub = Math.ceil(dt * 120), hs = dt / nSub;
    for (let i = 0; i < nSub; i++) {
      d.ballVel += (kb * (ballT - d.ball) - cb * d.ballVel) * hs;
      d.ball = clamp(d.ball + d.ballVel * hs, -1, 1);
      if (Math.abs(d.ball) >= 1) d.ballVel = 0;
    }

    // Kurskreisel: Kurs + langsame Präzession (≈ 0,2°/min)
    d.hiOffset += (0.2 / 60) * dt;
    d.hi = wrap360(s.heading_deg + d.hiOffset);

    // Magnetkompass: Dreh- und Beschleunigungsfehler (48° N), Schwimmkarte gedämpft
    const vx = s.v[0], vz = s.v[2];
    const gsNow = Math.hypot(vx, vz);
    if (d.lastV !== null) d.accLong = lag(d.accLong, (gsNow - d.lastV) / dt, dt, 0.3);
    d.lastV = gsNow;
    const h = s.heading_deg * DEG;
    const turnErr = clamp(-2.2 * s.bank_deg * Math.cos(h), -45, 45);
    const accErr = clamp(-9 * d.accLong * Math.sin(h), -20, 20);
    const target = s.heading_deg + turnErr + accErr;
    const w0 = 2.6, zeta = 0.35;
    for (let i = 0; i < nSub; i++) {
      d.compassVel += (w0 * w0 * wrap180(target - d.compass) - 2 * zeta * w0 * d.compassVel) * hs;
      d.compass = wrap360(d.compass + d.compassVel * hs);
    }

    // Motorüberwachung
    const turning = s.rpm > 300; // Öldruck/Unterdruck hängen an der Drehzahl (auch windmillend)
    const burning = s.engineRunning !== undefined ? !!s.engineRunning && turning : turning; // Temperaturen: Verbrennung
    d.oilP = lag(d.oilP, turning ? oilPressure(s.rpm) : 0, dt, 0.8);
    d.oilT = lag(d.oilT, burning ? 150 + s.rpm * 0.02 : 60, dt, 90);
    d.suction = lag(d.suction, suction(s.rpm), dt, 0.6);
    d.amp = lag(d.amp, s.rpm > 1000 ? 2 : s.rpm > 300 ? -1 : -3, dt, 0.5);
    d.egt = lag(d.egt, burning ? 0.35 + (s.rpm / 2700) * 0.5 : 0, dt, 4);
    d.clock = env ? +env.timeOfDay : d.clock;
  }

  /** HI an den Magnetkompass angleichen (Einstellknopf). */
  function alignHI() {
    d.hiOffset = wrap180(d.compass - (d.hi - d.hiOffset));
  }
  /** Kurskreisel per Einstellknopf verdrehen (Grad). */
  function turnHIKnob(deg) {
    d.hiOffset += deg;
  }
  function setKollsman(hpa) {
    d.kollsman = clamp(hpa, 950, 1050);
  }

  // -------------------------------------------------------------- Zeichnen
  function drawCell(name, fn) {
    const [x, y, w, h] = CELLS[name];
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x, y);
    fn(ctx, w, h);
    ctx.restore();
  }

  function drawAI(x) {
    const cx = R, cy = R;
    x.fillStyle = '#000';
    x.fillRect(0, 0, M, M);
    x.save();
    x.beginPath();
    x.arc(cx, cy, R * 0.98, 0, Math.PI * 2);
    x.clip();
    x.translate(cx, cy);
    x.rotate(-d.bank * DEG);
    const k = 3.3; // px pro Grad Nick
    const pitch = clamp(d.pitch, -35, 35);
    const off = pitch * k;
    // Himmel / Erde
    const sky = x.createLinearGradient(0, -R * 1.5 + off, 0, off);
    sky.addColorStop(0, '#1f5f9e');
    sky.addColorStop(1, '#4f95d6');
    x.fillStyle = sky;
    x.fillRect(-R * 1.6, -R * 2 + off, R * 3.2, R * 2);
    const gnd = x.createLinearGradient(0, off, 0, R * 1.5 + off);
    gnd.addColorStop(0, '#8a5a2b');
    gnd.addColorStop(1, '#4e3217');
    x.fillStyle = gnd;
    x.fillRect(-R * 1.6, off, R * 3.2, R * 2);
    x.fillStyle = WHITE;
    x.fillRect(-R * 1.6, off - 2, R * 3.2, 4);
    // Nickleiter
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue;
      const yy = off - p * k;
      const w = p % 10 === 0 ? R * 0.34 : R * 0.16;
      x.fillRect(-w / 2, yy - 1.5, w, 3);
      if (p % 10 === 0) {
        text(x, String(Math.abs(p)), -w / 2 - 16, yy, 18, WHITE, '700');
        text(x, String(Math.abs(p)), w / 2 + 16, yy, 18, WHITE, '700');
      }
    }
    // Querneigungs-Index auf der Kugel (dreht mit)
    x.beginPath();
    x.moveTo(0, -R * 0.8);
    x.lineTo(-11, -R * 0.66);
    x.lineTo(11, -R * 0.66);
    x.closePath();
    x.fillStyle = '#f5a623';
    x.fill();
    // Kreisbogen der Skala auf der Kugel (Himmelshälfte weiß gerandet)
    x.restore();
    x.drawImage(bg.aiOver, 0, 0);
  }

  function drawTC(x) {
    x.drawImage(bg.tc, 0, 0);
    const cx = R, cy = R;
    // Kugel in der Libelle
    const a = ca(180 - d.ball * 20);
    const bx = cx + Math.cos(a) * R * 1.02, by = cy - R * 0.62 + Math.sin(a) * R * 1.02;
    const g = x.createRadialGradient(bx - 4, by - 4, 1, bx, by, R * 0.055);
    g.addColorStop(0, '#555');
    g.addColorStop(1, '#050505');
    x.beginPath();
    x.arc(bx, by, R * 0.055, 0, Math.PI * 2);
    x.fillStyle = g;
    x.fill();
    // Flugzeugsymbol (Heckansicht), neigt sich mit der Drehrate (Standardrate = 17°)
    x.save();
    x.translate(cx, cy);
    x.rotate(clamp((d.turn / 3) * 17, -40, 40) * DEG);
    x.shadowColor = 'rgba(0,0,0,0.7)';
    x.shadowBlur = 6;
    x.shadowOffsetY = 4;
    x.fillStyle = WHITE;
    x.fillRect(-R * 0.72, -5, R * 1.44, 10);
    x.beginPath();
    x.arc(0, 0, R * 0.1, 0, Math.PI * 2);
    x.fill();
    x.fillRect(-3, -R * 0.26, 6, R * 0.2);
    x.fillRect(-R * 0.18, -R * 0.1, R * 0.36, 6);
    x.restore();
    hub(x, cx, cy, 6);
  }

  function drawHI(x) {
    x.fillStyle = '#111';
    x.fillRect(0, 0, M, M);
    face(x, R);
    x.save();
    x.translate(R, R);
    x.rotate(-d.hi * DEG);
    x.drawImage(bg.hiCard, -R, -R);
    x.restore();
    x.drawImage(bg.hiOver, 0, 0);
  }

  function drawAlt(x) {
    x.drawImage(bg.alt, 0, 0);
    const cx = R, cy = R;
    // Kollsman-Fenster
    x.font = `700 ${R * 0.14}px ui-monospace, Menlo, Consolas, monospace`;
    x.fillStyle = WHITE;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(String(Math.round(d.kollsman)).padStart(4, '0'), cx + R * 0.56, cy + 1);
    const alt = Math.max(-1000, d.alt);
    // 10 000-ft-Warnschraffur (sichtbar unter 10 000 ft)
    if (alt < 10000) {
      x.save();
      x.beginPath();
      x.rect(cx - R * 0.12, cy - R * 0.62, R * 0.24, R * 0.1);
      x.clip();
      x.fillStyle = '#eee';
      x.fillRect(cx - R * 0.12, cy - R * 0.62, R * 0.24, R * 0.1);
      x.strokeStyle = '#111';
      x.lineWidth = 5;
      for (let i = -4; i < 8; i++) {
        x.beginPath();
        x.moveTo(cx - R * 0.12 + i * 12, cy - R * 0.52);
        x.lineTo(cx - R * 0.12 + i * 12 + 14, cy - R * 0.62);
        x.stroke();
      }
      x.restore();
    }
    // 10 000er-Zeiger (dünn mit Dreieck), 1000er (kurz, breit), 100er (lang)
    const a10k = (alt / 100000) * 360;
    x.save();
    x.translate(cx, cy);
    x.rotate(a10k * DEG);
    x.fillStyle = WHITE;
    x.fillRect(-1.5, -R * 0.9, 3, R * 0.9);
    x.beginPath();
    x.moveTo(0, -R * 0.93);
    x.lineTo(-10, -R * 0.78);
    x.lineTo(10, -R * 0.78);
    x.closePath();
    x.fill();
    x.restore();
    needle(x, cx, cy, ((alt % 10000) / 10000) * 360, R * 0.5, 16, 0.12);
    needle(x, cx, cy, ((((alt % 1000) + 1000) % 1000) / 1000) * 360, R * 0.86, 9, 0.2);
  }

  function drawCompass(x, w, h) {
    // Schwimmkarte hinter dem Fenster: Zahlen steigen nach LINKS (Karte wird von hinten abgelesen)
    const g = x.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(0.2, '#1b1b1b');
    g.addColorStop(0.5, '#2a2a2a');
    g.addColorStop(0.8, '#1b1b1b');
    g.addColorStop(1, '#000');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    const k = w / 70; // px pro Grad (±35° sichtbar)
    const cx = w / 2;
    const lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let dd = -45; dd <= 45; dd++) {
      const deg = Math.round(d.compass) + dd;
      const frac = d.compass - Math.round(d.compass);
      const px = cx - (dd - frac) * k;
      const v = wrap360(deg);
      if (v % 5 !== 0) continue;
      const major = v % 10 === 0;
      x.fillStyle = WHITE;
      x.fillRect(px - 1.5, h * 0.62, 3, h * (major ? 0.3 : 0.18));
      if (v % 30 === 0) text(x, lab[v] || String(v / 10), px, h * 0.36, h * 0.34, WHITE, '700');
    }
    // Steuerstrich
    x.fillStyle = '#ff8c1a';
    x.fillRect(cx - 2.5, 0, 5, h);
  }

  function drawSmall(name, fn) {
    drawCell(name, (x) => fn(x));
  }

  function drawClock(x) {
    x.drawImage(bgClock, 0, 0);
    const hr = d.clock % 12;
    const min = (d.clock * 60) % 60;
    needle(x, r, r, (hr / 12) * 360, r * 0.5, 7, 0.15);
    needle(x, r, r, (min / 60) * 360, r * 0.78, 5, 0.15);
  }
  const bgClock = (() => {
    const c = makeCanvas(SM, SM);
    const x = c.getContext('2d');
    face(x, r);
    for (let i = 0; i < 60; i++) tick(x, r, r, i * 6, r * (i % 5 ? 0.84 : 0.74), r * 0.92, i % 5 ? 1.5 : 3);
    for (let i = 1; i <= 12; i++) numberAt(x, String(i), r, r, i * 30, r * 0.58, r * 0.2);
    innerShadow(x, r);
    return c;
  })();
  const bgFuel = (() => {
    // Doppelanzeige Tank links/rechts (Bögen oben/unten)
    const c = makeCanvas(SM, SM);
    const x = c.getContext('2d');
    face(x, r);
    for (const [base, sgn] of [[-90, 1], [90, -1]]) {
      for (let i = 0; i <= 4; i++) tick(x, r, r, base + sgn * (i * 30 - 60), r * 0.72, r * 0.9, i === 0 ? 4 : 2.5, i === 0 ? '#e0231c' : WHITE);
    }
    text(x, 'E', r * 0.32, r * 0.38, r * 0.16, WHITE, '700');
    text(x, 'F', r * 1.68, r * 0.38, r * 0.16, WHITE, '700');
    text(x, 'E', r * 0.32, r * 1.62, r * 0.16, WHITE, '700');
    text(x, 'F', r * 1.68, r * 1.62, r * 0.16, WHITE, '700');
    text(x, 'L  FUEL  R', r, r, r * 0.13, GREY, '700');
    innerShadow(x, r);
    return c;
  })();
  const bgOil = (() => {
    const c = makeCanvas(SM, SM);
    const x = c.getContext('2d');
    face(x, r);
    // Grüne Bereiche mit derselben Abbildung wie die Zeiger (unten): Temperatur 100–245 °F, Druck 60–90 psi
    const tAng = (f) => -150 + Math.min(1, Math.max(0, (f - 75) / 175)) * 120;
    const pAng = (psi) => 150 - Math.min(1, Math.max(0, psi / 100)) * 120;
    arcBand(x, r, r, r * 0.8, r * 0.1, tAng(100), tAng(245), '#1fae4a');
    arcBand(x, r, r, r * 0.8, r * 0.1, pAng(90), pAng(60), '#1fae4a');
    for (let i = 0; i <= 4; i++) {
      tick(x, r, r, -90 + (i * 30 - 60), r * 0.72, r * 0.9, 2.5);
      tick(x, r, r, 90 + (i * 30 - 60), r * 0.72, r * 0.9, 2.5);
    }
    text(x, 'OIL', r, r * 0.8, r * 0.14, GREY, '700');
    text(x, 'T      P', r, r * 1.2, r * 0.13, GREY, '700');
    innerShadow(x, r);
    return c;
  })();
  function smallNeedle(x, deg, len) {
    needle(x, r, r, deg, len, 5, 0.1);
  }

  function drawRadiosStatic() {
    const px = (name, fn) => drawCell(name, (x, w, h) => fn(x, w, h));
    const bezel = (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2b2c2e');
      g.addColorStop(1, '#141516');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#050505';
      x.lineWidth = 4;
      x.strokeRect(2, 2, w - 4, h - 4);
    };
    const lcd = (x, s, cx, cy, size, color) => {
      x.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.shadowColor = color;
      x.shadowBlur = 10;
      x.fillStyle = color;
      x.fillText(s, cx, cy);
      x.shadowBlur = 0;
    };
    const btn = (x, bx, by, bw, bh, label) => {
      x.fillStyle = '#3a3b3d';
      x.fillRect(bx, by, bw, bh);
      x.fillStyle = '#0f0f10';
      x.fillRect(bx + 3, by + bh - 5, bw - 6, 3);
      text(x, label, bx + bw / 2, by + bh / 2 - 1, 11, '#d8d8d8', '700');
    };
    const knobC = (x, cx, cy, rr) => {
      const g = x.createRadialGradient(cx - rr * 0.3, cy - rr * 0.3, 1, cx, cy, rr);
      g.addColorStop(0, '#555');
      g.addColorStop(1, '#0a0a0a');
      x.beginPath();
      x.arc(cx, cy, rr, 0, Math.PI * 2);
      x.fillStyle = g;
      x.fill();
    };
    px('audio', (x, w, h) => {
      bezel(x, w, h);
      const labels = ['COM1', 'COM2', 'BOTH', 'NAV1', 'NAV2', 'MKR', 'DME', 'ADF'];
      labels.forEach((l, i) => btn(x, 18 + i * 56, 20, 48, 34, l));
      text(x, 'AUDIO', w - 22, h / 2, 12, GREY, '700', 'right');
    });
    const navcom = (name, com, stby, nav, nstby) => px(name, (x, w, h) => {
      bezel(x, w, h);
      x.fillStyle = '#030503';
      x.fillRect(40, 30, 200, 64);
      x.fillRect(272, 30, 200, 64);
      lcd(x, com, 105, 62, 34, '#8cff7a');
      lcd(x, stby, 200, 62, 22, '#56c94a');
      lcd(x, nav, 337, 62, 34, '#8cff7a');
      lcd(x, nstby, 432, 62, 22, '#56c94a');
      text(x, 'COM', 60, 20, 12, GREY, '700');
      text(x, 'NAV', 292, 20, 12, GREY, '700');
      knobC(x, 30, 128, 18);
      knobC(x, 256, 128, 14);
      knobC(x, 482, 128, 18);
      btn(x, 120, 112, 44, 26, '↔');
      btn(x, 350, 112, 44, 26, '↔');
      text(x, 'NAV/COMM', 256, 150, 11, GREY, '700');
    });
    navcom('com1', '122.80', '118.30', '113.20', '110.50');
    navcom('com2', '121.50', '123.45', '109.30', '114.00');
    px('xpdr', (x, w, h) => {
      bezel(x, w, h);
      x.fillStyle = '#060300';
      x.fillRect(150, 26, 220, 58);
      lcd(x, '7000', 230, 56, 38, '#ffb347');
      lcd(x, 'ALT', 330, 56, 18, '#ffb347');
      knobC(x, 60, 62, 28);
      text(x, 'OFF SBY ON ALT', 60, 106, 10, GREY, '700');
      btn(x, 400, 40, 50, 30, 'IDENT');
      text(x, 'TRANSPONDER', 260, 110, 11, GREY, '700');
    });
  }

  /** Alle dynamischen Zellen neu zeichnen und die Textur zum Hochladen markieren. */
  function draw() {
    drawCell('asi', (x) => {
      x.drawImage(bg.asi, 0, 0);
      needle(x, R, R, asiAngle(d.asi), R * 0.84, 9, 0.2);
    });
    drawCell('ai', drawAI);
    drawCell('alt', drawAlt);
    drawCell('tc', drawTC);
    drawCell('hi', drawHI);
    drawCell('vsi', (x) => {
      x.drawImage(bg.vsi, 0, 0);
      needle(x, R, R, vsiAngle(d.vsi), R * 0.84, 9, 0.2);
    });
    drawCell('tach', (x) => {
      x.drawImage(bg.tach, 0, 0);
      needle(x, R, R, tachAngle(d.rpm), R * 0.84, 9, 0.2);
    });
    drawSmall('clock', drawClock);
    drawSmall('suction', (x) => {
      x.drawImage(bg.suction, 0, 0);
      smallNeedle(x, suctionAngle(d.suction), r * 0.78);
    });
    drawSmall('fuel', (x) => {
      x.drawImage(bgFuel, 0, 0);
      smallNeedle(x, -150 + (d.fuelL / 26) * 120, r * 0.8);
      smallNeedle(x, 150 - (d.fuelR / 26) * 120, r * 0.8);
    });
    drawSmall('oil', (x) => {
      x.drawImage(bgOil, 0, 0);
      smallNeedle(x, -150 + clamp((d.oilT - 75) / 175, 0, 1) * 120, r * 0.8);
      smallNeedle(x, 150 - clamp(d.oilP / 100, 0, 1) * 120, r * 0.8);
    });
    drawSmall('amp', (x) => {
      x.drawImage(bg.amp, 0, 0);
      smallNeedle(x, clamp(d.amp / 30, -1, 1) * 120, r * 0.8);
    });
    drawSmall('egt', (x) => {
      x.drawImage(bg.egt, 0, 0);
      smallNeedle(x, -120 + d.egt * 240, r * 0.8);
    });
    drawCell('compass', drawCompass);
    texture.needsUpdate = true;
  }

  drawRadiosStatic();
  draw();

  /** Aktuelle Anzeigewerte (für SIM.instruments()). */
  function values() {
    return {
      asi: d.asi,
      pitch: d.pitch,
      bank: d.bank,
      alt: d.alt,
      kollsman: d.kollsman,
      turn: d.turn,
      ball: d.ball,
      hi: d.hi,
      vsi: d.vsi,
      rpm: d.rpm,
      compass: d.compass,
      oilT: d.oilT,
      oilP: d.oilP,
      suction: d.suction,
    };
  }

  return { canvas, texture, update, draw, snap, values, alignHI, turnHIKnob, setKollsman, display: d };
}
