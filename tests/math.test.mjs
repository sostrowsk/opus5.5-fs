// Achsentests: Luftfahrt-Body-Achsen ↔ Three-Welt (genau eine Übersetzung: bodyToThree).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG, qFromEuler, qToEuler, qRot, qMul, bodyToThree, threeToBody, quatToThree, qIntegrate, headingToThree,
} from '../js/sim/math.js';

const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b} (±${tol})`);
const nearV = (a, b, tol = 1e-9, msg = '') => a.forEach((x, i) => near(x, b[i], tol, `${msg}[${i}]`));

// Three.js-Quaternion [x,y,z,w] auf Vektor anwenden (unabhängige Referenzimplementierung)
function threeQuatApply([x, y, z, w], v) {
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

test('Achsen: Nase Nord = −Z, rechter Flügel = +X, Body-unten = −Y (Kurs 0, horizontal)', () => {
  const q = qFromEuler(0, 0, 0);
  nearV(bodyToThree(q, [1, 0, 0]), [0, 0, -1], 1e-12, 'Nase');
  nearV(bodyToThree(q, [0, 1, 0]), [1, 0, 0], 1e-12, 'rechter Flügel');
  nearV(bodyToThree(q, [0, 0, 1]), [0, -1, 0], 1e-12, 'unten');
});

test('Achsen: Kurs 90° → Nase Ost (+X), Kurs 270° → Nase West (−X)', () => {
  nearV(bodyToThree(qFromEuler(90 * DEG, 0, 0), [1, 0, 0]), [1, 0, 0], 1e-12);
  nearV(bodyToThree(qFromEuler(270 * DEG, 0, 0), [1, 0, 0]), [-1, 0, 0], 1e-12);
  nearV(headingToThree(90), [1, 0, 0], 1e-12);
});

test('Achsen: Querneigung rechts = rechter Flügel nach unten, Nick positiv = Nase hoch', () => {
  const qBank = qFromEuler(0, 0, 30 * DEG);
  const wing = bodyToThree(qBank, [0, 1, 0]);
  assert.ok(wing[1] < -0.49, `rechter Flügel muss sinken, y=${wing[1]}`);
  const qPitch = qFromEuler(0, 10 * DEG, 0);
  const nose = bodyToThree(qPitch, [1, 0, 0]);
  near(nose[1], Math.sin(10 * DEG), 1e-12, 'Nase hoch');
});

test('Euler-Rundreise und Umkehrung threeToBody', () => {
  for (const [psi, th, ph] of [[10, 5, -20], [200, -30, 45], [359, 80, 170], [90, 0, 0]]) {
    const q = qFromEuler(psi * DEG, th * DEG, ph * DEG);
    const e = qToEuler(q);
    near(e.psi / DEG, psi, 1e-9, 'psi');
    near(e.theta / DEG, th, 1e-9, 'theta');
    near(e.phi / DEG, ph, 1e-9, 'phi');
    const v = [0.3, -1.2, 2.5];
    nearV(threeToBody(q, bodyToThree(q, v)), v, 1e-12);
  }
});

test('quatToThree passt zur Three-Modellkonvention (Nase −Z, rechts +X, oben +Y)', () => {
  for (const [psi, th, ph] of [[0, 0, 0], [45, 10, 20], [270, -15, -60], [123, 33, 5]]) {
    const q = qFromEuler(psi * DEG, th * DEG, ph * DEG);
    const Q = quatToThree(q);
    nearV(threeQuatApply(Q, [0, 0, -1]), bodyToThree(q, [1, 0, 0]), 1e-12, 'Nase');
    nearV(threeQuatApply(Q, [1, 0, 0]), bodyToThree(q, [0, 1, 0]), 1e-12, 'rechts');
    nearV(threeQuatApply(Q, [0, 1, 0]), bodyToThree(q, [0, 0, -1]), 1e-12, 'oben');
  }
});

test('Quaternion-Integration: positive Rollrate rollt nach rechts, positive Gierrate dreht nach rechts', () => {
  const q = qFromEuler(0, 0, 0);
  for (let i = 0; i < 120; i++) qIntegrate(q, [0.5, 0, 0], 1 / 120);
  near(qToEuler(q).phi, 0.5, 1e-6, 'phi nach 1 s');
  const q2 = qFromEuler(0, 0, 0);
  for (let i = 0; i < 120; i++) qIntegrate(q2, [0, 0, 0.2], 1 / 120);
  near(qToEuler(q2).psi, 0.2, 1e-6, 'psi nach 1 s');
  // Konsistenz qMul/qRot
  const a = qFromEuler(0.3, 0.2, 0.1), b = qFromEuler(-0.5, 0.4, 0.9);
  nearV(qRot(qMul(a, b), [1, 2, 3]), qRot(a, qRot(b, [1, 2, 3])), 1e-12);
});
