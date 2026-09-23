# C172 Web

Browser-Flugsimulator mit dem Fluggefühl einer Cessna 172P. Statische Website ohne Build; einzige
Laufzeit-Abhängigkeit ist Three.js (vendored). Grundlage: [SPEC.md](SPEC.md) und [PLAN.md](PLAN.md).

## Lokal starten

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

Ablauf: Ladeanzeige mit echtem Fortschritt (three.js, Module, Gelände, Shader) → **Startmenü** über der langsam
rotierenden Außenansicht (Szenario wählen, „Fliegen“, Einstellungen, Tastenhilfe) → Flug im Cockpit.
`P`/`Esc` öffnet die Pause (Fortsetzen, Neustart, Einstellungen, Tastenhilfe, Hauptmenü); nach einem Crash
erscheint der Grund mit „Neustart“. Verdeckter Tab oder Fokusverlust pausiert automatisch – Fortsetzen ist eine
bewusste Aktion, gehaltene Tasten werden gelöst. Fehlt WebGL2, erscheint eine Meldung statt eines schwarzen Bildes;
Ladefehler bieten „Erneut versuchen“, ein verlorener Grafikkontext einen kontrollierten Neustart.
Test-Flags: `?test=nowebgl2`, `?test=importfail`; Kontextverlust per `SIM.debug.loseContext()`/`restoreContext()`.

App-Zustände (`document.body.dataset.app`, `SIM.appState`): `loading → ready → running ⇄ paused → crashed`, `error`.

## Tests (headless Physik, ohne Pakete)

```sh
node --test tests/
AK_REPORT=1 node --test tests/   # zusätzlich die Messwerte der Akzeptanzkriterien ausgeben
```

`tests/physics.test.mjs` prüft AK-01 … AK-18 (SPEC §8) mit einfachen Test-Piloten (`tests/pilot.mjs`),
`tests/pattern.test.mjs` AK-39 (drei Platzrunden mit Landung, Ausrollen, Zurückrollen – ruhige Luft und
Standardwetter), `tests/loop.test.mjs` AK-33/34 (Determinismus über Renderraten, Render-Interpolation, max. 8
Substeps), `tests/head.test.mjs` AK-37 (Kopfbewegung), `tests/ui.test.mjs` AK-38/27 (Kontrast aus den CSS-Tokens,
reduced motion, Einstellungs-Metadaten),
`tests/heightfield.test.mjs` Determinismus, ebene Piste und die Raster-Konsistenz Physik ↔ LOD-0-Kachel (AK-20),
`tests/math.test.mjs` die Achsen-Übersetzung Body ↔ Three, `tests/input.test.mjs` die Eingabe-Demand-Schicht
(Rampen, Quellen, Fokusverlust, Sperre, Koordinationshilfe) und `tests/audio.test.mjs` die Klang-Abbildung
(Zündfrequenz, Last, Wind, Horn, Aufsetz-Ereignisse).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `vendor/three/` | three 0.186.0 (`three.module.js`, `three.core.js`, LICENSE), per Importmap eingebunden. Das npm-Paket `three@0.186.0` enthält **keine** `*.min.js`-Builds mehr (nur `build/three.module.js` + `build/three.core.js`); die Dateien sind byte-identisch aus `npm pack three@0.186.0` übernommen. Transfer mit gzip ≈ 420 KB (N6 ≤ 1 MB eingehalten) |
| `js/sim/` | Physik ohne three/DOM: `math.js`, `c172.js` (alle Beiwerte), `atmosphere.js`, `aircraft.js`, `scenarios.js` |
| `js/world/` | Ohne three (Node-testbar): `noise.js`, `heightfield.js` (h(x,z), `groundHeight` auf dem globalen 16-m-Raster), `skymodel.js` (Sonnenstand 48° N, Rayleigh/Mie/Ozon-Streuung als JS und GLSL, Licht-/Dunstfarben, Belichtung, Sicht in der Wolke), `cloudfield.js` (Cumulus-Zellen nach Bedeckung, Drift, `densityAt`), `tileplan.js` (5 × 5-Kachelplanung LOD 0/1, Budget), `landcover.js` (Wald/Felder/Hindernisfreiheit), `papi.js`. Mit three: `terrain.js` (Nahkacheln LOD 0/1 mit Skirts, Fern-Mesh ±24 km double-buffered und zeilenweise, Terrain-Shader mit Wiese/Acker-Patchwork/Wald/Fels/Alm/Schnee auf mod-32768-Koordinaten, Seen pro Kachel), `water.js` (Fresnel, Himmelsreflexion, Wellen, Sonnen-/Mondglitzern), `sky.js` (Himmelsshader, Sterne, Mond, Sonnen-/Mond-/Himmelslicht, Höhendunst `patchHaze` vor dem Tone-Mapping, Wolkenschatten-Uniforms), `clouds.js` (instanzierte, sortierte Puff-Billboards mit Beleuchtung und Silberrand, Wolkenschatten-Textur), `vegetation.js` (Nadel-/Laubbäume als 2 InstancedMeshes auf den Nahkacheln), `noisetex.js`, `airport.js` (Piste mit Markierungen, Rollweg/Vorfeld mit Markierungen, 2 Hangars + Vereinsheim, animierter Windsack, PAPI 09/27, Pisten-/Schwellen-/Rollwegbefeuerung) |
| `js/aircraft/` | `shapes.js` (Loft, NACA-Profile, Merge-Helfer), `model.js` (prozedurale C172: Rumpf mit Fensterausschnitten, Flügel, Streben, Leitwerk, Fahrwerk, Propeller; Animation von Rudern, Klappen, Trimmruder, Propeller/Blur-Scheibe ab 600 RPM, Rädern, Lichtern) |
| `js/cockpit/` | `instruments.js` (Canvas-2D-Atlas 2048 × 1024, Six-Pack + Drehzahlmesser + Nebeninstrumente + Kompass, Anzeige-Verzögerungen), `cockpit.js` (Innenraum nach SPEC §3.7, Kabinenschale folgt der Außenhaut, animierte Bedienelemente, Hit-Zonen) |
| `js/input/` | `input.js` (Demand-Schicht: Tastatur-Rampen, Maus-Yoke, Touch – zuletzt aktive Quelle gewinnt; Trimmung eigener Kanal; Koordinationshilfe; `clearAll()` bei Fokusverlust; Sperre bei offenem Menü), `pointer.js` (Umsehen, Mausrad-FOV, klickbare Cockpit-Elemente per Raycast mit Hand-Cursor und Tooltip, Yoke-Modus), `touch.js` (Touch-Layout, Drehhinweis) |
| `js/audio/audio.js` | WebAudio-Synthese: Lycoming-Vierzylinder (eigene PeriodicWave je Arbeitsspiel, Zündfrequenz RPM/30 + halbe Ordnungen, lastabhängige Härte/Rauigkeit), Propeller, Fahrtwind, Stall-Horn, Reifen, Klappenmotor, Anlasser, VNE-/Drehzahl-Warnton, Kabinenfilter |
| `js/config.js` | Einstellungen nach SPEC §4.3 (Defaults, Bereiche, localStorage mit try/catch) |
| `js/boot.js` | Einstieg ohne statische Imports: WebGL2-Prüfung, Module mit Fortschritt laden, Lade-/Fehlerzustände |
| `js/ui/` | `progress.js` (Ladeanzeige, Fehlerdialog), `ui.js` (native `<dialog>`: Startmenü, Pause, Crash, Einstellungen, Hilfe, Grafikfehler; Fokusführung, Esc-Logik, Datenleiste) |
| `js/sim/loop.js` | Fixed-Step-Akkumulator als reine Funktion (1/120 s, max. 8 Substeps, verworfene Schritte gezählt) |
| `js/cockpit/head.js` | Kopfbewegung: gedämpftes Feder-Masse-System (≤ 2 cm / ≤ 1°), ohne three/DOM |
| `js/main.js` | Bootstrap (Top-Level-await mit Fortschritt), App-Zustände, Zwei-Pass-Rendering, Qualitätsstufen |
| `js/debug.js` | `window.SIM` (SPEC §6) |
| `deploy/` | `nginx.conf` (Debian 13), `ansible/playbook.yml` (Release-Verzeichnis + `current`-Symlink, Rollback), `README.md` (Betrieb) |

### Konventionen

- Welt (Three): +X Ost, +Y oben, −Z Nord. Body (Luftfahrt): x vorn, y rechts, z unten. Einzige Übersetzung: `bodyToThree`.
  Modell und Cockpit werden in Body-Koordinaten beschrieben (`B(x, y, z)` in `js/aircraft/shapes.js`).
- Steuerbefehle: `elevator` +1 = ziehen, `aileron` +1 = rechts rollen, `rudder` +1 = rechtes Pedal, `trim` +1 = Nase hoch.

### Rendering (PLAN §2.4)

Eine Szene, drei Layer: 0 = Welt + Außenmodell, 1 = opakes Cockpit, 2 = Gläser. Pass 1 (Layer 0+1, near 0,5 m,
far 30 km) erzeugt die Shadow-Map mit allen Schattenwerfern, Pass 2 (Layer 1+2, near 0,02 m, far 10 m) zeichnet das
Cockpit fein und nutzt die Shadow-Map wieder (`shadowMap.autoUpdate = false`). `renderer.info.autoReset = false`,
`perf().drawCalls` summiert beide Pässe. Die Sonne wirkt in beiden Pässen; Himmelslicht gibt es außen (Layer 0) und
gedämpft für die Kabine (Layer 2) plus ein Aufhelllicht (nachts rötliche Flutbeleuchtung), damit der Innenraum wie
ein Innenraum wirkt. Nachts übernimmt das Sonnenlicht die Rolle des (Voll-)Monds.

### Welt, Himmel, Wolken (AP6–AP8)

- Himmel, Sonnen- und Himmelslicht, Dunst- und Wolkenfarben stammen aus einem Streumodell (`skymodel.js`) – dadurch
  passen Dämmerung, goldene Stunde und Nacht automatisch zusammen. Der Dunst ist höhenabhängig und richtungsabhängig
  gefärbt (heller/wärmer zur Sonne) und geht am Horizont exakt in den Himmel über; die Randabblendung (14–22 km)
  verdeckt das Ende des Fern-Meshes. In einer Wolke sinkt die Sicht auf 140 m.
- Draw Calls (Mittel, beide Pässe): ≈ 155–170 (Terrain 25 + Fern-Mesh + Seen, Himmel, Sterne, Wolken 1, Bäume 2,
  Flugplatz 7). Zwei Nahkacheln inkl. Bäume kosten ≈ 5–10 ms CPU.
- Debug: `SIM.world` (Himmel, Sterne, Wolken, Wasser, Flugplatz mit `papiFor('27', pos)`, Vegetation),
  `SIM.cloudDensityAt(pos)`, `SIM.perf()` liefert zusätzlich `trees`, `cloudSprites`, `visibility`.

## Tastatur

| Taste | Funktion |
|---|---|
| ↑ / ↓ | Höhenruder drücken / ziehen (Rampe 1,5/s, Rückstellung 3/s) |
| ← / → | Querruder |
| Z (Y) / X bzw. , / . | Seitenruder |
| Bild↑ / Bild↓ bzw. + / − | Gas; Shift + + / Shift + − = voll / Leerlauf |
| F / V bzw. F5 / F6 | Klappen eine Stufe hoch / runter |
| T / G bzw. Pos1 / Ende | Trimmung nachdrücken / ziehen |
| B (halten), Shift+B | Radbremsen, Parkbremse |
| N / M | Differenzialbremse links / rechts |
| I | Zündung OFF ↔ BOTH, halten = START |
| L / O | Landelicht / Positions-, Strobe- und Beacon-Licht |
| C | Cockpit ↔ Außenansicht |
| 1–4, Leertaste | Blick vorn / links / rechts / Panel, zentrieren |
| H | Datenleiste |
| P / Esc | Pause (im Pausenmenü: Fortsetzen) |
| R | Szenario neu starten |
| ? | Tastenhilfe |

## Maus

- Umsehen: rechte oder mittlere Taste bzw. Alt + links ziehen (Gier ±150°, Nick −60/+45°); Mausrad = Zoom 40–90°.
  In der Außenansicht dreht das Ziehen die Kamera um das Flugzeug, das Mausrad ändert den Abstand.
- Klickbar (Hand-Cursor + Tooltip): Gashebel (vertikal ziehen, Mausrad), Klappenschalter (obere/untere Hälfte),
  Trimmrad (ziehen, Mausrad), Zündschlüssel (Klick OFF/BOTH, halten START), Lichtschalter, Parkbremse,
  Kollsman-Knopf und HI-Knopf (Mausrad; Klick auf den HI-Knopf gleicht an den Kompass an).
- Yoke-Modus (Einstellung `yokeMouse`): Mausposition relativ zur Bildmitte steuert Nick und Roll.

## Touch

Automatisch bei `pointer: coarse` (Einstellung `touchLayout`: auto/on/off): virtueller Stick links, Gas-Slider rechts,
Seitenruder-Slider unten, Buttons für Pause, Ansicht, Klappen ▲/▼, Trimmung ▲/▼ (halten) und Bremse (halten).
Nach 4 s ohne Bedienung auf 30 % Deckkraft; Ein-Finger-Drag auf freier Fläche dreht den Blick; Hochformat zeigt
„Bitte Gerät drehen“.

## Einstellungen & Grafikqualität

Alle Regler aus SPEC §4.3 im Menü „Einstellungen“ (sofort wirksam, in `localStorage` gespeichert; die Masse gilt ab
dem nächsten Neustart). Grafikqualität:

| Stufe | Auflösung (max. Pixelverhältnis) | Schatten | Bäume | Kantenglättung |
|---|---|---|---|---|
| Niedrig (Handy-Default) | 1,0 | aus | halbe Dichte | aus |
| Mittel (Default) | 1,5 | 1024² | voll | an |
| Hoch | 2,0 | 2048² | voll | an |

Die Kantenglättung hängt am WebGL-Kontext und wechselt erst beim nächsten Laden; auf „Niedrig“ sind die
Weichzeichner der Menüs (`backdrop-filter`) aus. `prefers-reduced-motion` schaltet UI-Übergänge ab und setzt die
Kopfbewegung auf 0 %.

## Klang

Der AudioContext startet mit der ersten Nutzerinteraktion. Lautstärke und Stummschaltung über die Einstellungen
(`SIM.setSettings({ volume, muted })`); `SIM.audio()` liefert Zustand und Oszillatorfrequenzen (AK-29).

## Debug-Hook

`window.SIM` (js/debug.js, SPEC §6): `state`, `controls`, `env`, `step(n)` (n Physikschritte + genau ein
World-Update + Instrumente + Render, synchron – auch in verdeckten Tabs ohne rAF), `render()`, `setControls(obj)`,
`setEnv(obj)`, `reset(id)` (startet den Flug), `pause(bool)`, `instruments()`, `perf()` (`fps`, `frameMs`,
`physicsMs`, `drawCalls` beider Render-Pässe, `triangles`, `tiles`, `droppedSteps`, …).
Zusätzlich: `appState`, `dialogs`, `menu()`, `fly(id)`, `view(name)`, `settings`/`setSettings(obj)`, `head()`,
`audio()`, `controlScreenPos(name)`, `input`, `touch`, `model`/`cockpit` (animierte Teile), `world`, `debug`
(Kontextverlust simulieren) und `three` (nur zum Debuggen).

## Deployment

nginx auf Debian 13 (trixie), ausgerollt per Ansible – Details, Prüfschritte und Rollback in
[deploy/README.md](deploy/README.md):

```sh
ansible-playbook -i inventory.ini deploy/ansible/playbook.yml              # neues Release + Umschalten
ansible-playbook -i inventory.ini deploy/ansible/playbook.yml --tags rollback  # zurück auf das vorige Release
```

Ausgeliefert werden nur `index.html`, `css/`, `js/` und `vendor/` (gzip ≈ 590 KB). Die Seite lädt nichts von
fremden Hosts (keine CDNs, Fonts oder Telemetrie).

## Lizenz Drittanbieter

Three.js – MIT, siehe `vendor/three/LICENSE`.
