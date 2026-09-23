// Einstellungen: Defaults und Wertebereiche nach SPEC §4.3, Laden/Speichern in localStorage (mit try/catch,
// die Seite funktioniert auch ohne). Die Menü-Anbindung folgt in AP9; Input, Audio und Sichtfeld lesen schon hier.

const reducedMotion = (() => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();
const coarse = (() => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
})();

/** Wertebereiche: [min, max, step, default] bzw. Auswahl/Toggle. */
export const SETTINGS_DEF = {
  timeOfDay: { min: 0, max: 24, step: 0.1, def: 10 },
  windDir: { min: 0, max: 359, step: 1, def: 240 },
  windKt: { min: 0, max: 35, step: 1, def: 8 },
  turbulence: { min: 0, max: 100, step: 1, def: 20 },
  clouds: { min: 0, max: 100, step: 1, def: 35 },
  cloudBase_ft: { min: 1500, max: 9000, step: 100, def: 4000 },
  qnh: { min: 980, max: 1040, step: 1, def: 1013 },
  mass: { min: 800, max: 1089, step: 1, def: 1000 },
  quality: { options: ['low', 'medium', 'high'], def: coarse ? 'low' : 'medium' },
  fov: { min: 50, max: 90, step: 1, def: 70 },
  mouseSens: { min: 0.2, max: 3, step: 0.1, def: 1 },
  yokeMouse: { bool: true, def: false },
  invertElevator: { bool: true, def: false },
  volume: { min: 0, max: 100, step: 1, def: 70 },
  muted: { bool: true, def: false },
  showHud: { bool: true, def: false },
  headMotion: { min: 0, max: 100, step: 1, def: reducedMotion ? 0 : 50 },
  coordAssist: { bool: true, def: false },
  touchLayout: { options: ['auto', 'on', 'off'], def: 'auto' },
};

const KEY = 'c172web.settings.v1';

/** Live-Abfrage prefers-reduced-motion (Kopfbewegung dann immer aus – auch bei gespeichertem Wert > 0). */
const rmQuery = (() => {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
})();
export function prefersReducedMotion() {
  return !!rmQuery?.matches;
}

export function defaultSettings() {
  const s = {};
  for (const [k, d] of Object.entries(SETTINGS_DEF)) s[k] = d.def;
  return s;
}

/** Einen Wert auf seinen Bereich bzw. seine Optionen einschränken; ungültige Werte → Default. */
export function sanitize(key, value) {
  const d = SETTINGS_DEF[key];
  if (!d) return undefined;
  if (d.bool) return typeof value === 'boolean' ? value : d.def;
  if (d.options) return d.options.includes(value) ? value : d.def;
  const n = Number(value);
  if (!Number.isFinite(n)) return d.def;
  return Math.min(d.max, Math.max(d.min, n));
}

export function loadSettings() {
  const s = defaultSettings();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) {
      const o = JSON.parse(raw);
      for (const k of Object.keys(SETTINGS_DEF)) if (k in o) s[k] = sanitize(k, o[k]);
    }
  } catch {
    /* ohne localStorage: Defaults */
  }
  return s;
}

export function saveSettings(s) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignorieren */
  }
}
