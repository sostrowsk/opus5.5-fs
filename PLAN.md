# PLAN – Umsetzung „C172 Web“

Basis: `SPEC.md` v1.1. Es gibt keinen Build und außer dem vendored `three` keine Pakete.

## 1. Architektur

```
index.html                 Canvas, UI-Overlays (Menü, Settings, Pause, Crash, Hilfe, Touch), Importmap
css/app.css                UI-Stil (Tokens, Overlays, Touch-Layout), keine Webfonts
vendor/three/              three.module.min.js + three.core.min.js (0.186.0), LICENSE
js/main.js                 Bootstrap, Game-Loop (rAF + Fixed-Step-Akkumulator), Verdrahtung, Zwei-Pass-Render
js/config.js               Settings-Defaults, Wertebereiche (aus SPEC 4.3), load/save localStorage
js/sim/c172.js             Reine Daten: Geometrie, Massen, Aero-Beiwerte, Motor/Prop-Tabellen, Fahrwerkspunkte
js/sim/atmosphere.js       ISA, Wind-Grenzschicht, Böen-/Turbulenzfilter (seeded RNG)
js/sim/aircraft.js         Zustand + step(dt): Aero, Prop/Motor, Fahrwerk/Boden, Integration, Crash
js/sim/scenarios.js        Startzustände runway/final/cruise inkl. Trimmwert-Voreinstellung
js/world/noise.js          2D-Simplex + fBm/ridged, seeded (nativ, ~80 Zeilen)
js/world/heightfield.js    h(x,z) inkl. Flugplatz-Einebnung, Wassermaske, Oberflächentyp (Physik UND Grafik)
js/world/terrain.js        Nahkacheln 5×5 (LOD0/1) + ein Fern-Mesh, Geometrie-Pool, Budget pro Frame, Terrain-Shader
js/world/airport.js        Piste (Canvas-Textur für Markierungen), Rollweg, Hangars, Windsack, PAPI, Befeuerung
js/world/vegetation.js     Baum-InstancedMesh pro Nahkachel
js/world/water.js          Wasserfläche mit Himmelsreflexions-Shader (Fresnel + Sonnenglitzern)
js/world/sky.js            Himmels-Shader (Rayleigh/Mie), Sonne/Mond, Sterne, Lichter, Fog-Farbe, Tageszeit
js/world/clouds.js         Wolken als Instanced Billboards (weiche Sprite-Cluster), Wolken-Dichteabfrage für Fog
js/aircraft/model.js       Prozedurales C172-Außenmodell + Animationen (Ruder, Prop, Räder, Lichter)
js/cockpit/cockpit.js      Innenraum-Geometrie, Hebel/Yoke-Animation, Hit-Zonen (Raycast) für Maus/Touch
js/cockpit/instruments.js  Canvas-2D-Instrumente → Atlas-CanvasTexture, Anzeige-Dynamik (Lags)
js/audio/audio.js          WebAudio-Graph: Motor, Prop, Wind, Stall-Horn, Reifen, Klappen, Anlasser
js/input/input.js          Tastatur/Maus/Touch → Control-Demand (Rampen, Glättung), Kamera-Blick, Koordinationshilfe
js/cockpit/head.js         Kopfbewegung: gedämpftes Feder-Masse-System (≤ 2 cm / 1°), abschaltbar
js/ui/ui.js                Menüs, Settings-Bindings, Datenleiste, Crash/Pause, Touch-Controls, Orientierung
js/debug.js                window.SIM (Shape siehe SPEC §6)
tests/physics.test.mjs     node --test: AK-01..18 headless (reine Sim ohne DOM)
tests/heightfield.test.mjs node --test: Determinismus, Piste flach
deploy/nginx.conf          Server-Block: static root, gzip (js/css/html/svg), Cache-Header, MIME
deploy/ansible/playbook.yml  nginx installieren, Release-Verzeichnis + current-Symlink, Site aktivieren, Rollback-Task (Debian 13)
deploy/README.md           Betrieb: Upload, Prüfen, Umschalten, Rollback, Logs, HTTPS-Varianten
tests/loop.test.mjs        node --test: Determinismus über Renderraten (AK-33), Interpolation (AK-34)
tests/pattern.test.mjs     node --test: skriptgesteuerte Platzrunde mit 3 Landungen (AK-39)
TESTFLIGHTS.md             Protokoll der menschlichen Testflüge (AK-41)
.claude/launch.json        Preview: python3 -m http.server 8080
README.md                  Start lokal, Tasten, Deployment
```

**Abhängigkeitsregel:** `js/sim/*` und `js/world/heightfield.js` + `noise.js` importieren **nichts** aus `three` und nichts aus dem DOM. Sie bekommen eine kleine eigene Vektor-/Quaternion-Mathematik (`js/sim/math.js`, ~120 Zeilen). Dadurch laufen sie unter Node ohne Importmap. Rendering-Module kopieren den Zustand pro Frame in Three-Objekte.

## 2. Kern-Datenstrukturen & Entscheidungen

### 2.1 Physik-Zustand (`aircraft.js`)
```js
state = {
  p: [x,y,z],        // Weltposition m (float64), Y oben
  v: [vx,vy,vz],     // Weltgeschwindigkeit m/s
  q: [w,x,y,z],      // Orientierung Body→Welt (Body-Achsen siehe unten)
  w: [p,q,r],        // Drehraten im Body-System rad/s
  rpm, flapsDeg, stallState (0..1), gearCompression[3], wheelSpin[3],
  onGround, crashed, crashReason, time
}
```
- **Body-Achsen:** Wir verwenden die Luftfahrt-Konvention: x vorn, y rechts, z unten. So lassen sich Beiwerte (Cl, Cm, Cn) direkt aus der Literatur übernehmen, ohne Vorzeichenfehler. Die Welt-Konvention ist Three (Y oben, −Z Nord). Genau eine Konvertierungsfunktion `bodyToThree` in `math.js` übersetzt zwischen beiden. Sie wird mit Unit-Tests abgesichert (Nase Nord = −Z, rechter Flügel = +X, Querneigung rechts = rechter Flügel nach unten).
- **Integrator:** Semi-impliziter Euler für die Translation. Für die Rotation werden Winkelgeschwindigkeiten mit dem vollen Euler-Gleichungsterm ω×Iω integriert, danach wird die Quaternion normalisiert. Bei 120 Hz ist das stabil genug. Die Fahrwerksfedern sind so gewählt, dass die Eigenfrequenz unter 10 Hz liegt, weit unter der Stabilitätsgrenze.
- **Aero:** Kräfte werden aus α, β, p̂, q̂, r̂, Ruderausschlägen, Klappen und dem Staudruck (inkl. Slipstream-Anteil am Leitwerk) berechnet. Die Beiwerte folgen JSBSim c172p bzw. Roskam, in `c172.js` als benannte Konstanten, um sie leicht nachtunen zu können.
- **Stall:** `stallState` folgt einer Zielgröße mit der Zeitkonstante τ = 0,3 s: 1, wenn α > α_krit, sonst 0 bei α < α_krit − 3°. Damit gilt CL = (1−s)·CL_linear + s·CL_post.
  - **Flügelabkippen:** Die lokalen Anstellwinkel der linken und rechten Flügelhälfte unterscheiden sich um die Rollrate (p·b/4V) und β (Pfeilung/Dieder-Effekt). Pro Hälfte wird ein eigener Stall-Anteil berechnet, daraus ergibt sich ein Rollmoment `ΔCl = k·(CL_links − CL_rechts)`. Das Moment ist kontinuierlich und selbstverstärkend (Autorotations-Tendenz), aber durch einen Clamp begrenzt. Dazu kommt eine feste Grundasymmetrie von 0,3° Anstellwinkel (Seed-frei), sodass das Verhalten reproduzierbar bleibt.
  - `stalled` = stallState > 0,5. Das Stall-Horn löst bei α > α_krit − 4° aus, das entspricht etwa 5–10 kt vorher.
- **Fahrtmesser-Kalibrierung KCAS → KIAS** (Richtwerte nach dem 172P-POH, linear interpoliert, unterhalb des ersten Stützpunkts extrapoliert und bei 0 begrenzt):

| Klappen 0 · KIAS | 40 | 50 | 60 | 70 | 80 | 100 | 120 | 140 | 160 |
|---|---|---|---|---|---|---|---|---|---|
| KCAS | 49 | 55 | 62 | 70 | 80 | 99 | 118 | 138 | 157 |

| Klappen 30 · KIAS | 30 | 40 | 50 | 60 | 70 | 85 |
|---|---|---|---|---|---|---|
| KCAS | 43 | 49 | 55 | 62 | 71 | 85 |

  Klappen 10/20 werden linear zwischen beiden Tabellen interpoliert. Beim Anzeigen wird die Tabelle invertiert (KCAS → KIAS).
- **Trimmung:** `trim` (−1..1) wirkt als separates Cm-Inkrement (Trimmruder, ∝ Staudruck). Der Yoke-Ausschlag `elevator` fällt nach dem Loslassen auf 0. Der Höhenruderausschlag δe = elevator·Weg + trimmbedingte Floatlage wird getrennt als `elevatorDeg` ausgegeben.
- **Crash-Logik:** Siehe SPEC §3.2. Pro Rad gibt es einen maximalen Federweg (Haupt 0,25 m, Bug 0,20 m). Beim Endanschlag mit Kontaktgeschwindigkeit > 3,5 m/s oder bei einer Federkraft > 4 × statische Last lautet der Grund `'gear'`. Weitere Gründe sind `'structure'` (Strukturpunkt am Boden), `'water'` und `'overload'` (g-Bruchlast). VNE und Überdrehzahl landen nur in `warnings`.
- **Propeller:** Die Tabellen CT(J) und CP(J) enthalten je 8 Stützstellen und werden linear interpoliert. Unterhalb von 100 RPM gilt der Stand-/Anlaufbereich aus SPEC §3.2, dazwischen wird weich überblendet. Die RPM ist auf 0–3200 begrenzt. Die RPM-Dynamik folgt `I_prop·dω/dt = Q_engine − Q_prop − Q_friction`. Das Motordrehmoment ergibt sich aus der Leistungskurve (RPM) × Gasstellung (inkl. Leerlauf-Minimum) × σ^1,1.
- **Boden:** Pro Kontaktpunkt (3 Räder und 6 Strukturpunkte) wird die Eindringtiefe über `groundHeight(x,z)` (LOD-0-Raster) bestimmt; Wasser über `surface()`. Die Rad-Normalkraft ist `k·d + c·ḋ` (≥ 0). Die Reibung wird im Radkoordinatensystem berechnet: längs Rollwiderstand und Bremse, quer eine Seitenkraft mit Sättigung (Reifenmodell linear bis zur Haftgrenze). Das Bugrad lenkt über das Seitenruder. Strukturpunkte mit Bodenkontakt lösen einen Crash aus.
- **Parkbremse im Stand:** Unterhalb von 0,05 m/s wird die Haftreibung über eine Geschwindigkeits-Dämpfung stabilisiert, damit das Flugzeug nicht „kriecht“.

### 2.1a Hauptschleife (`main.js`, testbar als reine Funktion)
- `createLoop({ step, render, now })` — reine Funktion ohne DOM-Abhängigkeit, damit AK-33/34 unter Node mit künstlicher Uhr laufen.
- Pro Frame: `acc += min(frameDt, 0.1)`; solange `acc ≥ DT` und `< 8` Schritte: `prev = copy(state)`, `step(DT)`, `acc -= DT`; Überschuss verwerfen und zählen. Danach `α = acc/DT`, gerendert wird `lerp(prev.p, state.p, α)` / `slerp(prev.q, state.q, α)`. Kamera und Außenmodell nutzen **denselben** interpolierten Zustand; Instrumente dürfen den letzten Physikzustand lesen.
- Eingaben werden einmal pro Physikschritt abgetastet (Demand-Rampen laufen im Physiktakt, nicht im Frame-Takt) → Determinismus.
- `blur`/`visibilitychange` → Pause, `input.clearAll()`, beim Fortsetzen `lastTime = now()`.

### 2.1b Kopfbewegung (`head.js`)
- Zustand: Versatz `o` (3D, m) und Drehung `r` (Nick/Roll, rad), je als kritisch bis leicht unterkritisch gedämpfte Feder (f ≈ 2,5 Hz, ζ ≈ 0,7), angeregt durch `−(a_pilot − a_1g)` im Body-System (Lastvielfache, Querbeschleunigung), Turbulenzanteil und Fahrwerks-Impulse (Kraftänderung pro Schritt). Harte Clamps 0,02 m / 1°. Skaliert mit Setting 0..1; bei 0 wird nichts berechnet (exakt 0).
- Läuft im Physiktakt (deterministisch), angewandt auf die Kamera nach der Interpolation.

### 2.2 Heightfield (`heightfield.js`)
- `h(x,z)` = Basis-fBm (5 Oktaven, λ = 6 km) + Ridged-Berge (Maske über Niederfrequenz-Noise) − Tal- und Seebildung.
- Um den Flugplatz liegt ein Plateau: Innerhalb eines Rechtecks von 1600 × 400 m gilt h = 450 m. Bis 1200 m Abstand wird per Smoothstep ins Gelände übergeblendet. Innerhalb der Piste ist h **exakt** 450.
- Der Wasserspiegel liegt global auf 380 m MSL, Terrain unterhalb davon ist See. `surface(x,z)` liefert asphalt / grass / water.
- **Physik/Grafik-Konsistenz (AK-20):** Die Mesh-Vertices werden mit `h` berechnet. Die Physik sampelt **nicht** analytisch, sondern interpoliert baryzentrisch auf demselben Dreiecksraster der Kachel-LOD 0 (Rasterweite 16 m, globales Raster, identische Diagonalrichtung). Dafür gibt es `groundHeight(x,z)` im Heightfield-Modul. Weil das Raster global ist (Vertex bei ganzzahligen Vielfachen von 16 m), stimmt es kachelübergreifend exakt mit dem Mesh überein.
- **LOD 0 unter dem Flugzeug:** Die 3×3 Kacheln um die Flugzeug-Kachel sind immer LOD 0, damit liegen in jede Richtung ≥ 1024 m LOD 0 vor. Bodenkontakt ist nur nahe am Flugzeug möglich, also immer auf LOD 0.
- Die Piste ist exakt eben (h = 450), das Raster ist dort ohnehin flach.

### 2.3 Terrain-Kacheln (`terrain.js`)
- **Nahbereich:** Es gibt 5×5 Kacheln à 1024 m, zentriert auf die Flugzeug-Kachel. Der innere 3×3-Block ist LOD 0 (64 Segmente, 16 m), der äußere Ring LOD 1 (32 Segmente, 32 m). Damit sind es genau **25 Kacheln** bzw. 25 Draw Calls. LOD 1 nutzt jeden zweiten LOD-0-Vertex, sodass die Kanten zu LOD 0 bis auf T-Junctions übereinstimmen. Diese werden durch **Skirts** (20 m Randstreifen nach unten) verdeckt.
- **Fernbereich:** Ein einzelnes Mesh deckt ±24 km ab, mit 192×192 Quads à 256 m (≈ 37 k Vertices), ausgerichtet am 1024-m-Raster.
  - Vertices, die im inneren Nahbereich liegen, werden um 40 m abgesenkt, damit das Fern-Mesh nicht durch die Nahkacheln sticht. Die Kante zwischen Nah- und Fernbereich verdecken die Skirts der Nahkacheln.
  - Neu erzeugt wird es, wenn das Flugzeug ≥ 2 km vom Mesh-Zentrum entfernt ist, und zwar **zeilenweise über mehrere Frames** (≈ 16 Zeilen pro Frame) in einen zweiten Buffer (Double Buffer). Ist er fertig, wird getauscht.
  - Im Fern-Mesh gibt es keine Bäume.
- **Summe:** ≤ 26 Draw Calls für Terrain, dazu Wasser (1 großes Quad).
- Die Geometrien kommen aus einem Pool je LOD (BufferGeometry wiederverwendet, nur `position`/`normal`/`color` neu geschrieben). Normalen werden aus zentralen Differenzen von h berechnet.
- Pro Frame werden höchstens 2 Nahkacheln generiert, die nächstgelegenen zuerst. Eine Kachel wird erst entfernt, wenn ihr Ersatz fertig ist. Beim Start werden alle 25 Kacheln synchron erzeugt, noch bevor das Menü erscheint.
- **Shader:** `MeshStandardMaterial` mit `onBeforeCompile`, ohne eigenes Lichtmodell. Die Albedo ergibt sich aus Höhe, Neigung und Noise. Das Feld-Patchwork entsteht über ein Weltkoordinaten-Voronoi-ähnliches Hash-Muster, Details über Weltkoordinaten-Noise (triplanar ist unnötig). Nebel und Schatten kommen gratis aus Three.

### 2.4 Rendering & Licht
- `WebGLRenderer` (antialias je nach Qualität, `outputColorSpace = SRGB`, `toneMapping = ACESFilmic`), dazu ein DirectionalLight (Sonne) und ein HemisphereLight, beide aus `sky.js` gesteuert.
- **Schatten:** Nur eine Shadow-Kamera eng um das Flugzeug und das Cockpit (±15 m, 2048² auf „Hoch“, 1024² auf „Mittel“, aus auf „Niedrig“). Cockpit-Schatten, die beim Kurven über das Panel wandern, sind der größte Immersionsgewinn. Terrain empfängt keine Schatten (Kosten).
- **Zwei Render-Pässe** (Cockpit 0,05–3 m, Terrain bis 25 km; `logarithmicDepthBuffer` bleibt aus). Es gibt eine einzige Szene mit drei Layern:
  - **Layer 0** enthält Welt und Außenmodell.
  - **Layer 1** enthält das opake Cockpit-Interieur.
  - **Layer 2** enthält Glas und transparente Cockpit-Teile, also Scheiben und Instrumentengläser.
  - **Alle Lichter** haben `layers.enableAll()`.

  Ablauf pro Frame:
  1. `renderer.autoClear = false`, dann `renderer.clear()`.
  2. **Pass 1:** `camera.layers` = {0,1}, near 0,5 m, far 30 km, `shadowMap.needsUpdate = true`. In diesem Pass entsteht die Shadow-Map mit **allen** Schattenwerfern (Außenflügel, Strebe, Haube **und** Cockpit-Teile wie Glareshield und Rahmen). Das Cockpit wird dabei grob mitgezeichnet; was näher als 0,5 m liegt, wird geclippt.
  3. `renderer.clearDepth()`.
  4. **Pass 2:** `camera.layers` = {1,2}, near 0,02 m, far 10 m, `shadowMap.needsUpdate = false`, also Wiederverwendung der Shadow-Map aus Pass 1. Das opake Cockpit überschreibt seine Pixel vollständig, danach werden die Gläser geblendet.

  Voraussetzung: `renderer.shadowMap.autoUpdate = false`. Die Außenmodell-Teile, die man aus dem Cockpit sieht (Haube, Flügel, Strebe), liegen auf Layer 0 und werden in Pass 1 korrekt gezeichnet. In der **Außenansicht** gibt es nur einen Pass mit Layern {0,1,2}. Die Projektionsmatrix wird pro Pass mit `updateProjectionMatrix()` neu gesetzt.
- **Frühes Gate (vor dem Terrain-Ausbau):** Ein Screenshot mit flachem Boden zeigt Cockpit, Haube und Flügel sowie einen Streben- bzw. Glareshield-Schatten auf dem Panel, der mit dem Kurs wandert.
- **Kein Floating Origin** (SPEC §3.1). Alle Objekte stehen in absoluten Weltkoordinaten.
  - Terrain-Kacheln sind als `Mesh.position` = Kachelursprung positioniert, die Vertices sind kachel-lokal.
  - Der Terrain-Shader nutzt `mod(worldPos.xz, 8192.0)` für Muster, damit die float32-Präzision im Shader ausreicht.
  - Die Shadow-Kamera folgt dem Flugzeug.
- **Statistik:** `renderer.info.autoReset = false`, `info.reset()` einmal pro Frame vor Pass 1, damit `perf().drawCalls` beide Pässe summiert.

### 2.5 Himmel (`sky.js`)
- Eigene Himmelskugel (BackSide) mit Fragment-Shader: vereinfachtes Preetham/Rayleigh-Mie mit Sonnenscheibe. Nachts kommt ein Sternen-Punktfeld dazu (Points, 2000 Sterne, Alpha ∝ Dunkelheit).
- Der Sonnenstand wird aus der Tageszeit berechnet (Deklination 0, Breite 48°).
- Die Nebelfarbe ist ein CPU-seitiger Näherungswert: Die Himmelsfarbe am Horizont wird aus Sonnenhöhe und dem Winkel zwischen Blick- und Sonnenrichtung über eine kleine Tabelle interpoliert. Das Shader-Ergebnis wird nicht exakt nachgerechnet, damit es günstig bleibt. Der Himmels-Shader blendet zum Horizont hin selbst in `fogColor` über und kaschiert so die Naht.
- Lichtintensität und Farbe von Sonne und Hemisphäre sind Funktionen der Sonnenhöhe (Tabelle mit 6 Stützstellen, interpoliert).

### 2.6 Wolken (`clouds.js`)
- Die Wolken liegen in Zellen von 2 km um die Kamera, deterministisch nach Zell-Hash und Bedeckungsgrad. Pro Wolke gibt es 8–20 weiche Sprites (InstancedMesh aus Quads, camera-facing im Vertex-Shader) mit einer prozedural erzeugten Puff-Textur (Canvas, einmalig).
- Beleuchtung: Die Oberseite wird hell, die Unterseite grau-blau je nach Sonnenrichtung eingefärbt, dazu kommt Rim-Licht bei Gegenlicht. Die Sprites werden in der Tiefe sortiert, das Blending ist `NormalBlending` mit Soft-Fade an der Kamera.
- `cloudDensityAt(p)` liefert die Dichte an einem Punkt für Fog-Near/Far (Sicht in der Wolke) und die Turbulenzbeigabe.

### 2.7 Cockpit (`cockpit.js`, `instruments.js`)
- Die Geometrie ist prozedural aus Box- und Shape-Extrusionen aufgebaut: Panel als extrudierte Shape mit Löchern für die Instrumente, Glareshield, Yoke-Säule und Horn, Hebel, Sitzkanten, Türrahmen und Fensterstreben. Der Innenraum ist abgedunkelt, erhält Umgebungslicht und Schatten.
- **Instrumente:** Ein Atlas-Canvas (2048 × 1024) wird mit 30 Hz neu gezeichnet, danach folgt **`texture.needsUpdate = true`**. Pro Instrument gibt es statische Hintergrund-Layer (gecacht in eigenen Offscreen-Canvases), dynamisch sind nur die Nadeln. Der Atlas dient als `CanvasTexture` (`colorSpace = SRGBColorSpace`, anisotrop) für die Instrument-Quads. Darüber liegt ein Glas-Quad auf Layer 2 mit leichtem Specular. Nachts wird ein Emissive-Anteil (rötlich, `emissiveMap` = Atlas) ergänzt.
- **Klickbarkeit:** Hit-Meshes (unsichtbar, Layer 1) haben `userData.control`. Pointerdown löst einen Raycast aus und startet den jeweiligen Handler (drag / click / wheel).

### 2.8 Input (`input.js`)
- Eine Demand-Schicht mit Zielwerten und Rampen erzeugt `controls` (einzige Quelle für die Physik). Die Rückstellung geht immer auf **0**; `trim` ist ein eigener Kanal. Tastatur, Maus-Yoke und Touch schreiben Demands, Priorität hat die zuletzt aktive Quelle.
- **Kamera-Blick:** yaw/pitch mit leichter Dämpfung (kritisch gedämpfte Feder für die Blicksteuerung); Kopfbewegung kommt additiv aus `head.js`.
- **Koordinationshilfe:** optional, nur > 30 m AGL, setzt Seitenruder-Demand ∝ −β (+ Querruder-Anteil); jede manuelle Seitenruder-Eingabe hat Vorrang. Nur Eingabe, keine Physik-Änderung.
- **Menü offen → Input gesperrt:** Tasten gehen an den Dialog, nicht an die Flugsteuerung.

### 2.9 Audio (`audio.js`)
- Der Graph wird einmalig bei der ersten Interaktion aufgebaut. Parameter werden pro Frame über `setTargetAtTime` gesetzt, damit keine Klicks entstehen.
- **Motor:** 2 Oszillatoren (sawtooth und square, Zündfrequenz und halbe) → WaveShaper (leichte Verzerrung) → Lowpass (Cutoff ∝ Gas) → Gain.
- **Prop:** Die Blattfrequenz amplitudenmoduliert einen Rausch-Bandpass.
- **Wind:** Rauschpuffer (2 s, Loop) → Bandpass/Lowpass ∝ IAS.
- **Stall-Horn:** Rechteck ~ 1,7 kHz → Bandpass.
- **Reifen:** Rauschen mit Tiefpass, dazu One-Shot-Buffers für Quietschen und Stoß, prozedural generiert.
- **Anlasser:** Ein LFO moduliert den Motor bei ~150 RPM.
- **Innenraum-Charakter:** Alles läuft durch ein gemeinsames Lowpass bei 4 kHz mit einer leichten Resonanz um 120 Hz, das den Kabinenklang erzeugt.

## 3. Arbeitspakete (Reihenfolge)

Die Reihenfolge folgt dem Prinzip „erst das Cockpit-Erlebnis als vertikaler Durchstich, dann die Welt ausbauen“.

1. **AP1 Gerüst:**
   - Verzeichnisse anlegen, three 0.186.0 vendoren: `npm pack three@0.186.0`, daraus nur `build/three.module.min.js`, `build/three.core.min.js` und LICENSE **ins selbe Verzeichnis** `vendor/three/`. Die Importmap zeigt nur auf `three.module.min.js`, das `./three.core.min.js` relativ lädt.
     - *Abweichung (bei der Umsetzung festgestellt):* Das npm-Paket `three@0.186.0` enthält keine `*.min.js`-Builds mehr, nur `build/three.module.js` und `build/three.core.js`. Vendored sind daher diese beiden Dateien byte-identisch aus dem Tarball; die Importmap zeigt auf `three.module.js`, das `./three.core.js` relativ lädt (gzip ≈ 420 KB, N6 bleibt eingehalten).
   - `index.html`, `main.js`-Loop, `launch.json`, README-Skelett.
   - **Gate:** Im Browser lädt `import * as THREE from "three"` ohne 404 und ohne Konsolenfehler.
2. **AP2 Sim-Kern:** `math.js` (inkl. Achsentests), `c172.js`, `atmosphere.js`, `aircraft.js`, `scenarios.js` sowie `heightfield.js` und `noise.js` (werden für `groundHeight` gebraucht). Parallel entsteht `tests/physics.test.mjs` mit AK-01..18. Es wird so lange getunt, bis alle Tests grün sind.
3. **AP3 Vertikaler Durchstich Cockpit:**
   - `model.js` (Außenmodell inkl. Animationen), `cockpit.js`, `instruments.js`
   - Zwei-Pass-Rendering mit Schatten
   - Einfacher Himmel (Farbverlauf) und die LOD-0-Nahkacheln ohne Fern-Mesh
   - Minimaler Tastatur-Input
   - Hauptschleife mit Render-Interpolation (2.1a) und Kopfbewegung (2.1b) inkl. `tests/loop.test.mjs`
   - **Gate:** Start, Platzrunde und Landung sind fliegbar (`tests/pattern.test.mjs`, AK-39). Der Screenshot erfüllt die Bildabnahme aus AK-24. **Entscheid:** Erst weiter, wenn Steuerung, Perspektive und Energiegefühl überzeugen — sonst zuerst Beiwerte, Eingaberampen und Kontaktmodell nachschärfen.
4. **AP4 Input komplett:** Tastatur, Maus (Look, Yoke-Modus, Klick-Hit-Zonen) und Touch-Layout.
5. **AP5 Audio.**
6. **AP6 Terrain komplett:** LOD 1, Fern-Mesh (Double Buffer), Terrain-Shader, `water.js`.
7. **AP7 Himmel, Licht, Wolken:** `sky.js` (Streuung, Sterne, Nacht-Beleuchtung), `clouds.js`, Nebelkopplung.
8. **AP8 Flugplatz & Vegetation:** `airport.js`, `vegetation.js`.
9. **AP9 UI** (inkl. App-Zustände, WebGL2-Check, Lade-/Fehler-/Context-Loss-Dialoge, native `<dialog>` mit Fokusführung, reduced motion, Kontrast, Input-Sperre bei offenem Menü): Menü, Settings (`config.js`, localStorage), Pause, Crash, Hilfe, Datenleiste, Orientierungshinweis, Qualitätsstufen, Außenkamera.
10. **AP10 Debug-Hook:** `debug.js` mit der vollen Shape aus SPEC §6. `perf()` summiert beide Pässe. Hinweis: `SIM` wird schon ab AP2/AP3 minimal angelegt und hier vervollständigt.
11. **AP11 Deploy:** `nginx.conf` (MIME, gzip, Revalidierung, 404, immutable nur für vendor), Ansible-Playbook mit Release-Verzeichnis + `current`-Symlink + Rollback-Task, `deploy/README.md`, README. Prüfung `nginx -t` in einem Debian-13-Container, falls Docker verfügbar, sonst ausdrücklich als offen markieren.
12. **AP12 Feinschliff & Performance:** Draw Calls prüfen, Konsole sauber halten.

## 4. Risiken / Stolpersteine & Gegenmittel

| Risiko | Gegenmittel |
|---|---|
| Vorzeichen- oder Achsenfehler zwischen Luftfahrt-Body-Achsen und Three-Welt | Genau eine Konvertierungsfunktion, dazu Unit-Tests für Nase, rechten Flügel und Querneigung. Die Aero-Momente werden per Test auf Stabilitätsvorzeichen geprüft (Cmα < 0 führt zu Rückstellung). |
| Physik instabil (Fahrwerksfedern, hohe Drehraten) | 120 Hz Fixed Step, Eigenfrequenz der Federn < 10 Hz, Dämpfung ζ ≈ 0,5, Clamps auf ω. Der Test „30 s Stand auf der Piste“ prüft auf Drift < 0,1 m. |
| Flugleistungen weichen von der C172 ab | Headless-Tests AK-01..18 mit Toleranzen. Die Beiwerte sind zentral in `c172.js` gebündelt, getunt wird nur dort. |
| Z-Fighting bei Cockpit + 25 km Sicht | Zwei Render-Pässe mit exakt festgelegter Layer-, Licht- und Schattenregel (2.4) und frühem visuellen Gate |
| Schatten fehlen im Cockpit-Pass | Die Shadow-Map entsteht nur in Pass 1 mit den Layern {0,1}, Pass 2 nutzt sie wieder (`autoUpdate = false`). |
| Float32-Präzision weit vom Ursprung | Kein Floating Origin nötig: CPU-Matrizen in float64, kachel-lokale Vertices, Shader-Muster per `mod()` |
| Physik-Boden ≠ sichtbarer Boden (Räder schweben oder sinken ein) | Globales 16-m-Raster, identische Triangulierung in `groundHeight` und im LOD-0-Mesh. Der 3×3-Block um das Flugzeug ist garantiert LOD 0. AK-20 wird an Kachelgrenzen getestet. |
| Fern-Mesh sticht durch Nahkacheln oder es entstehen Spalten | Fern-Vertices im Nahbereich −40 m, Skirts an allen Nahkacheln |
| Kachelgenerierung verursacht Ruckler | Budget von 2 Nahkacheln pro Frame, das Fern-Mesh zeilenweise per Double Buffer, Pool ohne Neuallokation |
| Vendored three lädt nicht (relative Datei `three.core.min.js` fehlt) | Beide Dateien liegen im selben Verzeichnis, AP1 hat ein Import-Gate. |
| Canvas-Instrumente frieren ein | `needsUpdate = true` nach jedem Zeichnen |
| Headless-Preview: rAF/ResizeObserver feuern nicht | `SIM.step(n)` und `SIM.render()` arbeiten synchron. Die Tests nutzen diese Hooks statt Warten. |
| AudioContext blockiert (Autoplay-Policy) | Start bei der ersten `pointerdown`- oder `keydown`-Interaktion, `resume()` bei `visibilitychange` |
| iOS Safari: `100vh`, Touch-Gesten, Pinch-Zoom | `100dvh`, `touch-action: none` auf dem Canvas bzw. den Touch-Controls, `viewport` mit `user-scalable=no`, `-webkit-user-select: none` |
| Tastenkonflikte (F5 = Reload, Ctrl-Kombis) | `preventDefault` nur für eigene Tasten, außer bei gedrückter Meta/Ctrl-Taste. F5/F6 haben die Alternativen F/V. |
| Transparenz-Sortierung der Wolken und Propellerscheibe | Wolken-Sprites mit `depthWrite: false`, Sortierung pro Wolke nach Kameradistanz. Die Prop-Scheibe liegt in einer eigenen `renderOrder`. |
| Draw Calls explodieren | Instancing für Bäume, Wolken und Befeuerung. Die Cockpit-Geometrie wird pro Material gemerged (`mergeGeometries` selbst implementiert, keine Addons), Terrain ≤ ~120 Kacheln. |
| Mikroruckeln durch 120-Hz-Physik vs. 60/144-Hz-Display | Render-Interpolation (2.1a), AK-34 |
| Hängende Ruder nach Fokusverlust | `input.clearAll()` bei blur/visibilitychange, AK-35 |
| Kopfbewegung wirkt billig/übelkeitserregend | Harte Clamps 2 cm/1°, keine Zufallsbewegung, Default 50 %, reduced motion → 0, AK-37 |
| Fehlerhaftes Deployment ohne Rückweg | Release-Verzeichnisse + Symlink, Rollback im Playbook, AK-40 |
| Überengineering | Keine ECS, keine Event-Bus-Frameworks, keine Klassenhierarchien. Die Module exportieren Funktionen bzw. einfache Objekte. |

## 5. Test- und Abnahmeschritte

1. **Headless (Node):** `node --test tests/` deckt AK-01..18 und AK-20 (Heightfield-Seite) ab und muss grün sein.
2. **Browser-Preview** (`.claude/launch.json` → `python3 -m http.server 8080`):
   - Laden, Konsole prüfen (AK-32).
   - Die Szenarien `runway`, `final` und `cruise` über `SIM.reset` durchgehen, per `SIM.step` fliegen und die Werte prüfen (AK-19, 20, 23, 24, 25).
   - Tastatur-Events dispatchen und `SIM.controls` prüfen (AK-26). Settings-Slider ändern und nach dem Reload kontrollieren (AK-27).
   - Mobile-Viewport mit Pointer-Events auf den Touch-Controls (AK-28).
   - Audio: Nach einem Klick den AudioContext-Status und die Oszillatorfrequenzen über `SIM` bzw. das Audio-Debugfeld prüfen (AK-29).
   - Tageszeit 0 / 6,5 / 12 / 18,5 h und Wolken 0 / 80 % einstellen und jeweils einen Screenshot machen (AK-21, 22).
   - Pause und Visibility testen (AK-30), `SIM.perf()` auslesen (AK-31).
3. **nginx-Check:** Lokal ist kein nginx nötig. Die Konfiguration wird per `nginx -t` in der VM oder im Container geprüft. Das ist in der README dokumentiert, geprüft werden MIME-Typ und gzip.
4. **Reviews:**
   - Codex CLI (`gpt-6-sol`) reviewt SPEC und PLAN vor der Umsetzung.
   - Workflow-Zyklus aus Implement, parallelem Review (Fachlogik/Physik, UI/Interaktion, Rendering/Performance) und Fix, mit `codex review --uncommitted` am Ende von Implement und Fix.
   - Abschließend ein Codex-CLI-Review über das Gesamtprojekt.
