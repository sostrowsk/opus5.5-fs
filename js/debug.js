// Debug-/Test-Hook window.SIM (SPEC §6). Immer vorhanden; alle Aufrufe arbeiten synchron und brauchen kein
// requestAnimationFrame (headless Preview-Tabs). Der Kern (state … perf) folgt exakt der Shape aus SPEC §6,
// darunter stehen dokumentierte Zusatz-Helfer für Tests.
//
//   SIM.state        live: pos, vel, quat, omega, ias_kt, tas_kt, gs_kt, cas_kt, alt_ft, agl_ft, vs_fpm, pitch_deg,
//                    bank_deg, heading_deg, aoa_deg, beta_deg, rpm, flaps_deg, elevatorDeg, trimDeg, onGround,
//                    stalled, crashed, crashReason, warnings[], g, time
//   SIM.controls     live: elevator, aileron, rudder, throttle, trim, flapsCmd, brakeL, brakeR, parkingBrake, ignition
//   SIM.env          live: timeOfDay, windDir, windKt, turbulence, clouds, cloudBase_ft, qnh
//   SIM.step(n=1)    n Physikschritte (1/120 s), danach GENAU EIN World-Update + Instrumente + Render → state
//   SIM.render()     ein Frame synchron rendern
//   SIM.setControls(obj)  Controls setzen (überschreibt die Eingabe bis zum nächsten echten Input)
//   SIM.setEnv(obj)  Umwelt setzen (sofort wirksam)
//   SIM.reset(id)    'runway' | 'final' | 'cruise' – startet den Flug (Menüs zu)
//   SIM.pause(bool)  Pause an/aus (mit Pause-Dialog)
//   SIM.instruments() Anzeigewerte inkl. Verzögerungen
//   SIM.perf()       { fps, frameMs, physicsMs, drawCalls (beide Pässe), triangles, tiles, droppedSteps, … }

/**
 * ctx (aus main.js): { state, controls, env, settings, stepN(n), renderOnce(), setControls(obj), setEnv(obj),
 *   reset(id), pause(bool), instruments(), perf(), extras: {…} }
 */
export function installDebug(ctx) {
  const SIM = {
    state: ctx.state,
    controls: ctx.controls,
    env: ctx.env,
    step(n = 1) {
      return ctx.stepN(Math.max(0, n | 0));
    },
    render() {
      ctx.renderOnce();
      return ctx.state;
    },
    setControls(obj = {}) {
      ctx.setControls(obj);
      return ctx.controls;
    },
    setEnv(obj = {}) {
      ctx.setEnv(obj);
      return ctx.env;
    },
    reset(scenarioId) {
      return ctx.reset(scenarioId);
    },
    pause(v = true) {
      ctx.pause(!!v);
      return ctx.app.state;
    },
    instruments() {
      return ctx.instruments();
    },
    perf() {
      return ctx.perf();
    },
  };
  // Zusatz-Helfer mit ihren Gettern übernehmen (Spread würde Getter einfrieren)
  Object.defineProperties(SIM, Object.getOwnPropertyDescriptors(ctx.extras || {}));
  window.SIM = SIM;
  return SIM;
}
