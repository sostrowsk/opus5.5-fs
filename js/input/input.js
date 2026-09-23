// Eingabe → controls (einzige Quelle für die Physik), SPEC §4.4–4.6 / PLAN §2.8.
// Eine Demand-Schicht mischt Tastatur, Maus-Yoke und Touch: je Achsgruppe (Nick/Roll, Seitenruder) gewinnt
// die zuletzt aktive Quelle. Tastatur-Ruder laufen als Rampe (1,5/s hoch, 3/s zurück auf 0); Trimmung ist ein
// eigener Kanal und verschiebt nie den Yoke-Nullpunkt. update(dt) läuft im festen Physiktakt (Determinismus).
// Ohne three und ohne DOM-Zwang: Ereignisquelle ist `opts.target` (Standard: window), damit Node-Tests laufen.
import { clamp } from '../sim/math.js';

export const RAMP_UP = 1.5; // pro s, solange die Taste gehalten wird
export const RAMP_BACK = 3.0; // pro s zurück auf 0 (auch beim Richtungswechsel)
export const THROTTLE_RATE = 0.5; // pro s
export const TRIM_RATE = 0.25; // pro s
export const IGN_HOLD = 0.35; // s Halten bis START
const ASSIST_K_BETA = 0.15; // Seitenruder pro Grad Schiebewinkel
const ASSIST_K_AIL = 0.3; // Seitenruder-Vorhalt pro Querruder
const ASSIST_AGL_MIN = 30; // m – darunter keine Koordinationshilfe (SPEC §4.3)

/** Tasten, deren Browser-Standardaktion wir unterdrücken (ohne Ctrl/Meta). */
const OWN = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'F5', 'F6', 'Space',
  'Escape', // Esc öffnet die Pause – ohne preventDefault würde der Browser den gerade geöffneten Dialog sofort schließen
]);
const PR_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const RUD_L = ['KeyZ', 'KeyY', 'Comma'];
const RUD_R = ['KeyX', 'Period'];
const RUD_KEYS = new Set([...RUD_L, ...RUD_R]);
const THR_UP = ['PageUp', 'Equal', 'BracketRight', 'NumpadAdd'];
const THR_DN = ['PageDown', 'Minus', 'Slash', 'NumpadSubtract'];

const isFormField = (t) => {
  if (!t || typeof t !== 'object') return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable) return true;
  return typeof t.closest === 'function' && !!t.closest('dialog[open]');
};

/**
 * opts: {
 *   controls, lights ({landing, nav, strobe, beacon}),
 *   actions: { view(name), toggleExternal(), center(), pause(), reset(), toggleHud(), help() },
 *   settings: { invertElevator, coordAssist } (live gelesen),
 *   getState: () => state (für die Koordinationshilfe: beta_deg, agl, onGround),
 *   target: EventTarget für keydown/keyup/blur (Standard window; null = keine Listener)
 * }
 */
export function createInput(opts) {
  const ctl = opts.controls;
  const actions = opts.actions || {};
  const lights = opts.lights || {};
  const settings = opts.settings || {};
  const down = new Set(); // gehaltene Tasten (echte und virtuelle, z. B. Touch-Buttons)
  const st = { elevator: 0, aileron: 0, rudder: 0 }; // Tastatur-Rampenwerte bzw. zuletzt übernommene Demands
  const src = { pr: 'key', rud: 'key' }; // zuletzt aktive Quelle je Achsgruppe
  const ext = { mouse: { e: 0, a: 0 }, touch: { e: 0, a: 0 }, touchRud: 0 };
  let suspended = false; // SIM.setControls überschreibt, bis echter Input kommt
  let engaged = false; // vor der ersten Eingabe bleiben die Szenario-Werte unangetastet
  let blocked = false; // Menü offen → keine Flugsteuerung (SPEC §4.7)
  let ignHeld = 0;
  let assisting = false; // Koordinationshilfe hat im letzten Schritt das Seitenruder gesetzt
  let baseRudder = 0;
  const clearHooks = [];

  function sync() {
    st.elevator = ctl.elevator;
    st.aileron = ctl.aileron;
    st.rudder = ctl.rudder;
  }

  /** Echte Nutzereingabe: Suspend aufheben, Demand-Schicht übernimmt. */
  function activate() {
    if (suspended) {
      suspended = false;
      sync();
    }
    if (!engaged) {
      engaged = true;
      sync();
    }
  }

  function flaps(dir) {
    if (blocked) return;
    ctl.flapsCmd = clamp(Math.round(ctl.flapsCmd) + dir, 0, 3);
  }

  /** Tastendruck (erste Flanke). key = e.key (für Shift-Kombinationen), shift = Shift gehalten. */
  function press(code, key = '', shift = false) {
    if (blocked) return;
    activate();
    if (down.has(code)) return; // Tastenwiederholung ignorieren (Rampen laufen über update)
    down.add(code);
    if (PR_KEYS.has(code)) {
      if (src.pr !== 'key') {
        st.elevator = ctl.elevator;
        st.aileron = ctl.aileron;
      }
      src.pr = 'key';
    }
    if (RUD_KEYS.has(code)) {
      if (src.rud !== 'key') st.rudder = ctl.rudder;
      src.rud = 'key';
    }
    switch (code) {
      case 'KeyF':
      case 'F5':
        flaps(-1);
        break;
      case 'KeyV':
      case 'F6':
        flaps(1);
        break;
      case 'KeyB':
        if (shift) ctl.parkingBrake = !ctl.parkingBrake;
        break;
      case 'KeyL':
        lights.landing = !lights.landing;
        break;
      case 'KeyO':
        lights.nav = !lights.nav;
        lights.strobe = lights.nav;
        lights.beacon = lights.nav;
        break;
      case 'KeyI':
        ignHeld = 0;
        break;
      case 'KeyC':
        actions.toggleExternal?.();
        break;
      case 'Digit1':
        actions.view?.('front');
        break;
      case 'Digit2':
        actions.view?.('left');
        break;
      case 'Digit3':
        actions.view?.('right');
        break;
      case 'Digit4':
        actions.view?.('panel');
        break;
      case 'Space':
        actions.center?.();
        break;
      case 'KeyH':
        actions.toggleHud?.();
        break;
      case 'KeyP':
      case 'Escape':
        actions.pause?.();
        break;
      case 'KeyR':
        actions.reset?.();
        break;
      default:
        break;
    }
    if (key === '?') actions.help?.();
    // Gas voll / Leerlauf mit Shift
    // (US: Shift+= → „+“, Shift+- → „_“; DE: Shift++ → „*“, Shift+- → „_“)
    if (shift && (key === '+' || key === '*' || code === 'NumpadAdd')) ctl.throttle = 1;
    if (shift && (key === '_' || code === 'NumpadSubtract')) ctl.throttle = 0;
  }

  function release(code) {
    const tracked = down.delete(code); // nur Tasten auswerten, deren Druck wir auch verarbeitet haben
    if (code === 'KeyI' && tracked) {
      // kurzer Tipp: OFF ↔ BOTH; nach START zurück auf BOTH (Schlüssel federt zurück)
      if (ctl.ignition === 'START') ctl.ignition = 'BOTH';
      else if (ignHeld < IGN_HOLD) ctl.ignition = ctl.ignition === 'OFF' ? 'BOTH' : 'OFF';
    }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (blocked || isFormField(e.target)) return;
    if (OWN.has(e.code)) e.preventDefault?.();
    // Autorepeat nie als neuer Druck werten – auch nicht, nachdem clearAll() (z. B. durch Pause) die Taste
    // aus `down` entfernt hat; sonst hebt gehaltenes P/Esc die eigene Pause wieder auf.
    if (e.repeat) return;
    press(e.code, e.key, e.shiftKey);
  }
  function onKeyUp(e) {
    release(e.code);
  }

  /** Fokusverlust / verdeckter Tab / Menü: alles Gehaltene lösen, keine hängenden Ruder (SPEC §3.1, AK-35). */
  function clearAll() {
    down.clear();
    ignHeld = 0;
    if (ctl.ignition === 'START') ctl.ignition = 'BOTH'; // Anlasser ist ein Tastschalter
    st.elevator = st.aileron = st.rudder = 0;
    ext.mouse.e = ext.mouse.a = 0;
    ext.touch.e = ext.touch.a = 0;
    ext.touchRud = 0;
    src.pr = src.rud = 'key';
    if (!suspended) {
      ctl.elevator = ctl.aileron = ctl.rudder = 0;
      ctl.brakeL = ctl.brakeR = 0;
    }
    for (const f of clearHooks) f();
  }

  const target = opts.target === undefined ? (typeof window !== 'undefined' ? window : null) : opts.target;
  if (target) {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', clearAll);
  }

  const ramp = (cur, dir, dt) => {
    if (dir !== 0) {
      // in Gegenrichtung zuerst zügig zurück, dann Rampe hoch
      const rate = cur !== 0 && Math.sign(cur) !== dir ? RAMP_BACK : RAMP_UP;
      const next = cur + dir * rate * dt;
      // beim Nulldurchgang nicht mit der schnellen Rate über 0 hinausschießen
      if (rate === RAMP_BACK && Math.sign(next) !== Math.sign(cur)) return 0;
      return clamp(next, -1, 1);
    }
    if (cur > 0) return Math.max(0, cur - RAMP_BACK * dt);
    if (cur < 0) return Math.min(0, cur + RAMP_BACK * dt);
    return 0;
  };
  const has = (...keys) => keys.some((k) => down.has(k));

  /** Einmal pro Physikschritt: Rampen & gehaltene Tasten/Demands → controls. */
  function update(dt) {
    if (suspended) return;
    if (engaged) {
      const inv = settings.invertElevator ? -1 : 1;
      if (src.pr === 'key') {
        // Nicht invertiert: ↑ = drücken (−), ↓ = ziehen (+)
        const elevDir = ((has('ArrowDown') ? 1 : 0) - (has('ArrowUp') ? 1 : 0)) * inv;
        const ailDir = (has('ArrowRight') ? 1 : 0) - (has('ArrowLeft') ? 1 : 0);
        st.elevator = ramp(st.elevator, elevDir, dt);
        st.aileron = ramp(st.aileron, ailDir, dt);
      } else {
        const s = ext[src.pr];
        st.elevator = clamp(s.e * inv, -1, 1);
        st.aileron = clamp(s.a, -1, 1);
      }
      if (src.rud === 'touch') st.rudder = clamp(ext.touchRud, -1, 1);
      else st.rudder = ramp(st.rudder, (has(...RUD_R) ? 1 : 0) - (has(...RUD_L) ? 1 : 0), dt);
      ctl.elevator = st.elevator;
      ctl.aileron = st.aileron;
      ctl.rudder = st.rudder;

      const shift = has('ShiftLeft', 'ShiftRight');
      if (!shift) {
        const thrDir = (has(...THR_UP) ? 1 : 0) - (has(...THR_DN) ? 1 : 0);
        if (thrDir) ctl.throttle = clamp(ctl.throttle + thrDir * THROTTLE_RATE * dt, 0, 1);
      }
      const trimDir = (has('Home', 'KeyT') ? -1 : 0) + (has('End', 'KeyG') ? 1 : 0); // T/Pos1 = nachdrücken
      if (trimDir) ctl.trim = clamp(ctl.trim + trimDir * TRIM_RATE * dt, -1, 1);
      const brake = has('KeyB') && !shift ? 1 : 0;
      ctl.brakeL = Math.max(brake, has('KeyN') ? 1 : 0);
      ctl.brakeR = Math.max(brake, has('KeyM') ? 1 : 0);

      if (has('KeyI')) {
        ignHeld += dt;
        if (ignHeld >= IGN_HOLD) ctl.ignition = 'START'; // Schlüssel über BOTH hinaus drehen (auch aus OFF)
      }
    }

    // Koordinationshilfe: nur Eingabe (Seitenruder ∝ β + Querruder-Vorhalt), nur > 30 m AGL,
    // jede manuelle Seitenruder-Eingabe hat Vorrang.
    let assist = null;
    if (settings.coordAssist && opts.getState && !blocked) { // Menü offen → Steuerung bleibt neutral
      const s = opts.getState();
      const manual = engaged && (st.rudder !== 0 || has(...RUD_KEYS) || (src.rud === 'touch' && ext.touchRud !== 0));
      if (s && !manual && !s.onGround && !s.crashed) {
        const fade = clamp((s.agl - ASSIST_AGL_MIN) / 10, 0, 1);
        if (fade > 0) assist = clamp(fade * (ASSIST_K_BETA * s.beta_deg + ASSIST_K_AIL * ctl.aileron), -1, 1);
      }
    }
    if (assist !== null) {
      if (!assisting) baseRudder = engaged ? st.rudder : ctl.rudder; // unassistierte Stellung merken
      assisting = true;
      ctl.rudder = assist;
    } else if (assisting) {
      // Hilfe greift nicht mehr (unter 30 m, Boden, abgeschaltet, manuell): kein Rest-Ausschlag
      assisting = false;
      ctl.rudder = engaged ? st.rudder : baseRudder;
    }
  }

  return {
    update,
    sync,
    clearAll,
    press,
    release,
    flaps,
    activate,
    /** Analoge Nick/Roll-Demand einer Quelle ('mouse' | 'touch'): e +1 = ziehen (vor Invertierung), a +1 = rechts. */
    setStick(source, e, a) {
      if (blocked) return;
      activate();
      ext[source].e = e;
      ext[source].a = a;
      src.pr = source;
    },
    /** Analoges Seitenruder vom Touch-Slider (−1..1). */
    setRudder(v) {
      if (blocked) return;
      activate();
      ext.touchRud = v;
      src.rud = 'touch';
    },
    /** Nach dem Loslassen der Maus-Quelle wieder die Tastatur-Rampe aktiv (Wert läuft von der Lage aus auf 0). */
    releaseSource(source) {
      ext[source].e = ext[source].a = 0;
      if (src.pr === source) src.pr = 'key';
    },
    /** SIM.setControls: Eingabe pausieren, bis wieder echter Input kommt. */
    suspend() {
      suspended = true;
    },
    setBlocked(b) {
      blocked = !!b;
      if (blocked) clearAll();
    },
    onClear(fn) {
      clearHooks.push(fn);
    },
    get blocked() {
      return blocked;
    },
    get suspended() {
      return suspended;
    },
    get source() {
      return { ...src };
    },
    keys: down,
    onKeyDown,
    onKeyUp,
  };
}
