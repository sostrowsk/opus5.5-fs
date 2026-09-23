// Ladeanzeige und Fehlerdialog (SPEC §4.1 Punkt 6). Ohne Abhängigkeiten, damit boot.js sie auch dann zeigen
// kann, wenn three oder ein App-Modul nicht lädt. main.js meldet über setProgress() echte Ladeschritte.

const $ = (id) => document.getElementById(id);

/** Fortschritt 0..1 mit Beschriftung des aktuellen Schritts. */
export function setProgress(frac, label) {
  const bar = $('load-bar'), box = $('load-progress'), step = $('load-step');
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  if (bar) bar.style.transform = `scaleX(${pct / 100})`;
  if (box) box.setAttribute('aria-valuenow', String(pct));
  if (step && label) step.textContent = label;
}

export function hideLoading() {
  const el = $('loading');
  if (el) {
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }
}

/**
 * Dem Browser Gelegenheit zum Zeichnen geben (Fortschrittsbalken). Sichtbarer Tab: nach dem nächsten Frame
 * (rAF → Nachricht, also nach dem Paint). Verdeckter Tab: rAF feuert dort nicht und setTimeout wird gedrosselt,
 * deshalb nur eine MessageChannel-Nachricht.
 */
export function yieldToBrowser() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    const post = () => ch.port2.postMessage(0);
    if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') {
      let sent = false;
      requestAnimationFrame(() => {
        if (!sent) (sent = true), post();
      });
      // Sicherheitsnetz: Tab wird während des Wartens verdeckt → rAF bleibt aus
      const onHide = () => {
        if (document.hidden && !sent) (sent = true), post();
      };
      document.addEventListener('visibilitychange', onHide, { once: true });
      // … oder das Fenster ist verdeckt, ohne dass die Seite „hidden“ meldet
      setTimeout(() => {
        if (!sent) (sent = true), post();
      }, 150);
    } else post();
  });
}

/**
 * Fehlerzustand anzeigen: { title, message, detail?, retry? (bool) }. „Erneut versuchen“ lädt die Seite neu
 * (fehlgeschlagene Modul-Importe merkt sich der Browser sonst).
 */
export function showFatal({ title, message, detail = '', retry = true }) {
  hideLoading();
  document.body.dataset.app = 'error';
  const dlg = $('dlg-error');
  if (!dlg) {
    document.body.textContent = `${title}: ${message}`;
    return;
  }
  $('error-title-text').textContent = title;
  $('error-msg').textContent = message;
  const det = $('error-detail');
  det.textContent = detail;
  det.hidden = !detail;
  const btn = $('error-retry');
  btn.hidden = !retry;
  btn.onclick = () => location.reload();
  if (!dlg.open) {
    try {
      dlg.showModal();
    } catch {
      dlg.setAttribute('open', '');
    }
  }
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Fehler lässt sich nicht wegdrücken
  (retry ? btn : dlg).focus?.();
}
