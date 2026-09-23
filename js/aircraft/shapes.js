// Geometrie-Helfer für Außenmodell und Cockpit (prozedural, ohne Addons).
// Alle Maße werden in Luftfahrt-Body-Koordinaten angegeben (x vorn, y rechts, z unten, Ursprung = Schwerpunkt)
// und hier in die lokalen Three-Achsen des Flugzeug-Objekts übersetzt (rechts +X, oben +Y, Nase −Z).
// Das entspricht quatToThree() in js/sim/math.js.
import * as THREE from 'three';

/** Body-Punkt → lokaler Three-Vektor. */
export const B = (x, y, z) => new THREE.Vector3(y, -z, -x);
/** Body-Punkt (Array) → lokales Array. */
export const lp = (p) => [p[1], -p[2], -p[0]];

/**
 * Loft aus Querschnitts-Ringen (Body-Koordinaten). rings[k][i] = [x, y, z].
 * Ringe sind geschlossen; optional Deckel an Anfang/Ende. Die Dreiecksorientierung wird automatisch so
 * gewählt, dass die Normalen von der Ringmitte nach außen zeigen.
 */
export function loft(rings, { capStart = false, capEnd = false } = {}) {
  const nr = rings.length;
  const np = rings[0].length;
  const pos = [];
  const uv = [];
  const centers = [];
  for (let k = 0; k < nr; k++) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < np; i++) {
      const q = lp(rings[k][i]);
      pos.push(q[0], q[1], q[2]);
      uv.push(i / np, k / Math.max(1, nr - 1));
      cx += q[0];
      cy += q[1];
      cz += q[2];
    }
    centers.push([cx / np, cy / np, cz / np]);
  }
  const idx = [];
  for (let k = 0; k < nr - 1; k++) {
    for (let i = 0; i < np; i++) {
      const i1 = (i + 1) % np;
      const a = k * np + i, b = k * np + i1, c = (k + 1) * np + i, d = (k + 1) * np + i1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const capIdx = [];
  const addCap = (k, rev) => {
    const ci = pos.length / 3;
    pos.push(...centers[k]);
    uv.push(0.5, k / Math.max(1, nr - 1));
    for (let i = 0; i < np; i++) {
      const a = k * np + i, b = k * np + ((i + 1) % np);
      if (rev) capIdx.push(ci, b, a);
      else capIdx.push(ci, a, b);
    }
  };
  if (capStart) addCap(0, false);
  if (capEnd) addCap(nr - 1, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Orientierung prüfen: Normalen sollen von der Ringmitte weg zeigen
  const n = geo.attributes.normal.array;
  let s = 0;
  for (let k = 0; k < nr; k++) {
    for (let i = 0; i < np; i++) {
      const v = (k * np + i) * 3;
      s += n[v] * (pos[v] - centers[k][0]) + n[v + 1] * (pos[v + 1] - centers[k][1]) + n[v + 2] * (pos[v + 2] - centers[k][2]);
    }
  }
  if (s < 0) for (let j = 0; j < idx.length; j += 3) [idx[j + 1], idx[j + 2]] = [idx[j + 2], idx[j + 1]];
  // Deckel: Orientierung an der Hauptfläche ausrichten (von der Loft-Mitte weg)
  if (capIdx.length) {
    const flip = s < 0;
    for (let j = 0; j < capIdx.length; j += 3) {
      if (flip) idx.push(capIdx[j], capIdx[j + 2], capIdx[j + 1]);
      else idx.push(capIdx[j], capIdx[j + 1], capIdx[j + 2]);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * NACA-4-Profil als geschlossene Punktliste [xc, zc] (xc 0..1 längs Sehne, zc nach oben),
 * nur der Sehnenabschnitt [x0, x1]. Reihenfolge: Oberseite x1→x0, Unterseite x0→x1.
 */
export function naca4(m, p, t, n = 16, x0 = 0, x1 = 1) {
  const pts = (sgn) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const b = (i / n) * Math.PI;
      const x = x0 + (x1 - x0) * (1 - Math.cos(b)) * 0.5;
      const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
      let yc = 0, dyc = 0;
      if (m > 0) {
        if (x < p) {
          yc = (m / (p * p)) * (2 * p * x - x * x);
          dyc = ((2 * m) / (p * p)) * (p - x);
        } else {
          yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x);
          dyc = ((2 * m) / ((1 - p) ** 2)) * (p - x);
        }
      }
      const th = Math.atan(dyc);
      out.push([x - sgn * yt * Math.sin(th), yc + sgn * yt * Math.cos(th)]);
    }
    return out;
  };
  const up = pts(1).reverse(); // x1 → x0
  const lo = pts(-1); // x0 → x1
  if (x0 > 0) {
    // Profilabschnitt ohne Nase (Klappe/Ruder): vorne halbrund zwischen Ober- und Unterseite
    const a = up.pop(), b = lo.shift();
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r = (a[1] - b[1]) / 2;
    for (let i = 0; i <= 6; i++) {
      const ang = Math.PI / 2 + (i / 6) * Math.PI;
      up.push([mid[0] + Math.cos(ang) * r * 0.9, mid[1] + Math.sin(ang) * r]);
    }
  } else lo.shift(); // Nasenpunkt nicht doppelt
  const all = up.concat(lo);
  if (x1 >= 1) all.pop(); // Hinterkante nicht doppelt
  return all;
}

/**
 * Tragflächen-/Leitwerks-Loft. stations: [{ le:[x,y,z], aft:[..], up:[..], c }] in Body-Koordinaten;
 * profile: Punktliste aus naca4(). Rückgabe BufferGeometry (lokal).
 */
export function surfaceLoft(stations, profile, opts = { capStart: true, capEnd: true }) {
  const rings = stations.map((s) =>
    profile.map(([xc, zc]) => [
      s.le[0] + s.aft[0] * xc * s.c + s.up[0] * zc * s.c,
      s.le[1] + s.aft[1] * xc * s.c + s.up[1] * zc * s.c,
      s.le[2] + s.aft[2] * xc * s.c + s.up[2] * zc * s.c,
    ]),
  );
  return loft(rings, opts);
}

/** Geometrie-Kopie mit Transformation (Position/Rotation/Skalierung in lokalen Three-Koordinaten). */
export function placed(geo, pos, rot = null, scl = null) {
  const g = geo.clone();
  const m = new THREE.Matrix4();
  const q = rot instanceof THREE.Quaternion ? rot : new THREE.Quaternion().setFromEuler(rot || new THREE.Euler());
  m.compose(pos || new THREE.Vector3(), q, scl || new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Quader zwischen zwei Body-Punkten (Balken, Rohr) mit Querschnitt w × h. up = lokale Hochrichtung (Body). */
export function beam(p0, p1, w, h, upBody = [0, 0, -1], geo = null) {
  const a = B(...p0), b = B(...p1);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const upL = B(...upBody).normalize();
  // rechtshändige Basis (side × up2 = dir), sonst würde die Spiegelung die Dreiecksorientierung umdrehen
  const side = new THREE.Vector3().crossVectors(upL, dir).normalize();
  const up2 = new THREE.Vector3().crossVectors(dir, side).normalize();
  const m = new THREE.Matrix4().makeBasis(side, up2, dir);
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  const g = geo ? geo.clone() : new THREE.BoxGeometry(1, 1, 1);
  g.scale(w, h, len);
  g.applyMatrix4(m);
  return g;
}

/** Zylinder (Achse zwischen zwei Body-Punkten). */
export function rod(p0, p1, r0, r1 = r0, seg = 12, open = false) {
  const a = B(...p0), b = B(...p1);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * Extrusion eines Profils in der Body-x/z-Ebene (Punkte [x, z]) entlang Body-y von y0 bis y1.
 * Praktisch für Glareshield, Seitenwände (mit Löchern) usw.
 */
export function extrudeXZ(outline, y0, y1, holes = [], curveSegments = 6) {
  // Shape-Ebene: s = −x_lokal? Wir nehmen s = Body-x, t = −Body-z (oben), Extrusion w entlang Body-y.
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(y1 - y0), bevelEnabled: false, curveSegments });
  // (s, t, w) → lokal: x = w + y0, y = t, z = −s   (Rotation um Y um +90° und Verschiebung)
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  g.translate(Math.min(y0, y1), 0, 0);
  return g;
}

/** Extrusion eines Umrisses in der Body-y/z-Ebene (Punkte [y, z]) entlang Body-x (von x0 nach vorn bis x1). */
export function extrudeYZ(outline, x0, x1, holes = [], curveSegments = 24) {
  const shape = new THREE.Shape(outline.map(([y, z]) => new THREE.Vector2(y, -z)));
  for (const h of holes) {
    if (h.circle) {
      const p = new THREE.Path();
      p.absarc(h.circle[0], -h.circle[1], h.circle[2], 0, Math.PI * 2, true);
      shape.holes.push(p);
    } else shape.holes.push(new THREE.Path(h.map(([y, z]) => new THREE.Vector2(y, -z))));
  }
  const d = Math.abs(x1 - x0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, curveSegments });
  // Shape-Ebene (u = y, v = −z) liegt bereits in lokal x/y; Extrusion entlang lokal +z (= Body −x)
  g.translate(0, 0, -Math.max(x0, x1));
  return g;
}

/**
 * Geometrien zusammenführen (alle nicht-indiziert; Attribute position/normal/uv, optional color).
 * Spart Draw Calls: eine Geometrie pro Material.
 */
export function mergeGeometries(list) {
  const geos = list.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  const withColor = geos.some((g) => g.attributes.color);
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const col = withColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    if (col) {
      if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
      else col.fill(1, o * 3, (o + c) * 3);
    }
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Einfarbige Vertexfarbe setzen (für gemergte Mehrfarb-Meshes). */
export function tint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

/** Mesh mit Schatten-Flags und Layer. */
export function mesh(geo, mat, { layer = 0, cast = true, receive = true, name = '' } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.layers.set(layer);
  if (name) m.name = name;
  return m;
}

/** Radialer Glüh-Verlauf (Canvas) für Licht-Sprites. */
export function glowTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
