// Hauptschleife als reine Funktion (PLAN §2.1a): Fixed-Step-Akkumulator ohne DOM, damit Determinismus (AK-33)
// und Render-Interpolation (AK-34) unter Node mit künstlicher Uhr prüfbar sind.
//
//   const loop = createLoop({ step(i, n) { … } });
//   const { n, alpha } = loop.advance(frameDt);   // pro gerendertem Frame
//
// step(i, n) wird n-mal pro Frame aufgerufen (i = 0 … n−1). Der Aufrufer merkt sich vor dem letzten Schritt
// (i === n − 1) den Zustand und rendert lerp/slerp(prev, cur, alpha).

export const PHYS_DT = 1 / 120;
export const MAX_SUBSTEPS = 8; // SPEC §3.1 – Überschuss wird verworfen (Anti-Spiral-of-Death)
export const MAX_FRAME_DT = 0.25; // s – längere Frame-Intervalle werden gekappt (kein Zeitsprung)

export function createLoop({ step, dt = PHYS_DT, maxSteps = MAX_SUBSTEPS, maxFrame = MAX_FRAME_DT } = {}) {
  const loop = {
    acc: 0,
    alpha: 1,
    steps: 0, // Summe aller ausgeführten Physikschritte
    droppedSteps: 0, // verworfene Schritte (Frame zu lang)
    /** Frame-Intervall (s) verarbeiten: Physikschritte ausführen, α für die Interpolation liefern. */
    advance(frameDt) {
      loop.acc += Math.min(Math.max(0, +frameDt || 0), maxFrame);
      let n = Math.floor(loop.acc / dt);
      if (n > maxSteps) {
        loop.droppedSteps += n - maxSteps;
        loop.acc -= n * dt; // ganze überzählige Schritte verwerfen, Bruchteil bleibt (α)
        n = maxSteps;
      } else loop.acc -= n * dt;
      if (loop.acc < 0) loop.acc = 0; // Rundung
      for (let i = 0; i < n; i++) step?.(i, n);
      loop.steps += n;
      loop.alpha = Math.min(1, loop.acc / dt);
      return { n, alpha: loop.alpha };
    },
    /** Nach Pause, Tab-Wechsel oder Neustart: Akkumulator leeren (kein Nachholen). Der Aufrufer setzt dazu
     *  prev = aktueller Zustand, damit jedes α den aktuellen Zustand zeigt. */
    reset() {
      loop.acc = 0;
      loop.alpha = 1;
    },
  };
  return loop;
}
