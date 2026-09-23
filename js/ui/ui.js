// Menüs & Overlays (SPEC §4.1–4.3, §4.7): Startmenü, Pause, Crash, Einstellungen, Hilfe, Grafikfehler und die
// Datenleiste. Native <dialog> (showModal → Rest der Seite inert), Fokus bleibt im obersten Dialog (Tab-Ring) und
// kehrt nach dem Schließen zum Auslöser zurück. Esc wird selbst behandelt (keydown abgefangen), damit das
// Verhalten je Dialog eindeutig ist: Pause → fortsetzen, Einstellungen/Hilfe → zurück, Menü/Crash → bleibt.
// Kein Framework: das Modul exportiert eine Fabrikfunktion, main.js verdrahtet Aktionen und App-Zustände.

const $ = (id) => document.getElementById(id);

/** Anzeige-Metadaten der Einstellungen (Wertebereiche/Defaults stammen aus js/config.js). */
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const SETTINGS_UI = [
  {
    legend: 'Umwelt',
    items: [
      ['timeOfDay', 'Tageszeit', (v) => `${pad(Math.floor(v + 1e-6) % 24)}:${pad(Math.round((v % 1) * 60) % 60)} h`],
      ['windDir', 'Windrichtung', (v) => `${pad(Math.round(v), 3)}°`],
      ['windKt', 'Windstärke', (v) => `${v} kt`],
      ['turbulence', 'Böigkeit / Turbulenz', (v) => `${v} %`],
      ['clouds', 'Bewölkung', (v) => `${v} %`],
      ['cloudBase_ft', 'Wolkenuntergrenze', (v) => `${v} ft`],
      ['qnh', 'QNH', (v) => `${v} hPa`],
    ],
  },
  {
    legend: 'Flugzeug & Steuerung',
    items: [
      ['mass', 'Beladung (Masse)', (v) => `${v} kg`, 'Wird beim nächsten Neustart übernommen.'],
      ['yokeMouse', 'Yoke-Modus Maus'],
      ['mouseSens', 'Mausempfindlichkeit', (v) => `${Number(v).toFixed(1).replace('.', ',')}×`],
      ['invertElevator', 'Höhenruder invertieren'],
      ['coordAssist', 'Koordinationshilfe (Auto-Seitenruder)', null, 'Nur über 30 m Höhe; eigenes Seitenruder hat Vorrang.'],
      ['touchLayout', 'Touch-Bedienung', { auto: 'Automatisch', on: 'An', off: 'Aus' }],
    ],
  },
  {
    legend: 'Grafik & Ansicht',
    items: [
      ['quality', 'Grafikqualität', { low: 'Niedrig', medium: 'Mittel', high: 'Hoch' }, 'Kantenglättung wechselt beim nächsten Laden.'],
      ['fov', 'Sichtfeld (FOV)', (v) => `${v}°`],
      ['headMotion', 'Kopfbewegung', (v) => `${v} %`],
      ['showHud', 'Datenleiste anzeigen'],
    ],
  },
  {
    legend: 'Klang',
    items: [
      ['volume', 'Lautstärke', (v) => `${v} %`],
      ['muted', 'Stumm'],
    ],
  },
];

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [href], [tabindex]:not([tabindex="-1"])';

/**
 * ctx: {
 *   settings, defs (SETTINGS_DEF), defaults() → Default-Einstellungen,
 *   setSettings(obj),                 // übernimmt + speichert, liefert neue Werte
 *   action(name, arg),                // 'fly' | 'resume' | 'restart' | 'menu' | 'glrestart'
 *   onChange(),                       // Dialog-Stapel hat sich geändert (Eingabesperre neu setzen)
 * }
 */
export function createUI(ctx) {
  const dialogs = {
    menu: $('dlg-menu'),
    pause: $('dlg-pause'),
    crash: $('dlg-crash'),
    settings: $('dlg-settings'),
    help: $('dlg-help'),
    gl: $('dlg-gl'),
  };
  const ESC = { menu: null, crash: null, gl: null, pause: 'resume', settings: 'close', help: 'close' };
  const stack = []; // [{ name, opener }]
  let programmatic = false; // eigene close()-Aufrufe von fremden (Browser-)Schließungen unterscheiden

  // ---------------------------------------------------------------- Stapel
  function top() {
    return stack.length ? stack[stack.length - 1].name : null;
  }
  function isOpen(name) {
    return stack.some((e) => e.name === name);
  }
  function focusFirst(dlg) {
    const el = dlg.querySelector('[data-autofocus]') || dlg.querySelector('.btn.primary:not([disabled])') || dlg.querySelector(FOCUSABLE);
    el?.focus({ preventScroll: true });
  }
  function open(name, opener = document.activeElement) {
    const dlg = dialogs[name];
    if (!dlg) return;
    if (isOpen(name)) {
      if (top() !== name) close(name); // nach oben holen
      else return focusFirst(dlg);
    }
    stack.push({ name, opener: opener instanceof HTMLElement ? opener : null });
    try {
      dlg.showModal();
    } catch {
      dlg.setAttribute('open', '');
    }
    if (name === 'settings') syncSettings();
    focusFirst(dlg);
    ctx.onChange?.();
  }
  function close(name = top()) {
    const i = stack.findIndex((e) => e.name === name);
    if (i < 0) return;
    const [entry] = stack.splice(i, 1);
    const dlg = dialogs[name];
    programmatic = true;
    if (dlg.open) dlg.close();
    programmatic = false;
    // Fokus zurück zum Auslöser – sofern er noch sichtbar/bedienbar ist, sonst in den obersten Dialog
    const t = top();
    const back = entry.opener;
    if (back && back.isConnected && (!t || dialogs[t].contains(back))) back.focus({ preventScroll: true });
    else if (t) focusFirst(dialogs[t]);
    else if (dlg.contains(document.activeElement)) document.activeElement.blur(); // Fokus nicht im geschlossenen Dialog lassen
    ctx.onChange?.();
  }
  function closeAll() {
    const active = document.activeElement;
    while (stack.length) {
      const { name } = stack.pop();
      programmatic = true;
      if (dialogs[name].open) dialogs[name].close();
      programmatic = false;
    }
    if (active && Object.values(dialogs).some((d) => d?.contains(active))) active.blur();
    ctx.onChange?.();
  }

  // Browser schließt einen Dialog selbst (z. B. Esc-Schließanforderung ohne abbrechbares cancel): wie Esc behandeln
  for (const [name, dlg] of Object.entries(dialogs)) {
    if (!dlg) continue;
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    dlg.addEventListener('close', () => {
      if (programmatic || !isOpen(name)) return;
      const esc = ESC[name];
      if (esc) escape(name);
      else {
        // darf nicht verschwinden (Menü, Crash, Grafikfehler): wieder öffnen
        try {
          dlg.showModal();
        } catch {
          dlg.setAttribute('open', '');
        }
      }
    });
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-act]');
      if (!btn || !dlg.contains(btn) || btn.disabled) return;
      handle(name, btn.dataset.act, btn);
    });
  }

  function escape(name) {
    const esc = ESC[name];
    if (esc === 'close') close(name);
    else if (esc) ctx.action(esc);
  }

  function handle(name, act, btn) {
    switch (act) {
      case 'close':
        close(name);
        break;
      case 'settings':
        open('settings', btn);
        break;
      case 'help':
        open('help', btn);
        break;
      case 'defaults':
        ctx.setSettings(ctx.defaults());
        syncSettings();
        break;
      case 'fly':
        ctx.action('fly', selectedScenario());
        break;
      default:
        ctx.action(act);
    }
  }

  // Tastatur in Dialogen: Esc (einmal pro Druck), P in der Pause, Tab-Ring
  window.addEventListener(
    'keydown',
    (e) => {
      const t = top();
      if (!t) return;
      const dlg = dialogs[t];
      if (e.key === 'Escape') {
        e.preventDefault(); // keine Browser-Schließanforderung – wir entscheiden selbst
        e.stopPropagation();
        if (!e.repeat) escape(t);
        return;
      }
      if ((e.code === 'KeyP' || e.key === 'p' || e.key === 'P') && t === 'pause' && !e.repeat && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.action('resume');
        return;
      }
      if (e.code === 'KeyR' && t === 'crash' && !e.repeat && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        ctx.action('restart'); // R = Szenario neu starten (Flugsteuerung bleibt gesperrt)
        return;
      }
      if (e.key === 'Tab') {
        const list = [...dlg.querySelectorAll(FOCUSABLE)].filter(
          (el) => el.offsetParent !== null && !(el.type === 'radio' && !el.checked),
        );
        if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        const inside = dlg.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true,
  );

  function selectedScenario() {
    const r = dialogs.menu.querySelector('input[name="scenario"]:checked');
    return r ? r.value : 'runway';
  }
  function setScenario(id) {
    const r = dialogs.menu.querySelector(`input[name="scenario"][value="${id}"]`);
    if (r) r.checked = true;
  }

  // ---------------------------------------------------------------- Einstellungen
  const form = $('settings-form');
  const rows = new Map(); // key → { input, output, fmt }
  function buildSettings() {
    const defs = ctx.defs;
    for (const group of SETTINGS_UI) {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = group.legend;
      fs.appendChild(lg);
      for (const [key, label, fmt, note] of group.items) {
        const d = defs[key];
        if (!d) continue;
        const row = document.createElement('div');
        row.className = 'set-row';
        const id = `set-${key}`;
        const lab = document.createElement('label');
        lab.htmlFor = id;
        lab.textContent = label;
        row.appendChild(lab);
        let input, output = null;
        if (d.bool) {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.setAttribute('role', 'switch');
          input.addEventListener('change', () => ctx.setSettings({ [key]: input.checked }));
          row.appendChild(input);
        } else if (d.options) {
          input = document.createElement('select');
          for (const o of d.options) {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = (fmt && fmt[o]) || o;
            input.appendChild(opt);
          }
          input.addEventListener('change', () => ctx.setSettings({ [key]: input.value }));
          row.appendChild(input);
        } else {
          output = document.createElement('output');
          output.htmlFor = id;
          row.appendChild(output);
          input = document.createElement('input');
          input.type = 'range';
          input.min = d.min;
          input.max = d.max;
          input.step = d.step;
          input.addEventListener('input', () => {
            const v = ctx.setSettings({ [key]: Number(input.value) })[key];
            output.textContent = fmt ? fmt(v) : String(v);
            input.setAttribute('aria-valuetext', output.textContent);
          });
          row.appendChild(input);
        }
        input.id = id;
        input.name = key;
        if (note) {
          const n = document.createElement('div');
          n.className = 'set-note';
          n.id = `${id}-note`;
          n.textContent = note;
          input.setAttribute('aria-describedby', n.id);
          row.appendChild(n);
        }
        rows.set(key, { input, output, fmt, d });
        fs.appendChild(row);
      }
      form.appendChild(fs);
    }
  }
  /** Formular an die aktuellen Einstellungen angleichen (nach Tastatur H, Standardwerten, Reload). */
  function syncSettings() {
    const s = ctx.settings;
    for (const [key, r] of rows) {
      const v = s[key];
      if (r.d.bool) r.input.checked = !!v;
      else if (r.d.options) r.input.value = v;
      else {
        r.input.value = v;
        r.output.textContent = r.fmt ? r.fmt(v) : String(v);
        r.input.setAttribute('aria-valuetext', r.output.textContent);
      }
    }
  }
  buildSettings();
  syncSettings();
  form.addEventListener('submit', (e) => e.preventDefault()); // Enter schließt den Dialog nicht

  // ---------------------------------------------------------------- Crash & Grafikfehler
  function showCrash(reasonText, detail = '') {
    $('crash-reason').textContent = reasonText;
    $('crash-data').textContent = detail;
    closeAll();
    open('crash', null);
  }
  function setGlRestart(enabled) {
    const b = dialogs.gl.querySelector('[data-act="glrestart"]');
    b.disabled = !enabled;
    $('gl-msg').textContent = enabled
      ? 'Der Grafikkontext ist wieder verfügbar. Die Simulation startet das Szenario kontrolliert neu.'
      : 'Der Grafikkontext ist verloren gegangen (Treiber oder Speicher). Die Simulation ist angehalten.';
    if (enabled && top() === 'gl') b.focus();
  }

  // ---------------------------------------------------------------- Datenleiste
  const hud = $('hud');
  let hudVisible = false;
  let hudHtml = '';
  let hudPaused = false;
  function setHudVisible(v) {
    hudVisible = !!v;
    hud.classList.toggle('hidden', !hudVisible);
  }
  const WARN_TEXT = { STALL: '⚠ STALL', VNE: '⚠ VNE', RPM: '⚠ DREHZAHL' };
  let hudT = 0;
  function updateHud(s, ctl, o = {}) {
    if (!hudVisible) return;
    // ≈ 10 Hz genügen für die Anzeige (DOM-Arbeit sparen); Zustandswechsel (Pause) sofort
    const now = performance.now();
    if (now - hudT < 100 && !!o.paused === hudPaused) return;
    hudT = now;
    hudPaused = !!o.paused;
    const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    const parts = [
      `<span><b>IAS</b>${f(s.ias_kt)} kt</span>`,
      `<span><b>ALT</b>${f(s.alt_ft)} ft</span>`,
      `<span><b>VS</b>${f(s.vs_fpm)} fpm</span>`,
      `<span><b>HDG</b>${pad(Math.round(s.heading_deg) % 360, 3)}°</span>`,
      `<span><b>RPM</b>${f(s.rpm)}</span>`,
      `<span><b>GAS</b>${f(ctl.throttle * 100)} %</span>`,
      `<span><b>KLAPPEN</b>${f(s.flaps_deg)}°</span>`,
      `<span><b>TRIMM</b>${ctl.trim >= 0 ? '+' : ''}${f(ctl.trim * 100)}</span>`,
    ];
    if (ctl.parkingBrake) parts.push('<span class="state">PARKBREMSE</span>');
    if (o.paused) parts.push('<span class="state">❚❚ PAUSE</span>');
    for (const w of s.warnings || []) parts.push(`<span class="warn${w === 'STALL' ? '' : ' crit'}">${WARN_TEXT[w] || '⚠ ' + w}</span>`);
    const html = parts.join('');
    if (html !== hudHtml) {
      hudHtml = html;
      hud.innerHTML = html;
    }
  }

  return {
    open,
    close,
    closeAll,
    top,
    isOpen,
    get anyOpen() {
      return stack.length > 0;
    },
    get stack() {
      return stack.map((e) => e.name);
    },
    showCrash,
    setGlRestart,
    syncSettings,
    selectedScenario,
    setScenario,
    setHudVisible,
    updateHud,
    dialogs,
  };
}
