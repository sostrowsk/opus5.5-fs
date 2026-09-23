// Touch-Layout (SPEC §4.6): links ein virtueller Yoke-Stick (Rückstellung in die Mitte), rechts ein vertikaler
// Gashebel-Slider, unten ein Seitenruder-Slider (federt zurück), Buttons für Klappen, Bremse (halten), Trimmung
// (halten), Ansicht und Pause. Buttons ≥ 44 × 44 CSS-px, halbtransparent, nach 4 s ohne Bedienung 30 % Deckkraft.
// Sichtbar automatisch bei `pointer: coarse` (Einstellung touchLayout 'auto'), sonst per Einstellung 'on'/'off'.
// Im Hochformat erscheint der Hinweis „Bitte Gerät drehen“.
import { clamp } from '../sim/math.js';

const IDLE_MS = 4000;

function el(tag, cls, attrs = {}, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * ctx: { input, controls, settings, actions: { cycleView(), pause(), onUserGesture() } }
 */
export function createTouch(ctx) {
  const { input, controls: ctl, settings } = ctx;
  const root = el('div', 'touch', { id: 'touch', 'aria-label': 'Touch-Steuerung' }, document.body);
  const hint = el('div', 'rotate-hint', { id: 'rotate-hint', role: 'alert' }, document.body);
  el('div', 'rotate-hint-icon', { 'aria-hidden': 'true', text: '⟳' }, hint);
  el('div', '', { text: 'Bitte Gerät drehen' }, hint);
  el('div', 'rotate-hint-sub', { text: 'Der Flugsimulator braucht das Querformat.' }, hint);

  // ---------------------------------------------------------------- Stick
  const stick = el('div', 't-stick', { role: 'slider', 'aria-label': 'Steuerhorn (Nick/Roll)' }, root);
  el('div', 't-stick-cross', {}, stick);
  const knob = el('div', 't-stick-knob', {}, stick);
  let stickId = null;
  function stickFrom(e) {
    const r = stick.getBoundingClientRect();
    const R = r.width / 2;
    if (!(R > 0)) return; // ausgeblendet (z. B. beim Drehen ins Hochformat): keine Division durch 0
    let x = (e.clientX - (r.left + R)) / R, y = (e.clientY - (r.top + R)) / R;
    const l = Math.hypot(x, y);
    if (l > 1) (x /= l), (y /= l);
    knob.style.transform = `translate(${(x * R * 0.72).toFixed(1)}px, ${(y * R * 0.72).toFixed(1)}px)`;
    input.setStick('touch', y, x); // Daumen nach unten = ziehen
  }
  function stickEnd() {
    stickId = null;
    knob.style.transform = '';
    stick.classList.remove('active');
    input.setStick('touch', 0, 0);
  }
  capture(stick, {
    down(e) {
      stickId = e.pointerId;
      stick.classList.add('active');
      stickFrom(e);
    },
    move(e) {
      if (e.pointerId === stickId) stickFrom(e);
    },
    up(e) {
      if (e.pointerId === stickId) stickEnd();
    },
  });

  // ---------------------------------------------------------------- Gas
  const thr = el('div', 't-throttle', { role: 'slider', 'aria-label': 'Gas', 'aria-valuemin': '0', 'aria-valuemax': '100' }, root);
  const thrFill = el('div', 't-throttle-fill', {}, thr);
  const thrKnob = el('div', 't-throttle-knob', {}, thr);
  const thrLabel = el('div', 't-throttle-label', { text: 'GAS' }, thr);
  let thrId = null;
  function thrFrom(e) {
    if (input.blocked) return;
    const r = thr.getBoundingClientRect();
    const pad = 22; // halbe Knopfhöhe: 0 % / 100 % liegen noch ganz auf dem Slider
    const v = 1 - (e.clientY - r.top - pad) / Math.max(1, r.height - 2 * pad);
    input.activate();
    ctl.throttle = clamp(v, 0, 1);
  }
  capture(thr, {
    down(e) {
      thrId = e.pointerId;
      thrFrom(e);
    },
    move(e) {
      if (e.pointerId === thrId) thrFrom(e);
    },
    up(e) {
      if (e.pointerId === thrId) thrId = null;
    },
  });

  // ---------------------------------------------------------------- Seitenruder
  const rud = el('div', 't-rudder', { role: 'slider', 'aria-label': 'Seitenruder' }, root);
  el('div', 't-rudder-center', {}, rud);
  const rudKnob = el('div', 't-rudder-knob', {}, rud);
  let rudId = null;
  function rudFrom(e) {
    const r = rud.getBoundingClientRect();
    if (!(r.width > 44)) return; // ausgeblendet/entartet: kein Scheinausschlag
    const v = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 - 22), -1, 1);
    rudKnob.style.transform = `translateX(${(v * (r.width / 2 - 24)).toFixed(1)}px)`;
    input.setRudder(v);
  }
  capture(rud, {
    down(e) {
      rudId = e.pointerId;
      rud.classList.add('active');
      rudFrom(e);
    },
    move(e) {
      if (e.pointerId === rudId) rudFrom(e);
    },
    up(e) {
      if (e.pointerId !== rudId) return;
      rudId = null;
      rud.classList.remove('active');
      rudKnob.style.transform = '';
      input.setRudder(0);
    },
  });

  // ---------------------------------------------------------------- Buttons
  const topL = el('div', 't-group t-top-left', {}, root);
  const topR = el('div', 't-group t-top-right', {}, root);
  function button(parent, text, aria, onDown, onUp) {
    const b = el('button', 't-btn', { type: 'button', 'aria-label': aria, tabindex: '-1' }, parent);
    b.innerHTML = text;
    let id = null;
    capture(b, {
      down(e) {
        id = e.pointerId;
        b.classList.add('active');
        onDown?.();
      },
      up(e) {
        if (e.pointerId !== id) return;
        id = null;
        b.classList.remove('active');
        onUp?.();
      },
    });
    return b;
  }
  button(topL, '❚❚', 'Pause', () => ctx.actions.pause?.()).dataset.always = '1';
  button(topL, '<span class="t-ico">◎</span><small>Ansicht</small>', 'Ansicht wechseln', () => ctx.actions.cycleView?.());
  const flapGroup = el('div', 't-pair', {}, topR);
  button(flapGroup, '▲<small>Klappen</small>', 'Klappen einfahren', () => input.flaps(-1));
  const flapRead = el('div', 't-read', { text: '0°' }, flapGroup);
  button(flapGroup, '▼<small>Klappen</small>', 'Klappen ausfahren', () => input.flaps(1));
  const trimGroup = el('div', 't-pair', {}, topR);
  // Trimm ▲ = Nase hoch (wie Rad nach hinten), ▼ = Nase tief; halten → Rampe wie Taste G/T
  button(trimGroup, '▲<small>Trimm</small>', 'Trimmung Nase hoch (halten)', () => input.press('KeyG'), () => input.release('KeyG'));
  const trimRead = el('div', 't-read', { text: '0' }, trimGroup);
  button(trimGroup, '▼<small>Trimm</small>', 'Trimmung Nase tief (halten)', () => input.press('KeyT'), () => input.release('KeyT'));
  const brake = button(root, 'BREMSE', 'Radbremse (halten)', () => input.press('KeyB'), () => input.release('KeyB'));
  brake.classList.add('t-brake');

  // ---------------------------------------------------------------- Aktivität / Ausblenden
  let idleTimer = 0;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('idle'), IDLE_MS);
  }
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') wake();
  }, true);
  root.addEventListener('pointermove', wake);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  /** Pointer-Capture-Helfer: down/move/up/cancel; ignoriert Maus-Rechtsklick. */
  function capture(node, h) {
    node.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (input.blocked && !node.dataset.always) return; // Menü offen: keine Flugsteuerung
      ctx.actions.onUserGesture?.();
      wake();
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        /* synthetische Events */
      }
      h.down?.(e);
    });
    if (h.move) node.addEventListener('pointermove', (e) => h.move(e));
    const end = (e) => h.up?.(e);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', end);
  }

  // Blur / verdeckter Tab / Menü: alles loslassen
  // (clearAll hat die Demands bereits genullt – hier nur die Anzeige zurücksetzen)
  input.onClear(() => {
    stickId = rudId = thrId = null;
    knob.style.transform = '';
    rudKnob.style.transform = '';
    for (const b of root.querySelectorAll('.active')) b.classList.remove('active');
  });

  // ---------------------------------------------------------------- Sichtbarkeit
  const mq = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  let visible = false;
  function refresh() {
    const mode = settings.touchLayout || 'auto';
    const on = mode === 'on' || (mode === 'auto' && !!mq?.matches);
    if (on === visible) return;
    visible = on;
    document.body.classList.toggle('touch-on', on);
    if (on) wake();
    else input.clearAll?.();
  }
  mq?.addEventListener?.('change', refresh);
  refresh();

  /** Pro Frame: Anzeigen an controls angleichen (Tastatur kann parallel ändern). */
  function update() {
    refresh();
    if (!visible) return;
    const t = clamp(ctl.throttle, 0, 1);
    thrKnob.style.bottom = `calc(${(t * 100).toFixed(1)}% - ${(t * 44).toFixed(1)}px)`;
    thrFill.style.height = `${(t * 100).toFixed(1)}%`;
    thr.setAttribute('aria-valuenow', String(Math.round(t * 100)));
    const lbl = `${Math.round(t * 100)}%`;
    if (thrLabel.textContent !== lbl) thrLabel.textContent = lbl;
    const f = `${Math.round(ctl.flapsCmd) * 10}°`;
    if (flapRead.textContent !== f) flapRead.textContent = f;
    const tr = Math.round(ctl.trim * 100);
    const ts = tr > 0 ? `+${tr}` : String(tr);
    if (trimRead.textContent !== ts) trimRead.textContent = ts;
    brake.classList.toggle('park', !!ctl.parkingBrake);
  }

  const portraitMq = typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null;
  return {
    update,
    refresh,
    root,
    get visible() {
      return visible;
    },
    /** Hochformat mit Touch-Layout: der Drehhinweis verdeckt Ansicht und Bedienelemente → Simulation anhalten. */
    get portraitBlocked() {
      return visible && !!portraitMq && portraitMq.matches;
    },
  };
}
