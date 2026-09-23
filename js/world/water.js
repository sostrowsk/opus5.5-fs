// Seen: Wasserfläche auf dem globalen Seespiegel mit Himmelsreflexion (dasselbe Streumodell wie der Himmel),
// Fresnel (Schlick), windabhängigen Wellen aus der Rauschtextur, Sonnen- bzw. Mondglitzern und Dunst.
// Die Geometrie liefert terrain.js (pro Kachel nur die Quads mit Wasser, geteilter Positionspuffer);
// der Vertex-Shader legt sie flach auf den Wasserspiegel.
import * as THREE from 'three';
import { WATER_LEVEL } from './heightfield.js';
import { SKY_GLSL } from './skymodel.js';
import { HAZE, HAZE_GLSL, CLOUD_SHADOW, CLOUD_SHADOW_GLSL } from './sky.js';
import { noiseTexture } from './noisetex.js';

const VERT = /* glsl */ `
uniform float uWaterLevel;
uniform vec2 uPatOrigin;
varying vec3 vW;
varying vec2 vPat;
#ifdef FAR
varying vec2 vFarXZ;
#endif
void main() {
  vec3 p = vec3(position.x, uWaterLevel, position.z);
  vec4 w = modelMatrix * vec4(p, 1.0);
  // In der Ferne leicht absenken (Tiefenpuffer-Auflösung): trockenes Ufer knapp über dem Seespiegel gewinnt
  // sicher gegen die Wasserfläche; der Seegrund liegt noch tiefer (terrain.js).
  float dCam = length(w.xyz - cameraPosition);
  p.y -= dCam * dCam * 1.2e-7;
  w.y -= dCam * dCam * 1.2e-7;
  vW = w.xyz;
  vPat = w.xz - uPatOrigin;
  #ifdef FAR
  vFarXZ = position.xz;
  #endif
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(p, 1.0));
}`;

const FRAG = /* glsl */ `
${SKY_GLSL}
${HAZE_GLSL}
${CLOUD_SHADOW_GLSL}
uniform sampler2D tNoise;
uniform float uTime, uWaveAmp, uOvercast;
uniform vec3 uLightCol, uAmb, uWaterCol;
varying vec3 vW;
varying vec2 vPat;
#ifdef FAR
uniform vec2 uNearMin;
uniform vec2 uNearMax;
uniform float uCov[25];
varying vec2 vFarXZ;
#endif
void main() {
  #ifdef FAR
  if (all(greaterThan(vFarXZ, uNearMin + 0.5)) && all(lessThan(vFarXZ, uNearMax - 0.5))) {
    ivec2 t = ivec2(floor((vFarXZ - uNearMin) / 1024.0));
    if (uCov[t.y * 5 + t.x] > 0.5) discard;
  }
  #endif
  vec3 V = cameraPosition - vW;
  float dist = length(V);
  V /= max(dist, 1e-3);
  float fade = 1.0 - smoothstep(250.0, 5000.0, dist);
  // Wellen: drei Oktaven mit vertauschten/gespiegelten Achsen (bricht die Kachelung) und Zweierpotenz-Maßstäben,
  // damit das Muster über den Musterursprung-Sprung (32 768 m) periodisch bleibt; feine Oktaven blenden mit der
  // Entfernung aus, bevor ihr Wiederholmuster auffällt
  vec4 n1 = texture(tNoise, vPat / 512.0 + uTime * vec2(0.0021, 0.0013));
  vec4 n2 = texture(tNoise, vPat.yx / 128.0 + uTime * vec2(-0.009, 0.012));
  vec4 n3 = texture(tNoise, vec2(-vPat.x, vPat.y) / 32.0 + uTime * vec2(0.035, -0.027));
  float f2 = 1.0 - smoothstep(600.0, 2500.0, dist), f3 = 1.0 - smoothstep(120.0, 700.0, dist);
  vec2 slope = (n1.rg - 0.5) * 0.7 + (n2.ba - 0.5) * 0.9 * f2 + (n3.gr - 0.5) * 0.7 * f3;
  slope *= uWaveAmp * (0.45 + 0.55 * fade);
  vec3 N = normalize(vec3(slope.x, 1.0, slope.y));
  float cosi = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = skyRadiance(R, uHazeSunDir);
  float l = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  sky = mix(sky, vec3(l), uOvercast * 0.5);
  sky = mix(hazeColor(normalize(vec3(R.x, 0.0, R.z))), sky, smoothstep(0.0, 0.07, R.y));
  float cs = cloudShadow(vW);
  // Wasserkörper: dunkles Blaugrün, vom Himmel und etwas von der Sonne aufgehellt
  vec3 body = uWaterCol * (uAmb + uLightCol * max(uLightDir.y, 0.0) * 0.25 * cs);
  vec3 col = mix(body, sky, F);
  // Glitzern: scharf in der Nähe, breiter Glanzstreifen in der Ferne
  float rs = max(dot(R, uLightDir), 0.0);
  float spec = pow(rs, mix(250.0, 1400.0, fade)) * mix(4.0, 22.0, fade) + pow(rs, 60.0) * 0.12;
  col += uLightCol * spec * cs;
  col = applyHaze(col, vW);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createWater() {
  const shared = {
    tNoise: { value: noiseTexture() },
    uTime: { value: 0 },
    uWaveAmp: { value: 0.2 },
    uOvercast: { value: 0 },
    uLightCol: { value: new THREE.Color(1, 1, 1) },
    uAmb: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uWaterCol: { value: new THREE.Color(0x0e2a33) },
    uWaterLevel: { value: WATER_LEVEL },
    uPatOrigin: { value: new THREE.Vector2() },
  };
  const make = (far) =>
    new THREE.ShaderMaterial({
      uniforms: { ...HAZE, ...CLOUD_SHADOW, ...shared },
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: far ? { FAR: '' } : {},
      fog: false,
    });
  const material = make(false);
  const farMaterial = make(true);
  let time = 0;

  /**
   * Pro Frame: dt (s), windKt (Wellenhöhe), Licht (THREE.DirectionalLight: Sonne bzw. Mond),
   * Himmelslicht (Farbe × Intensität) und Bedeckung 0..1.
   */
  function update(dt, opts = {}) {
    // Periode 10 000 s: alle Scroll-Geschwindigkeiten (s. Shader) × Periode sind ganzzahlig, die Kacheltextur
    // wiederholt sich also exakt – kein sichtbarer Phasensprung beim Umlauf.
    time = (time + dt) % 10000;
    shared.uTime.value = time;
    const w = opts.windKt ?? 8;
    shared.uWaveAmp.value = Math.min(0.75, 0.06 + 0.022 * w);
    if (opts.light) shared.uLightCol.value.copy(opts.light.color).multiplyScalar(opts.light.intensity);
    if (opts.skyColor) shared.uAmb.value.copy(opts.skyColor).multiplyScalar(opts.skyIntensity ?? 1);
    shared.uOvercast.value = opts.coverage ?? 0;
  }

  return { material, farMaterial, update, uniforms: shared };
}
