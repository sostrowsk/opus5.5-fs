// AK-38 (Teil): Kontrast der Menü- und Datenleisten-Texte ≥ 4,5:1, berechnet aus den CSS-Tokens in css/app.css.
// Halbtransparente Hintergründe werden für den ungünstigsten Fall über Weiß (bzw. Schwarz) gelegt.
// Dazu: Einstellungs-Metadaten der UI decken jeden Regler aus SPEC §4.3 ab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_DEF, defaultSettings, sanitize } from '../js/config.js';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function parse(c) {
  c = c.trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error('Farbe nicht lesbar: ' + c);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const T = (name) => parse(tokens[name]);
const WHITE = [255, 255, 255, 1], BLACK = [0, 0, 0, 1];
/** Kontrast im ungünstigeren Fall (halbtransparenter Grund über Weiß oder Schwarz). */
const worst = (fg, bg) => Math.min(ratio(over(fg, over(bg, WHITE)), over(bg, WHITE)), ratio(over(fg, over(bg, BLACK)), over(bg, BLACK)));

test('AK-38 Kontrast: alle Text/Hintergrund-Paare der Menüs und der Datenleiste ≥ 4,5:1', () => {
  const pairs = [
    ['text', 'panel'], ['muted', 'panel'], ['green', 'panel'], ['amber', 'panel'],
    ['text', 'panel-solid'], ['muted', 'panel-solid'],
    ['text', 'field'], ['muted', 'field'],
    ['green-ink', 'green'], ['amber-ink', 'amber'], ['red-ink', 'red'],
    ['text', 'hud-bg'], ['muted', 'hud-bg'], ['amber', 'hud-bg'],
    ['text', 'bg'], ['muted', 'bg'],
  ];
  const res = {};
  for (const [fg, bg] of pairs) {
    const r = worst(T(fg), T(bg));
    res[`${fg}/${bg}`] = +r.toFixed(2);
    assert.ok(r >= 4.5, `${fg} auf ${bg}: ${r.toFixed(2)}:1`);
  }
  if (process.env.AK_REPORT) console.log('[AK-38]', JSON.stringify(res));
});

test('AK-38 Fokus sichtbar: Fokusrahmen-Farbe hebt sich vom Dialog ab (≥ 3:1)', () => {
  assert.match(css, /:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.ok(worst(T('focus'), T('panel')) >= 3);
});

test('AK-38 reduced motion: Übergänge aus', () => {
  const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(i > 0);
  assert.match(css.slice(i, i + 300), /--fade:\s*0ms/);
});

test('AK-27 Einstellungen: alle Regler aus SPEC §4.3 mit Bereich und Default', async () => {
  // ui.js braucht das DOM erst beim Aufruf von createUI – die Metadaten sind importierbar
  const { SETTINGS_UI } = await import('../js/ui/ui.js');
  const shown = SETTINGS_UI.flatMap((g) => g.items.map((i) => i[0]));
  const spec = {
    timeOfDay: [0, 24, 10], windDir: [0, 359, 240], windKt: [0, 35, 8], turbulence: [0, 100, 20], clouds: [0, 100, 35],
    cloudBase_ft: [1500, 9000, 4000], qnh: [980, 1040, 1013], mass: [800, 1089, 1000], fov: [50, 90, 70],
    mouseSens: [0.2, 3, 1], volume: [0, 100, 70],
  };
  for (const [k, [min, max, def]] of Object.entries(spec)) {
    assert.ok(shown.includes(k), `${k} fehlt im Menü`);
    assert.equal(SETTINGS_DEF[k].min, min);
    assert.equal(SETTINGS_DEF[k].max, max);
    assert.equal(SETTINGS_DEF[k].def, def);
  }
  for (const k of ['quality', 'yokeMouse', 'invertElevator', 'showHud', 'headMotion', 'coordAssist']) assert.ok(shown.includes(k), `${k} fehlt`);
  assert.deepEqual(SETTINGS_DEF.quality.options, ['low', 'medium', 'high']);
  assert.equal(SETTINGS_DEF.headMotion.def, 50); // Node: kein reduced motion
  assert.equal(defaultSettings().yokeMouse, false);
  assert.equal(sanitize('fov', 200), 90);
  assert.equal(sanitize('quality', 'ultra'), SETTINGS_DEF.quality.def);
});
