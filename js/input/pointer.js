// Maus & Pointer auf der 3D-Ansicht (SPEC §4.5, §4.6 „Ein-Finger-Drag dreht den Blick“):
// - Umsehen: rechte/mittlere Taste oder Alt + links ziehen (Touch: Ein-Finger-Drag auf freier Fläche)
// - Mausrad: FOV-Zoom 40–90° (Außenansicht: Abstand); über Trimmrad/Kollsman/HI-Knopf verstellt es diese
// - Klickbare Bedienelemente per Raycast gegen die Hit-Zonen des Cockpits, Hand-Cursor + dezenter Tooltip
// - Yoke-Modus: Mausposition relativ zur Bildschirmmitte → Nick/Roll (Cursor bleibt sichtbar)
import * as THREE from 'three';
import { clamp } from '../sim/math.js';

export const LOOK_LIMITS = { yawMin: -150, yawMax: 150, pitchMin: -60, pitchMax: 45 };
export const FOV_ZOOM = { min: 40, max: 90 };
const LOOK_DEG_PER_PX = 0.16;
const THROTTLE_PX = 200; // CSS-px vertikaler Drag für den vollen Gasweg
const TRIM_PX = 260; // CSS-px für den halben Trimmbereich (0 → ±1)
const YOKE_DEADZONE = 0.04;

/** Normiertes Mausrad (≈ 1 pro Raste, Trackpads fein). */
function wheelNotches(e) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  return clamp((e.deltaY * k) / 100, -4, 4);
}

/** Yoke-Kennlinie: kleine Totzone, leicht progressiv für feines Steuern um die Mitte. */
export function yokeCurve(x) {
  const ax = Math.abs(x);
  if (ax <= YOKE_DEADZONE) return 0;
  const u = Math.min(1, (ax - YOKE_DEADZONE) / (1 - YOKE_DEADZONE));
  return Math.sign(x) * u * (0.4 + 0.6 * u * u);
}

/**
 * ctx: { canvas, camera, cockpit (hits), instruments, controls, lights, input, view, settings,
 *        actions: { onUserGesture() } }
 */
export function createPointer(ctx) {
  const { canvas, camera, cockpit, instruments, controls: ctl, lights, input, view, settings } = ctx;
  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(1); // Hit-Zonen liegen auf Layer 1
  raycaster.far = 3;
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const drags = new Map(); // pointerId → Drag-Zustand
  let hover = null; // { control, mode, ... } unter dem Mauszeiger
  let lastMouse = null; // { x, y } (client) für Yoke-Modus/Tooltip
  const acc = { kollsman: 0, hi: 0 };

  // Tooltip (dezent, folgt dem Cursor)
  const tip = document.createElement('div');
  tip.className = 'tip hidden';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  // Yoke-Modus-Anzeige: Mitte + aktuelle Lage
  const yokeInd = document.createElement('div');
  yokeInd.className = 'yoke-ind hidden';
  yokeInd.innerHTML = '<div class="yoke-ind-dot"></div>';
  document.body.appendChild(yokeInd);
  const yokeDot = yokeInd.firstChild;

  function pickAt(x, y) {
    if (view.mode !== 'cockpit') return null;
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(cockpit.hits, false)[0];
    if (!hit) return null;
    return { ...hit.object.userData, object: hit.object, point: hit.point.clone() };
  }

  // ---------------------------------------------------------------- Beschriftung der Bedienelemente
  const onOff = (b) => (b ? 'an' : 'aus');
  function label(c) {
    switch (c) {
      case 'throttle':
        return `Gas ${Math.round(ctl.throttle * 100)} % – ziehen`;
      case 'mixture':
        return 'Gemisch: voll reich (nicht verstellbar)';
      case 'flaps':
        return `Klappen ${Math.round(ctl.flapsCmd) * 10}° – oben: einfahren, unten: ausfahren`;
      case 'trim': {
        const t = Math.round(ctl.trim * 100);
        return `Trimmung ${t > 0 ? 'Nase hoch ' : t < 0 ? 'Nase tief ' : ''}${Math.abs(t)} % – ziehen oder Mausrad`;
      }
      case 'ignition':
        return `Zündung ${ctl.ignition} – Klick: OFF/BOTH, halten: START`;
      case 'beacon':
        return `Beacon ${onOff(lights.beacon)}`;
      case 'landingLight':
        return `Landelicht ${onOff(lights.landing)}`;
      case 'navLights':
        return `Positionslichter ${onOff(lights.nav)}`;
      case 'strobe':
        return `Strobe ${onOff(lights.strobe)}`;
      case 'parkingBrake':
        return `Parkbremse ${ctl.parkingBrake ? 'gesetzt' : 'gelöst'}`;
      case 'kollsman':
        return `Höhenmesser ${Math.round(instruments.display.kollsman)} hPa – Mausrad oder ziehen`;
      case 'hiKnob':
        return 'Kurskreisel – Mausrad drehen, Klick: an Kompass angleichen';
      default:
        return c;
    }
  }

  function showTip(x, y, text) {
    tip.textContent = text;
    tip.classList.remove('hidden');
    const w = tip.offsetWidth || 200, h = tip.offsetHeight || 24;
    const px = Math.min(window.innerWidth - w - 8, x + 16);
    const py = y + 20 + h > window.innerHeight ? y - h - 12 : y + 20;
    tip.style.transform = `translate(${Math.max(8, px)}px, ${Math.max(8, py)}px)`;
  }
  function hideTip() {
    tip.classList.add('hidden');
  }

  function setCursor() {
    const d = [...drags.values()][0];
    if (d) canvas.style.cursor = d.kind === 'look' ? 'grabbing' : d.control === 'throttle' || d.control === 'trim' ? 'ns-resize' : 'pointer';
    else canvas.style.cursor = hover ? 'pointer' : '';
  }

  // ---------------------------------------------------------------- Bedienelemente
  function startControl(h, e) {
    input.activate();
    const c = h.control;
    const d = { kind: 'control', control: c, x0: e.clientX, y0: e.clientY, v0: 0, moved: false };
    switch (c) {
      case 'throttle':
        d.v0 = ctl.throttle;
        break;
      case 'trim':
        d.v0 = ctl.trim;
        break;
      case 'kollsman':
        d.v0 = instruments.display.kollsman;
        break;
      case 'hiKnob':
        d.v0 = 0;
        break;
      case 'flaps': {
        // obere Hälfte des Hebelwegs → einfahren, untere → ausfahren
        const local = h.object.worldToLocal(tmp.copy(h.point));
        input.flaps(local.y > 0 ? -1 : 1);
        break;
      }
      case 'ignition':
        input.press('KeyI'); // gleiche Logik wie Taste I: Tipp = OFF/BOTH, halten = START
        d.ign = true;
        break;
      case 'beacon':
        lights.beacon = !lights.beacon;
        break;
      case 'landingLight':
        lights.landing = !lights.landing;
        break;
      case 'navLights':
        lights.nav = !lights.nav;
        break;
      case 'strobe':
        lights.strobe = !lights.strobe;
        break;
      case 'parkingBrake':
        ctl.parkingBrake = !ctl.parkingBrake;
        break;
      default:
        break;
    }
    return d;
  }

  function moveControl(d, e) {
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (Math.hypot(dx, dy) > 3) d.moved = true;
    switch (d.control) {
      case 'throttle': // nach oben schieben = mehr Gas (Knopf rein)
        ctl.throttle = clamp(d.v0 - dy / THROTTLE_PX, 0, 1);
        break;
      case 'trim': // Rad oben nach hinten ziehen (Maus nach unten) = Nase hoch
        ctl.trim = clamp(d.v0 + dy / TRIM_PX, -1, 1);
        break;
      case 'kollsman':
        instruments.setKollsman(Math.round(d.v0 - dy / 6));
        break;
      case 'hiKnob': {
        const deg = Math.round(-dy / 4);
        if (deg !== d.v0) {
          instruments.turnHIKnob(deg - d.v0);
          d.v0 = deg;
        }
        break;
      }
      default:
        break;
    }
  }

  function endControl(d) {
    if (d.ign) input.release('KeyI');
    if (d.control === 'hiKnob' && !d.moved) instruments.alignHI();
  }

  // ---------------------------------------------------------------- Blick
  function look(dx, dy, touch) {
    const k = LOOK_DEG_PER_PX * (settings.mouseSens ?? 1) * (view.fov / 70) * (touch ? 1.2 : 1);
    if (view.mode === 'cockpit') {
      view.tYaw = clamp(view.tYaw - dx * k, LOOK_LIMITS.yawMin, LOOK_LIMITS.yawMax);
      view.tPitch = clamp(view.tPitch - dy * k, LOOK_LIMITS.pitchMin, LOOK_LIMITS.pitchMax);
    } else {
      view.orbitYaw = (view.orbitYaw - dx * k * 1.5) % 360;
      view.orbitPitch = clamp(view.orbitPitch + dy * k, -10, 80);
    }
  }

  // ---------------------------------------------------------------- Yoke-Modus
  function yokeActive(e) {
    return !!settings.yokeMouse && (!e || e.pointerType === 'mouse');
  }
  function applyYoke(x, y) {
    const r = canvas.getBoundingClientRect();
    const R = 0.42 * Math.min(r.width, r.height);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ax = clamp((x - cx) / R, -1, 1), ay = clamp((y - cy) / R, -1, 1);
    input.setStick('mouse', yokeCurve(ay), yokeCurve(ax)); // Maus nach unten = ziehen
  }

  // ---------------------------------------------------------------- Ereignisse
  function onDown(e) {
    ctx.actions?.onUserGesture?.();
    if (drags.has(e.pointerId) || input.blocked) return; // Menü offen: keine Bedienung
    const mouse = e.pointerType === 'mouse';
    let d = null;
    if (mouse && (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey))) {
      d = { kind: 'look', x: e.clientX, y: e.clientY };
    } else if (!mouse || e.button === 0) {
      const h = pickAt(e.clientX, e.clientY);
      if (h) d = startControl(h, e);
      else if (!mouse) d = { kind: 'look', x: e.clientX, y: e.clientY, touch: true };
    }
    if (!d) return;
    e.preventDefault();
    drags.set(e.pointerId, d);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetische Events ohne aktiven Pointer */
    }
    hideTip();
    setCursor();
  }

  function onMove(e) {
    const d = drags.get(e.pointerId);
    if (d && input.blocked) return;
    if (d) {
      if (d.kind === 'look') {
        look(e.clientX - d.x, e.clientY - d.y, d.touch);
        d.x = e.clientX;
        d.y = e.clientY;
      } else {
        moveControl(d, e);
        if (e.pointerType === 'mouse') showTip(e.clientX, e.clientY, label(d.control));
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    lastMouse = { x: e.clientX, y: e.clientY };
    if (yokeActive(e)) applyYoke(e.clientX, e.clientY);
    const h = pickAt(e.clientX, e.clientY);
    hover = h ? { control: h.control } : null;
    if (hover) showTip(e.clientX, e.clientY, label(hover.control));
    else hideTip();
    setCursor();
  }

  function onUp(e) {
    const d = drags.get(e.pointerId);
    if (!d) return;
    drags.delete(e.pointerId);
    if (d.kind === 'control') endControl(d);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* bereits freigegeben */
    }
    setCursor();
  }

  function onWheel(e) {
    e.preventDefault();
    if (input.blocked) return;
    const n = wheelNotches(e);
    const h = pickAt(e.clientX, e.clientY);
    const fast = e.shiftKey ? 5 : 1;
    if (h && (h.mode === 'wheel' || h.control === 'trim' || h.control === 'throttle')) {
      input.activate();
      switch (h.control) {
        case 'trim': // Raste nach unten = Rad nach hinten = Nase hoch
          ctl.trim = clamp(ctl.trim + n * 0.02 * fast, -1, 1);
          break;
        case 'throttle':
          ctl.throttle = clamp(ctl.throttle - n * 0.02 * fast, 0, 1);
          break;
        case 'kollsman': {
          acc.kollsman -= n * fast;
          const steps = Math.trunc(acc.kollsman);
          if (steps) {
            instruments.setKollsman(Math.round(instruments.display.kollsman) + steps);
            acc.kollsman -= steps;
          }
          break;
        }
        case 'hiKnob': {
          acc.hi -= n * fast;
          const steps = Math.trunc(acc.hi);
          if (steps) {
            instruments.turnHIKnob(steps);
            acc.hi -= steps;
          }
          break;
        }
        default:
          break;
      }
      showTip(e.clientX, e.clientY, label(h.control));
      return;
    }
    if (view.mode === 'cockpit') view.fov = clamp(view.fov + n * 4, FOV_ZOOM.min, FOV_ZOOM.max);
    else view.orbitDist = clamp(view.orbitDist * Math.pow(1.1, n), 6, 80);
  }

  function cancelAll() {
    for (const [id, d] of drags) {
      if (d.kind === 'control') endControl(d);
      try {
        canvas.releasePointerCapture(id);
      } catch {
        /* egal */
      }
    }
    drags.clear();
    hover = null;
    hideTip();
    setCursor();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !drags.size) {
      hover = null;
      hideTip();
      setCursor();
      // Yoke-Modus: Maus verlässt die Flugansicht = Yoke loslassen (Tastatur-Rampe führt weich auf 0 zurück),
      // sonst bliebe der letzte Ausschlag stehen, bis der Cursor zurückkommt.
      if (yokeActive(e)) {
        lastMouse = null;
        input.releaseSource('mouse');
      }
    }
  });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('auxclick', (e) => e.preventDefault());
  input.onClear(cancelAll);

  /** Pro Frame: Tooltip-Text aktuell halten (z. B. Gas-%), Yoke-Anzeige. */
  function update() {
    if (hover && !tip.classList.contains('hidden') && lastMouse) tip.textContent = label(hover.control);
    const yoke = !!settings.yokeMouse && !ctx.isTouchLayout?.();
    yokeInd.classList.toggle('hidden', !yoke);
    if (yoke) {
      const e = ctl.elevator * (settings.invertElevator ? -1 : 1);
      yokeDot.style.transform = `translate(${(ctl.aileron * 22).toFixed(1)}px, ${(e * 22).toFixed(1)}px)`;
    }
  }

  /** Bildschirmposition (client px) einer Hit-Zone – für Tests/Debug (AK-24). */
  function screenPos(control) {
    const m = cockpit.hits.find((h) => h.userData.control === control);
    if (!m) return null;
    camera.updateMatrixWorld();
    m.getWorldPosition(tmp).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((tmp.x + 1) / 2) * r.width, y: r.top + ((1 - tmp.y) / 2) * r.height, visible: Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1 && tmp.z < 1 };
  }

  return { update, pickAt, screenPos, cancelAll, label, get hover() { return hover; } };
}
