// Einstieg (SPEC §4.1 Punkt 6): WebGL2 prüfen, Module mit echtem Fortschritt laden, Lade-/Fehlerzustände zeigen.
// Bewusst ohne statische Imports: Schlägt ein Modul fehl (Netz, 404, Syntax), bleibt dieser Code lauffähig und
// zeigt „Erneut versuchen“ statt eines schwarzen Bildes.
//
// Test-Flags (AK-36), per URL: ?test=nowebgl2 (WebGL2 fehlt), ?test=importfail (Modul-Import schlägt fehl).

const flags = new Set(new URLSearchParams(location.search).getAll('test'));

function webgl2Available() {
  if (flags.has('nowebgl2')) return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // Test-Kontext sofort wieder freigeben
    return true;
  } catch {
    return false;
  }
}

function fallbackFatal(title, message) {
  // falls selbst progress.js nicht lädt
  const box = document.getElementById('loading');
  if (box) box.textContent = `${title} – ${message}`;
  const btn = document.createElement('button');
  btn.textContent = 'Erneut versuchen';
  btn.className = 'btn primary';
  btn.onclick = () => location.reload();
  box?.appendChild(btn);
}

async function boot() {
  let P;
  try {
    P = await import('./ui/progress.js');
  } catch (e) {
    fallbackFatal('Laden fehlgeschlagen', 'Die Anwendung konnte nicht geladen werden.');
    return;
  }
  document.body.dataset.app = 'loading';
  if (!webgl2Available()) {
    P.showFatal({
      title: 'WebGL2 nicht verfügbar',
      message:
        'Dieser Flugsimulator braucht WebGL2. Bitte einen aktuellen Browser (Chrome, Edge, Firefox, Safari) verwenden ' +
        'und die Hardwarebeschleunigung in den Browser-Einstellungen aktivieren.',
      retry: false,
    });
    return;
  }
  try {
    P.setProgress(0.04, 'Grafikbibliothek (three.js) laden …');
    await import('three'); // größtes Modul zuerst – eigener Fortschrittsschritt
    P.setProgress(0.38, 'Simulationsmodule laden …');
    if (flags.has('importfail')) await import('./missing-module-for-test.js');
    // lädt die restlichen Module; main.js initialisiert per Top-Level-await die Welt und meldet dabei Fortschritt
    await import('./main.js');
  } catch (e) {
    console.error(e); // echter Ladefehler – für Entwickler sichtbar lassen
    P.showFatal({
      title: 'Laden fehlgeschlagen',
      message: 'Ein Teil des Flugsimulators konnte nicht geladen werden. Bitte die Verbindung prüfen und erneut versuchen.',
      detail: String(e && e.message ? e.message : e),
      retry: true,
    });
  }
}

boot();
