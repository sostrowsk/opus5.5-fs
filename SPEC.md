# SPEC – Browser-Flugsimulator „C172 Web“

Version 1.1 · Stand 2026-09-22 (ergänzt: Render-Interpolation, Kopfbewegung, Robustheit, Barrierefreiheit, Release/Rollback)

## 1. Ziel und Vision

Ein Flugsimulator im Browser, der sich anfühlt wie das Sitzen im Cockpit einer **Cessna 172**. Er richtet sich nicht an Arcade-Spieler. Maßgeblich ist das Fluggefühl:

- **Fluggefühl:** Die Flugphysik ist ein 6-DOF-Starrkörpermodell mit echten C172-Kennwerten. Dazu gehören Propellerdrehmoment, P-Faktor, Slipstream auf das Seitenruder, Strömungsabriss mit Flügelabkippen, Trimmung, Bodeneffekt und ein federndes Fahrwerk. Die Maschine hat eine eigene Trägheit: Sie „schwimmt“ leicht in Böen, lässt sich austrimmen und fliegt dann hands-off geradeaus.
- **Cockpit:** Der Blick geht vom linken Sitz aus. Im Cockpit liegen ein Instrumentenbrett mit Six-Pack und Drehzahlmesser, ein beweglicher Steuerhorn-Yoke, der Gashebel, der Klappenhebel und das Trimmrad. Nach vorn sieht man die Motorhaube mit dem drehenden Propeller, durch die Seitenfenster den Hochdecker-Flügel samt Strebe.
- **Welt:** Endloses prozedurales Terrain mit Hügeln, Bergen, Seen, Wäldern und Feldern. Dazu kommt ein Flugplatz mit asphaltierter Piste. Himmel, Sonnenstand, Dunst und Wolken passen zur eingestellten Tageszeit.
- **Klang:** Motor, Propeller, Fahrtwind, Überziehwarnung und Reifen werden live per WebAudio synthetisiert. Es gibt keine Audiodateien.

**Priorität bei Zielkonflikten:** Fluggefühl → Cockpit & Bedienung → stabile Bildrate → Welt → weitere Features. Mehr Szenerie kaschiert kein schlechtes Fluggefühl; Messwerte allein belegen kein Cockpitgefühl (deshalb zusätzlich Bild- und Testflug-Abnahme, §8).

Grundsatz: **So viel natives JS wie möglich, so wenige Pakete wie nötig.** Die einzige Laufzeitabhängigkeit ist **Three.js**. Es liegt vendored im Repo, die Seite braucht keinen Build und kein CDN.

## 2. Technische Rahmenbedingungen

| Thema | Festlegung |
|---|---|
| Auslieferung | Rein statische Website (HTML, CSS, ES-Module). Kein Backend. |
| Server | nginx auf **Debian 13 (trixie)**. Das Deployment kommt später per Ansible; das Repo liefert dafür `deploy/nginx.conf` und ein minimales `deploy/ansible/playbook.yml`. |
| Laufzeit-Abhängigkeit | `three` (npm, Version **0.186.0**). Vendored unter `vendor/three/` und per `<script type="importmap">` eingebunden. Aus `three/addons` wird nur verwendet, was nötig ist, voraussichtlich **nichts**. |
| Build | Keiner. Die Dateien werden 1:1 ausgeliefert. |
| Dev-/Test-Tools | `python3 -m http.server` für die lokale Vorschau, `node --test` (nativ, ohne Pakete) für headless Physiktests. Es gibt keine `package.json`-Abhängigkeiten. |
| Browser | Aktuelle Chrome/Edge, Firefox und Safari (Desktop), dazu Safari iOS 17+ und Chrome Android. Voraussetzung ist WebGL2. |
| Sprache der UI | Deutsch |
| Einheiten | Luftfahrtüblich in der Anzeige: kt, ft, ft/min, inHg/hPa, °. Intern wird durchgehend in SI gerechnet. |
| Persistenz | Einstellungen liegen in `localStorage` (mit try/catch; die Seite funktioniert auch ohne). |

## 3. Fachliches Modell

### 3.1 Koordinaten & Zeit
- Die Welt ist in Metern angelegt: +X = Ost, +Y = oben, −Z = Nord (Three.js-Konvention). Kurs 0° entspricht Nord.
- Die Physik läuft mit **festem Zeitschritt von 1/120 s** in einer Akkumulator-Schleife. Pro Frame sind höchstens 8 Substeps erlaubt; ein Überschuss wird verworfen und in `perf().droppedSteps` gezählt (Anti-Spiral-of-Death).
- **Render-Interpolation:** Gerendert wird nie der rohe letzte Physikzustand, sondern eine Interpolation zwischen den letzten beiden Zuständen mit α = Akkumulator/dt (Position linear, Orientierung per Slerp). Das verhindert Mikroruckeln bei 60/90/120/144-Hz-Displays, die nicht synchron zu 120 Hz laufen.
- **Determinismus:** Gleiche Eingabefolge pro Physikschritt ergibt unabhängig von der Bildrate bit-identische Zustände (Zufall nur über geseedeten RNG, der im Physikschritt fortgeschaltet wird).
- **Fokusverlust / verdeckter Tab:** automatische Pause, alle gehaltenen Tasten und Touch-Eingaben werden gelöscht (keine hängenden Ruder), beim Fortsetzen wird die Uhr zurückgesetzt (kein Zeitsprung).
- **Kein Floating Origin.** Die Physik rechnet in float64 (JS-Number). Three.js berechnet `modelViewMatrix` auf der CPU in float64, sodass bis ±200 km kein sichtbarer Jitter entsteht. Terrain-Vertices werden kachel-lokal gespeichert, Shader-Muster nutzen kachel-lokale bzw. modulo-reduzierte Koordinaten. Das ist bewusst einfach gehalten; ein Floating Origin wäre erst jenseits von 200 km nötig und ist Out of Scope.

### 3.2 Flugzeug (Cessna 172P, Referenzdaten)

| Größe | Wert |
|---|---|
| Referenzmuster | Cessna 172P (1982), POH als Referenz. MTOW 2400 lb = **1089 kg** |
| Masse (Default) | 1000 kg (einstellbar 800–1089 kg). Leistungs-Akzeptanztests laufen mit **1089 kg**, Schwerpunkt Mitte, ISA |
| Flügelfläche S / Spannweite b / MAC c | 16,17 m² / 10,97 m / 1,49 m |
| Trägheitsmomente Ixx / Iyy / Izz | 1285 / 1825 / 2667 kg·m² (Ixz ≈ 0) |
| Motor | 160 hp (119 kW) bei 2700 RPM, Leistung ∝ Dichteverhältnis^1,1 |
| Propeller | Starr, 2 Blätter, Ø 1,905 m, CT/CP-Tabellen über den Fortschrittsgrad J |
| Klappen | 0° / 10° / 20° / 30°, Stellgeschwindigkeit ≈ 3°/s (elektrisch) |
| Ruderausschläge | Höhenruder +28/−23°, Querruder ±20°, Seitenruder ±16° |
| Fahrwerk | Bugradfahrwerk: Bugrad lenkbar ±10° über das Seitenruder, Hauptfahrwerk mit Einzelbremsen |

**Aerodynamik** (Beiwerte, Richtwerte zum Abstimmen):
- Auftrieb: CL = CL0 + CLα·α + CLδe·δe + CLq·q̂ + ΔCL_Klappen, mit nichtlinearem Abfall nach CLmax (Stall) und Hysterese. Die Hysterese wird über eine interne Strömungsablöse-Zustandsvariable mit Zeitkonstante modelliert.
- Widerstand: CD = CD0 + ΔCD0_Klappen + k·CL² + CD_β. Der Bodeneffekt reduziert den induzierten Widerstand unterhalb einer Spannweite über Grund.
- Momente: Cm (Längsstabilität, Nickdämpfung, Höhenruder, Trimmung, Klappen-Nickmoment), Cl (Rollen: Schiebe-Roll-Moment, Rolldämpfung, Querruder), Cn (Kursstabilität, Gierdämpfung, Seitenruder, negatives Wendemoment).
- Stall: Die Aerodynamik rechnet mit Staudruck bzw. TAS; die Stallwerte ergeben sich daher als **CAS**. CLmax wird so getunt, dass bei 1089 kg ein Stall clean bei ≈ 51 KCAS und mit Klappen 30 bei ≈ 46 KCAS eintritt. Beim Abkippen entsteht ein **kontinuierlicher, begrenzter asymmetrischer Auftriebsverlust** zwischen linkem und rechtem Flügel, abhängig von α, β und Seitenruder, ohne einmaligen Impuls. Ein fester Seed liefert nur eine kleine Grundasymmetrie, sodass das Verhalten reproduzierbar bleibt.
- **Fahrtmesser-Kalibrierung:** Die Anzeige wandelt KCAS → KIAS über eine POH-nahe Tabelle je Klappenstellung (Tabelle im PLAN). `state` liefert `cas_kt` und `ias_kt`.
- Ruderwirksamkeit ergibt sich ausschließlich aus dem (Slipstream-)Staudruck — bei geringer Anströmung werden die Ruder weich, im Propellerstrahl bleibt das Seitenruder am Boden wirksam. Die Steuerflächen folgen der Eingabe mit begrenzter Stellrate (≈ 90°/s), nicht sprunghaft.
- **Keine künstlichen Hilfen in der Physik:** keine Landemagnetik, kein Auto-Level, kein heimliches Halten von Höhe/Fahrt. Hilfen (§4.3) wirken nur auf die Eingabe und sind sichtbar benannt.
- Propellereffekte: Drehmoment-Rollmoment, P-Faktor (Giermoment ∝ α bei hoher Leistung), Slipstream-Staudruck auf Höhen- und Seitenleitwerk.

**Motor/Propeller:** Die Drehzahl ergibt sich dynamisch aus dem Gleichgewicht zwischen Motordrehmoment (Gasstellung, Dichte) und Propellerdrehmoment (CP(J)). Bei starrem Propeller steigt die RPM daher mit der Fahrt. Das Trägheitsmoment von Motor und Propeller ist als Parameter vorhanden. Die Zündung hat die Stellungen OFF / BOTH / START: Der Anlasser dreht bei START auf etwa 150–250 RPM, oberhalb von ~300 RPM läuft der Motor dann selbst.

Randfälle:
- Unterhalb von 100 RPM wird J nicht über V/(nD) gebildet. Dann gilt ein eigener Stand- bzw. Anlaufbereich: Schub ∝ n², Windmilling-Drehmoment aus dem Anströmwinkel.
- Die RPM ist auf 0–3200 begrenzt.
- Im Flug windmillt der Propeller bei Zündung OFF weiter. Die RPM fällt dann nur am Boden bzw. bei geringer Fahrt auf 0.

**Fahrwerk/Boden:** Pro Rad gibt es einen Feder-Dämpfer-Kontakt auf die Terrainhöhe und berechnet eine Normalkraft. Dazu kommen Roll- und Seitenreibung (Asphalt µ ≈ 0,8, Gras ≈ 0,5, Rollwiderstand 0,02 bzw. 0,05) sowie Radbremsen. Das Bugrad wird über das Seitenruder gelenkt, Differenzialbremsen sind per Taste möglich. Die Radrotation wird für die Animation berechnet.

**Crash-/Schadenslogik:** Es wird nur echte Belastung bewertet, keine Spielregeln.

Ein Crash wird ausgelöst durch:
- **Fahrwerksbruch:** Die Einfederung eines Rades erreicht den Endanschlag, während die Kontaktpunkt-Vertikalgeschwindigkeit mehr als 3,5 m/s beträgt. Alternativ überschreitet die Federkraft eines Rades das 4-fache seiner statischen Last.
- **Strukturkontakt:** Rumpf, Flügelspitze, Heck oder Propellerspitze berühren den Boden. Die Propellerspitze beschädigt nur den Propeller, der Motor stirbt, es folgt ein Crash.
- **Wasserkontakt** eines beliebigen Kontaktpunkts.
- **Strukturversagen:** Überschreiten der Bruchlast, also mehr als +5,7 g oder weniger als −2,3 g (1,5 × Limit von +3,8/−1,52 g).

**VNE (158 KIAS) ist kein Crash.** Oberhalb von VNE ertönt ein Überdrehzahl- bzw. Überfahrt-Warnhinweis (Datenleiste und Ton), ebenso oberhalb von 2700 RPM.

Nach einem Crash erscheint ein Overlay mit dem Grund und der Option „Neustart“.

### 3.3 Atmosphäre & Wetter
- ISA-Atmosphäre für Temperatur, Druck und Dichte über der Höhe. Der Luftdruck am Platz (QNH) ist einstellbar, der Höhenmesser hat einen Kollsman-Knopf.
- Wind: Richtung und Stärke am Boden, dazu eine Windzunahme mit der Höhe (logarithmische Grenzschicht bis 600 m AGL).
- Böen: Der Böigkeitsgrad ist einstellbar. Böen entstehen aus tiefpassgefiltertem Rauschen (Dryden-ähnlich, drei Achsen). Der Turbulenzgrad hängt zusätzlich von der Höhe über Grund ab.
- Wolken: Bedeckungsgrad 0–100 %, Wolkenuntergrenze einstellbar. Im Inneren einer Wolke nimmt die Sicht auf unter 100 m ab (Fog) und es wird leicht turbulent.

### 3.4 Tageszeit & Licht
- Tageszeit 0–24 h, stufenlos. Der Sonnenstand wird vereinfacht für ~48° N am Tag der Tagundnachtgleiche berechnet (einstellbares Datum ist Out of Scope).
- Himmel mit physikalisch motivierter Streuung (Rayleigh/Mie, eigener Shader). Dämmerungsfarben entstehen daraus automatisch.
- Nachts gibt es einen Sternenhimmel, beleuchtete Instrumente (rötliche Panelbeleuchtung), Landelicht sowie Positions- und Strobe-Lichter an den Flügelspitzen.
- Dunst/Aerial Perspective: Die Nebelfarbe entspricht der Himmelsfarbe am Horizont in Blickrichtung und damit auch der Sonnenrichtung.

### 3.5 Welt
- **Terrain:** Die Höhe ist eine deterministische Funktion h(x, z) aus fBm- und Ridged-Noise mit festem Seed. Es gibt zwei Ebenen: Nahkacheln 5×5 à 1024 m (LOD 0/1) um das Flugzeug und ein einzelnes grobes **Fern-Mesh** von ±24 km, das beim Weiterfliegen im Hintergrund neu erzeugt wird. Die Sichtweite beträgt ≈ 20 km, der Fog verdeckt den Rand. Die Physik kollidiert gegen dasselbe Dreiecksraster wie die LOD-0-Nahkacheln. LOD 0 liegt garantiert in jede Richtung mindestens 1 km um das Flugzeug.
- **Oberflächen:** Die Farbe wird im Shader aus Höhe und Neigung gemischt: Wiese, Acker-Patchwork, Wald, Fels und Schnee ab ~1800 m. Seen liegen auf einem festen Wasserspiegel und spiegeln den Himmel sowie ein Sonnenglitzern.
- **Vegetation:** Bäume werden als InstancedMesh (Nadel- und Laubbaum, Low-Poly) nur im Nahbereich (~3 km) gezeichnet und nach einer Dichtefunktion verteilt. Auf Piste und Wasser stehen keine Bäume.
- **Flugplatz „Talheim“ (fiktiv, Kennung XTAL; bewusst keine reale ICAO-Kennung):** Er liegt bei (0,0) auf 450 m MSL (1476 ft), das Terrain ist dort weich eingeebnet. Die Piste 09/27 ist 1200 × 30 m Asphalt mit Markierungen: Schwellen, Kennziffern, Mittellinie und Aufsetzzonen. Dazu gehören ein Rollweg, ein Vorfeld, zwei Hangars, ein Windsack (animiert nach dem Wind), PAPI-Anlagen für beide Richtungen und Pistenrandbefeuerung, die nachts leuchtet.

### 3.6 Flugzeugmodell (außen) & Animationen
Das Modell ist prozedural aus Three.js-Geometrie aufgebaut, ohne GLTF-Dateien: Rumpf, Hochdecker-Flügel mit Streben, Leitwerk, Radverkleidungen, Spinner und Propeller.

Animiert werden:
- Querruder, Höhenruder, Seitenruder, Trimmruder und Klappen, jeweils synchron zum Physikzustand
- der Propeller: Bis ~600 RPM sind die Blätter sichtbar, darüber wird er als halbtransparente Blur-Scheibe mit Sonnenstreifen dargestellt
- die Räder: Rotation und Einfederung
- der Windsack
- die Lichter

### 3.7 Cockpit
- Der Pilotenkopf sitzt links vorn. Mausblick ist möglich (Gier ±150°, Nick −60/+45°). Das FOV ist einstellbar, Default 70°.
- Sichtbare Teile: Glareshield, Instrumentenbrett, Yoke (bewegt sich mit Nick- und Roll-Eingabe), Gashebel (Schubstange bewegt sich), Klappenhebel mit Anzeige, Trimmrad mit Trimmanzeige, Zündschlüssel, Lichtschalter, Parkbremse, Seitenruderpedale, Türrahmen, Fenster und A-Säulen. Außen sieht man die Motorhaube, den Propeller, die Flügelunterseite und die Strebe.
- **Instrumente** werden per nativem Canvas 2D gezeichnet und als Textur aufs Panel gelegt:

| Instrument | Anzeige | Dynamik/Besonderheit |
|---|---|---|
| Fahrtmesser (ASI) | 0–200 kt, weißer, grüner, gelber und roter Bogen | Nadel mit Verzögerung von τ = 0,15 s |
| Künstlicher Horizont (AI) | Nick ±30°, Querneigung mit Skala 10/20/30/60° | Kreisel mit leichter Nachlaufträgheit |
| Höhenmesser | 0–20 000 ft, drei Zeiger, Kollsman-Fenster | Anzeige basiert auf Druckhöhe und QNH |
| Wendezeiger/Koordinator | Flugzeugsymbol und Kugel | Die Kugel folgt der Querbeschleunigung |
| Kurskreisel (HI) | Rose 360° | Einstellknopf zum Angleichen an den Kompass |
| Variometer (VSI) | ±2000 ft/min | Verzögerung von τ = 1,5 s, wie das Original |
| Drehzahlmesser | 0–3500 RPM, grüner Bogen 2100–2700 | – |
| Magnetkompass | Schwimmkompass auf dem Glareshield | Einfache Dreh- und Beschleunigungsfehler |

**Panel-Layout (verbindlich):** Oben liegen von links ASI, AI und ALT, unten TC, HI und VSI; der Drehzahlmesser sitzt rechts unten neben dem Six-Pack, die Instrumente vor dem Piloten. Das Auge sitzt ca. 0,75 m hinter dem Panel und 0,12 m über der Glareshield-Oberkante. Bei Default-FOV 70° und 1920×1080 hat jedes Six-Pack-Instrument einen Durchmesser von mindestens 90 px, und über die Motorhaube ist der Horizont sichtbar (Glareshield-Kante bei ca. −8° unter der Blickachse).
| Klappen-/Trimmanzeige | Mechanisch am Hebel bzw. Rad | – |

- **Kopfbewegung (dezent, abschaltbar):** Der Kopf ist ein gedämpftes Feder-Masse-System, angeregt durch Lastvielfache/Querbeschleunigung im Pilotenpunkt, Turbulenz und Fahrwerksstöße. Begrenzung: max. 2 cm Versatz und 1° Drehung, Rückkehr zur Neutrallage, **kein** zufälliges Dauerwackeln, keine automatische Horizontaufrichtung, kein fahrtabhängiger Zoom. Stärke 0–100 % (Default 50 %); bei `prefers-reduced-motion` Default 0 %. Am Boden bei laufendem Motor eine sehr leichte, drehzahlabhängige Vibration (< 1 mm), bei 0 % ebenfalls aus.
- Glas: Leichte Spiegelung auf den Instrumentengläsern und eine dezente Windschutzscheibe, beides ohne teure Reflexionen.

### 3.8 Sound (WebAudio, synthetisiert)

| Quelle | Umsetzung |
|---|---|
| Motor | Harmonische der Zündfrequenz (RPM/60 × 2), Filter nach Last, leichte Zufallsmodulation |
| Propeller | Blattfrequenz (RPM/60 × 2) als gefilterter Puls, Pegel hängt von Last und Fahrt ab |
| Fahrtwind | Gefiltertes Rauschen, Pegel und Frequenz ∝ IAS |
| Überziehwarnung | Stall-Horn-Ton, sobald der Anstellwinkel ~5–10 kt vor dem Stall erreicht ist |
| Reifen | Rollgeräusch ∝ Radgeschwindigkeit, Quietschen beim Aufsetzen mit Schlupf, dumpfer Stoß beim Aufsetzen |
| Klappenmotor | Brummen während die Klappen fahren |
| Anlasser | Rhythmisches Anlasser-Geräusch bei START |

Der AudioContext startet erst nach der ersten Nutzerinteraktion. Die Lautstärke lässt sich regeln, Mute ist möglich.

## 4. UI-Spezifikation

### 4.1 Bildschirme
1. **Startmenü** (Overlay über der rotierenden Außenansicht):
   - Szenario-Auswahl
   - Button „Fliegen“
   - Einstellungen
   - Tastenhilfe
2. **Flug:** Vollbild-Cockpit. Standardmäßig ist nichts eingeblendet, optional eine dezente Datenleiste (Taste `H`).
3. **Pause** (`P`/`Esc`): Die Simulation friert ein. Das Overlay bietet Fortsetzen, Neustart, Einstellungen und Hauptmenü.
4. **Crash-Overlay:** Zeigt den Grund und bietet einen Neustart.
5. **Hochkant-Hinweis** auf Handys: „Bitte Gerät drehen“.
6. **Lade- und Fehlerzustände:** App-Zustände `loading → ready → running ⇄ paused → crashed`, sowie `error`. Beim Laden echter Fortschritt (Module, Terrain-Initialisierung) statt Endlos-Spinner. Fehlt WebGL2, erscheint eine verständliche Meldung statt schwarzem Canvas. Ladefehler zeigen „Erneut versuchen“. Bei `webglcontextlost` pausiert die Simulation und bietet nach `webglcontextrestored` einen kontrollierten Neustart an.

### 4.2 Szenarien

| ID | Name | Startzustand |
|---|---|---|
| `runway` | Startbereit Piste 27 | Am Pistenanfang 27, Motor im Leerlauf, Klappen 0, Parkbremse gesetzt |
| `final` | Endanflug Piste 27 | 3 NM Final, 1000 ft AGL, 70 KIAS, Klappen 20, getrimmt |
| `cruise` | Reiseflug | 4500 ft MSL, 105 KIAS, 2400 RPM, getrimmt, Kurs 270 |

### 4.3 Einstellungen

| Control | Typ | Wertebereich | Default |
|---|---|---|---|
| Tageszeit | Slider | 0,0–24,0 h (Schritt 0,1) | 10,0 |
| Windrichtung | Slider | 0–359° | 240 |
| Windstärke | Slider | 0–35 kt | 8 |
| Böigkeit/Turbulenz | Slider | 0–100 % | 20 |
| Bewölkung | Slider | 0–100 % | 35 |
| Wolkenuntergrenze | Slider | 1500–9000 ft MSL | 4000 |
| QNH | Slider | 980–1040 hPa | 1013 |
| Beladung (Masse) | Slider | 800–1089 kg | 1000 |
| Grafikqualität | Auswahl | Niedrig / Mittel / Hoch | Mittel (Handy: Niedrig) |
| Sichtfeld (FOV) | Slider | 50–90° | 70 |
| Mausempfindlichkeit | Slider | 0,2–3,0 | 1,0 |
| Yoke-Modus Maus | Toggle | an/aus | aus |
| Höhenruder invertieren | Toggle | an/aus | aus |
| Lautstärke | Slider | 0–100 % | 70 |
| Datenleiste anzeigen | Toggle | an/aus | aus |
| Kopfbewegung | Slider | 0–100 % | 50 % (0 % bei reduced motion) |
| Koordinationshilfe (Auto-Seitenruder) | Toggle | an/aus; nur > 30 m AGL, manuelles Seitenruder hat Vorrang | aus |

Alle Werte außer der Masse wirken sofort, auch während des Flugs. Die Masse wird beim Neustart übernommen.

### 4.4 Tastaturbelegung

| Taste | Funktion |
|---|---|
| ↑ / ↓ | Höhenruder (drücken/ziehen, invertierbar) |
| ← / → | Querruder |
| Z / X (oder , / .) | Seitenruder links/rechts |
| Bild↑/Bild↓ oder + / − | Gas |
| Shift + + / Shift + − | Gas voll / Leerlauf |
| F5 / F6 bzw. F / V | Klappen hoch/runter (eine Stufe) |
| Pos1/Ende bzw. T / G | Trimmung nachdrücken/ziehen (halten) |
| B | Radbremsen (halten) |
| Shift+B | Parkbremse umschalten |
| N / M | Differenzialbremse links/rechts |
| I | Zündung durchschalten (OFF→BOTH; halten = START) |
| L | Landelicht |
| O | Positions- und Strobe-Lichter |
| C | Cockpit ↔ Außenansicht (Orbit) |
| 1–4 | Blick: vorn / links / rechts / Panel |
| Leertaste | Blick zentrieren |
| H | Datenleiste |
| P / Esc | Pause |
| R | Szenario neu starten |
| ? | Hilfe |

Tastatureingaben auf die Ruder werden **geglättet**: Solange die Taste gehalten wird, steigt der Ausschlag rampenförmig an (~1,5/s). Nach dem Loslassen geht er zügig auf **0** zurück (~3/s). Das verhindert digitale Ausschläge.

**Trimmung** ist eine eigene aerodynamische Größe (Trimmruder-Moment) und verschiebt nicht den Yoke-Nullpunkt. Yoke-Position, resultierender Höhenruderausschlag und Trimmstellung sind in `SIM.state`/`controls` getrennt sichtbar.

### 4.5 Maus
- **Umsehen:** Bei gedrückter rechter Maustaste (oder mittlerer bzw. Alt + links) ziehen. Mit dem Mausrad lässt sich das FOV zoomen (40–90°).
- **Klickbare Bedienelemente:**
  - Gashebel ziehen/schieben (vertikaler Drag)
  - Klappenhebel (Klick auf die obere bzw. untere Hälfte)
  - Trimmrad (Drag oder Mausrad)
  - Zündschlüssel
  - Lichtschalter
  - Parkbremse
  - Kollsman-Knopf (Mausrad)
  - HI-Einstellknopf (Mausrad)

  Beim Hover erscheint ein Hand-Cursor mit dezentem Tooltip.
- **Yoke-Modus** (Einstellung): Die Mausposition relativ zur Bildschirmmitte steuert Nick und Roll, der Cursor bleibt sichtbar. Umsehen funktioniert weiterhin mit der rechten Taste.

### 4.6 Touch (Tablet/Handy, Querformat)
- Links liegt ein **virtueller Yoke-Stick** (runder Bereich, Rückstellung in die Mitte), rechts ein **vertikaler Gashebel-Slider**.
- Unten befindet sich ein **Seitenruder-Slider** (horizontal, federt zurück).
- Buttons:
  - Klappen ▲/▼
  - Bremse (halten)
  - Trimm ▲/▼
  - Ansicht
  - Pause
- Ein Ein-Finger-Drag auf freier Fläche dreht den Blick.
- Die Buttons sind mindestens 44 × 44 CSS-px groß und halbtransparent. Nach 4 s ohne Touch-Bedienung blenden sie auf 30 % Deckkraft ab.
- Auf Touch-Geräten erscheint das Touch-Layout automatisch (`pointer: coarse`), über das Menü lässt es sich umschalten.

### 4.7 Visuelles Design der UI
Die Menüs sind „Luftfahrt-Instrumenten“-inspiriert: dunkles, mattes Anthrazit, weiße Beschriftung, Akzente in Instrumenten-Grün und Warn-Gelb. Als Schrift dient eine System-Monospace-Schrift für Werte und System-Sans für den Text, es werden keine Webfonts geladen. Übergänge sind weiche Fades von 200 ms. Die Menüs liegen halbtransparent über der laufenden 3D-Szene (`backdrop-filter`-Blur nur auf kleinen Panels, auf Qualität „Niedrig“ aus).

**Barrierefreiheit & Bedienlogik der Menüs:**
- Menüs sind semantisches HTML (native `<dialog>`), vollständig per Tastatur bedienbar, sichtbarer Fokus, Fokus bleibt im offenen Dialog und kehrt danach zum Auslöser zurück.
- Textkontrast ≥ 4,5:1; Farbcodierungen (Warnungen) immer zusätzlich mit Text/Symbol.
- Solange ein Menü offen ist, lösen Tasten **keine** Flugsteuerung aus; Fortsetzen ist eine bewusste Aktion.
- `prefers-reduced-motion`: UI-Übergänge und Kopfbewegung aus.
- Warnhinweise (STALL, VNE, Überdrehzahl) verdecken nie Piste oder Horizont.

## 5. Nicht-funktionale Anforderungen

| # | Anforderung | Ziel |
|---|---|---|
| N1 | Framerate Desktop (Referenz: Apple M1 bzw. Intel Iris Xe, 1920×1080, Qualität Mittel) | ≥ 60 fps im Median, 1 %-Low ≥ 45 fps |
| N2 | Framerate Handy (Referenz: iPhone 13 bzw. Pixel 7, Qualität Niedrig) | ≥ 30 fps |
| N3 | Rechenzeit Physik | ≤ 0,3 ms pro Substep (120 Hz) auf Desktop |
| N4 | Nachladen von Terrain-Kacheln | Kein Frame länger als 50 ms durch Kachelgenerierung (Budget: höchstens 2 Nahkacheln pro Frame; das Fern-Mesh wird zeilenweise über mehrere Frames erzeugt) |
| N5 | Ladezeit bis zum Startmenü | ≤ 2 s im LAN, ≤ 5 s bei 10 Mbit/s |
| N6 | Transfervolumen (gzip) | ≤ 1 MB insgesamt |
| N7 | Konsole | Keine Errors oder Warnings im normalen Betrieb |
| N8 | Draw Calls (Mittel) | ≤ 250 |
| N9 | Speicher | Kein kontinuierlicher Anstieg: JS-Heap nach 10 min Flug ≤ +20 % gegenüber Minute 1 |
| N11 | Frame-Pacing | p95 der Bildintervalle ≤ 20 ms im 5-min-Referenzflug nach Aufwärmphase |
| N12 | Dauerbetrieb | 20 min gemischter Flug inkl. Pausen, Ansichtswechseln und Neustarts ohne Fehler und ohne fortlaufendes Speicherwachstum |
| N13 | Keine Drittanbieter | Nach dem Laden null Requests an fremde Hosts (kein CDN, keine Fonts, keine Telemetrie) |
| N10 | Robustheit | Tab verstecken und wieder zeigen führt nicht zu einem Physiksprung. dt wird begrenzt, im Hintergrund pausiert die Simulation automatisch. |

## 6. Debug-/Test-Hook

`window.SIM` (immer vorhanden, dokumentiert):

```js
window.SIM = {
  state,            // live: { pos:{x,y,z} (m, Welt), vel, quat, omega, ias_kt, tas_kt, gs_kt,
                    //   cas_kt, alt_ft (MSL), agl_ft, vs_fpm, pitch_deg, bank_deg, heading_deg, aoa_deg,
                    //   beta_deg, rpm, flaps_deg, elevatorDeg, trimDeg, onGround, stalled, crashed, crashReason,
                    //   warnings:[], g, time }
  controls,         // live: { elevator, aileron, rudder (−1..1), throttle (0..1), trim (−1..1),
                    //   flapsCmd (0..3), brakeL, brakeR (0..1), parkingBrake, ignition }
  env,              // live: { timeOfDay, windDir, windKt, turbulence, clouds, cloudBase_ft, qnh }
  step(n = 1),      // n Physik-Substeps (1/120 s) synchron, danach GENAU EIN World-Update
                    //   (Terrain-Streaming mit Budget, Wolken, Tageszeit) + Instrumente + Render; gibt state zurück
  render(),         // synchroner Render eines Frames (für headless Tabs ohne rAF)
  setControls(obj), // Controls setzen (überschreibt Input bis zum nächsten echten Input)
  setEnv(obj),
  reset(scenarioId),// 'runway' | 'final' | 'cruise'
  pause(bool),
  instruments(),    // aktuelle Anzeigewerte der Instrumente (inkl. Verzögerung)
  perf()            // { fps, frameMs, physicsMs, drawCalls, triangles, tiles }
};
```

Die Physik (`js/sim/*`) hängt weder vom DOM noch vom Renderer ab und läuft auch unter Node für `node --test`.

## 6a. Betrieb auf Debian 13

- nginx aus den Debian-Paketquellen; ausgeliefert wird **nur** der Webinhalt (keine Tests, SPEC/PLAN, `.git`).
- Release-Struktur: `/var/www/c172/releases/<release-id>/` + Symlink `/var/www/c172/current`. Neues Release vollständig hochladen und prüfen, dann Symlink atomar umschalten; das vorherige Release bleibt für den **Rollback** (Symlink zurück) erhalten. Das Ansible-Playbook bildet genau das ab.
- Caching: HTML immer revalidieren (`no-cache`); JS/CSS ebenfalls revalidieren (ETag), da nicht inhaltsadressiert; `immutable` nur für den versionierten `vendor/three/`-Pfad.
- Korrekte MIME-Typen (`.js`/`.mjs` → `text/javascript`), gzip für Text, fehlende Dateien liefern **404** (keine SPA-Fallback-Seite), Webroot für nginx nur lesend.
- HTTPS: über vorhandenen Reverse-Proxy oder nginx + certbot — konkret erst, wenn Domain/Infrastruktur bekannt sind; die Konfiguration enthält beide Varianten als dokumentierte Option.

## 7. Out of Scope (v1)
Folgendes gehört nicht zu Version 1:
- Floating Origin (erst jenseits von 200 km relevant)
- Multiplayer, ATC, Navigation (VOR/GPS), Autopilot
- Gemischregelung und Vergaservereisung
- Kraftstoffverbrauch
- Echte Geodaten
- Replays
- VR
- Joystick/Gamepad (die Gamepad API ist vorbereitet, aber nicht spezifiziert)

## 8. Akzeptanzkriterien

Alle Kriterien werden über `window.SIM` (Browser) bzw. `node --test` (Physik) geprüft. Wo nichts anderes steht, gelten Standardwerte ohne Wind: Masse 1000 kg, ISA, Turbulenz 0.

**Flugphysik** (sofern nicht anders angegeben gilt: 1089 kg, ISA, kein Wind, Turbulenz 0)

AK-01 bis AK-04 und AK-07 sind **Plausibilitätstests des Simulators**. Sie orientieren sich am POH, sind aber keine zertifizierten POH-Nachflüge.

1. **AK-01 Startlauf:** `runway` (Platz 1476 ft), Klappen 0, Vollgas bei gesetzter Bremse, dann Bremse lösen und bei 55 KIAS weich rotieren. Abheben bei 52–62 KIAS nach 250–420 m Rollstrecke.
2. **AK-02 Standdrehzahl:** Vollgas im Stand mit gesetzter Bremse ergibt nach 5 s 2300–2420 RPM.
3. **AK-03 Steigflug:** Vollgas, Klappen 0, 76 KIAS, Messfenster 2300–2700 ft Druckhöhe. Die Steigrate liegt bei 520–700 ft/min (POH ≈ 600).
4. **AK-04 Reiseflug:** `cruise` (4500 ft), Horizontalflug mit Gas so, dass 2400 RPM anliegen. Die TAS stabilisiert sich bei 100–115 kt.
5. **AK-05 Stall clean:** Leerlauf, Klappen 0, Fahrtabbau mit ~1 kt/s. `stalled` wird bei **47–54 KCAS** true, die Anzeige liegt laut Kalibriertabelle bei ≈ 42–47 KIAS. Das Stall-Horn ertönt 5–10 kt vorher.
6. **AK-06 Stall mit Klappen 30:** Wie AK-05, `stalled` bei **42–49 KCAS** (Anzeige ≈ 30–38 KIAS).
7. **AK-07 Gleitflug:** Leerlauf, 65 KIAS, Klappen 0. Die Gleitzahl (Horizontaldistanz/Höhenverlust über 60 s) liegt bei 8–10.
8. **AK-08 Trimmstabilität:** `cruise`, Yoke neutral, Turbulenz 0. Nach 60 s hands-off liegt die Höhe innerhalb von ±150 ft und der Kurs innerhalb von ±10°. Die Höhenamplitude der Phygoide wächst nicht: Das Maximum im zweiten 30-s-Fenster ist ≤ dem Maximum im ersten.
9. **AK-09 Rollrate:** 105 KIAS, voller Querruderausschlag. Die Rollrate liegt bei 30–60°/s, das negative Wendemoment ist messbar (β > 0,5° in Gegenrichtung).
10. **AK-10 Propellereffekte:** Beim Startlauf mit Vollgas und Seitenruder neutral zieht die Maschine nach links (Kursdrift > 3° nach 5 s ohne Korrektur).
11. **AK-11 Klappen:** Das Ausfahren von Klappen 0→30 bei 80 KIAS erzeugt ein Nickmoment (Pitch-Änderung > 2° ohne Korrektur binnen 3 s) und senkt die Stallgeschwindigkeit wie in AK-06.
12. **AK-12 Trimmung:** Yoke bleibt 0, nur `trim` wird verändert. Es existiert ein Trimmwert, bei dem im `final`-Szenario 70 ± 3 KIAS hands-off gehalten werden. Unterschiedliche Trimmwerte ergeben unterschiedliche Gleichgewichtsfahrten (monoton).
13. **AK-13 Bodeneffekt:** Bei gleicher Konfiguration ist das Gleiten unterhalb von 5 m AGL messbar flacher (die Sinkrate ist ≥ 10 % geringer als auf 50 m AGL).
14. **AK-14 Landung:** Aufsetzen mit ≤ 300 ft/min auf der Piste ohne Crash. Mit Bremse kommt die Maschine aus 50 KIAS in ≤ 250 m zum Stehen. 30 s Stand mit Parkbremse ergeben eine Drift < 0,1 m.
15. **AK-15 Crash:**
    - Aufsetzen mit ≥ 1000 ft/min setzt `crashed=true` mit `crashReason='gear'`.
    - Aufsetzen im Wasser ergibt `'water'`.
    - Eine Flügelspitze am Boden ergibt `'structure'`.
    - 170 KIAS führen nur zu einer Warnung `'VNE'` in `warnings`, nicht zu einem Crash.
    - Das Overlay erscheint und der Neustart funktioniert.
16. **AK-16 Wind:** Bei 20 kt Wind aus 270° zeigt der IAS-Wert im Stand auf Piste 27 ≈ 20 kt (±3, oberhalb der Kalibrier-Untergrenze). Im Horizontalflug gilt GS ≈ TAS − Gegenwindkomponente (±3 kt).
17. **AK-17 Turbulenz:** Bei Turbulenz 100 % ist die Standardabweichung der Lastvielfachen > 0,1 g, bei 0 % < 0,02 g (Horizontalflug, 30 s).
18. **AK-18 Motorstart (Boden, Parkbremse gesetzt):** Nach Zündung OFF fällt die RPM binnen 10 s auf 0. Mit START (Halten) und Gas 10 % läuft der Motor binnen 3 s mit > 500 RPM. Zusatz: Im Gleitflug bei 80 KIAS mit Zündung OFF windmillt der Propeller mit > 500 RPM.

**Welt & Grafik**

19. **AK-19 Terrain-Streaming:** Beim Flug von 30 km geradeaus mit 110 kt (wiederholt `SIM.step(60)`; jeder Aufruf macht ein World-Update) bleiben keine Löcher:
    - Unter dem Flugzeug liegt jederzeit eine LOD-0-Kachel, ebenso in jede Richtung ≥ 1 km.
    - Die Zahl der Nahkacheln ist ≤ 25, dazu kommt 1 Fern-Mesh.
    - Die Heap-Größe bleibt stabil.
20. **AK-20 Konsistenz Physik/Grafik:** An 100 Zufallspunkten innerhalb von 1 km um das Flugzeug weicht `groundHeight()` um ≤ 0,05 m von der Höhe per Raycast gegen die gerenderte LOD-0-Kachel ab. Die Punkte liegen gezielt auch auf Kachelgrenzen und vor sowie nach einem Kachelwechsel. Auf der Piste beträgt die Abweichung ≤ 0,01 m.
21. **AK-21 Tageszeit:**
    - Bei 12 h liegt die Sonnenhöhe über 30°, bei 6,5 h und 18,5 h unter 10° mit orangeroter Horizontfarbe.
    - Bei 0 h sind Sterne sichtbar (`stars.material.opacity` > 0,5) und die Panelbeleuchtung ist an (Instrument-Emissive > 0).
    - Die Instrumente sind nachts ablesbar. Auf dem Screenshot unterscheidet sich die Luminanz zwischen ASI-Nadel und Zifferblatt um mindestens 40 %.
22. **AK-22 Wolken:** Bei Bewölkung 0 % gibt es 0 Wolkeninstanzen, bei 80 % mindestens 30 Wolken im Umkreis von 10 km. Innerhalb einer Wolke (`cloudDensityAt(pos)` > 0,5) sinkt die Fog-Sichtweite auf < 200 m.
23. **AK-23 Flugzeuganimation:** In der Außenansicht bewegen sich die Ruderflächen sichtbar mit den Eingaben (Rotation des jeweiligen Meshs ≠ 0 bei Eingabe ≠ 0), der Propeller zeigt ab 600 RPM die Blur-Scheibe und die Räder drehen beim Rollen.
24. **AK-24 Cockpit:** Der Yoke bewegt sich mit Nick- und Roll-Eingabe, Gas- und Klappenhebel bewegen sich mit ihren Werten. Alle klickbaren Elemente reagieren auf Pointer-Events (Gas per Drag ändert `controls.throttle`, der Klappenhebel ändert `flapsCmd`).
    **Bildabnahme** (Screenshot bei Default-FOV und 1920×1080, `runway`, 10 h):
    - Das Panel-Layout entspricht §3.7.
    - Die Six-Pack-Instrumente sind ≥ 90 px groß.
    - Horizont und Piste sind über die Motorhaube sichtbar.
    - Links sind durch das Seitenfenster Flügelunterseite und Strebe sichtbar.
    - Schatten von Glareshield bzw. Rahmen fallen sichtbar aufs Panel, und die Schattenlage ändert sich bei Kurs +90°.
25. **AK-25 Instrumente:** Im stationären Flug entsprechen die Instrumentenwerte dem Zustand:
    - ASI ±1 kt zu `ias_kt`
    - Höhenmesser ±20 ft zur QNH-Höhe
    - VSI ±50 ft/min zum geglätteten vs
    - Drehzahlmesser ±20 RPM
    - HI: unmittelbar nach dem Abgleich ±1° zum Kompasskurs, danach ≤ 3° Drift in 10 min

**UI, Sound, Input**

26. **AK-26 Tastatur:** Jede Taste aus 4.4 bewirkt die dokumentierte Änderung in `SIM.controls` bzw. in der Ansicht. Die Ruder-Rampen verhalten sich wie in 4.4 beschrieben.
27. **AK-27 Einstellungen:** Jeder Regler aus 4.3 ändert `SIM.env` bzw. die Konfiguration sofort. Die Werte bleiben nach einem Reload erhalten.
28. **AK-28 Touch:** Im Mobile-Viewport im Querformat (812×375, Touch-Emulation) ist das Touch-Layout sichtbar. Im Hochformat (375×812) erscheint der Drehhinweis. Pointer-Events auf den Stick setzen elevator/aileron ≠ 0 und nach dem Loslassen wieder 0. Der Gas-Slider setzt throttle. Kein Element erzeugt horizontales Scrollen.
29. **AK-29 Sound:** Nach der ersten Interaktion ist der AudioContext `running`. Die Motor-Oszillatorfrequenz folgt der RPM (±5 %), die Windlautstärke steigt mit der IAS, das Stall-Horn ist nur nahe am Stall aktiv.
30. **AK-30 Pause/Hintergrund:** Pause friert `SIM.state.time` ein. Beim Verstecken des Tabs pausiert die Simulation automatisch, danach springt der Zustand nicht.
31. **AK-31 Performance:** `SIM.perf()` meldet auf dem Referenz-Desktop bei Qualität Mittel ≥ 60 fps und ≤ 250 Draw Calls. Die Draw Calls werden über **beide** Render-Pässe eines Frames summiert. Die Messung erfolgt manuell bzw. im sichtbaren Browser-Tab.
32. **AK-32 Konsole & Auslieferung:** Beim Laden und in 5 min Flug entstehen keine Console-Errors oder -Warnings. Die Seite läuft unverändert hinter nginx (`deploy/nginx.conf`, gzip und korrekter MIME-Typ für `.js`).

**Qualität, Robustheit, Betrieb** (ergänzt in v1.1)

33. **AK-33 Determinismus:** Eine aufgezeichnete Eingabefolge (60 s, `runway`-Start) ergibt bei simulierten Renderintervallen von 1/30, 1/60 und 1/144 s (headless, Loop-Funktion mit künstlicher Uhr) **bit-identische** Physikzustände nach gleicher Substep-Zahl.
34. **AK-34 Render-Interpolation:** Die gerenderte Flugzeugpose liegt stets zwischen den letzten beiden Physikzuständen (α ∈ [0,1]); bei 144-Hz-Uhr zeigt die Folge der gerenderten Positionen im Geradeausflug keine Rückwärts- oder Doppelschritte (Positionsinkremente monoton, Varianz der Inkremente < 10 %).
35. **AK-35 Fokusverlust:** Taste ← halten, dann `blur`/`visibilitychange` auslösen → Simulation pausiert, `controls.aileron` ist nach Fortsetzen 0, `state.time` springt nicht.
36. **AK-36 Fehlerzustände:** Ohne WebGL2 (per Test-Flag simuliert) erscheint die Fehlermeldung statt schwarzem Canvas; ein simulierter `webglcontextlost` pausiert und zeigt den Neustart-Dialog; ein fehlschlagender Modul-Import zeigt „Erneut versuchen“.
37. **AK-37 Kopfbewegung:** Bei 100 % bleibt der Kopfversatz in allen Szenarien (inkl. harter Landung 600 ft/min, Turbulenz 100 %) ≤ 2 cm und ≤ 1°, er kehrt binnen 2 s nach Ende der Anregung auf < 1 mm zurück; bei 0 % bzw. reduced motion ist er exakt 0.
38. **AK-38 Menü-Bedienung:** Alle Menüs sind nur per Tastatur (Tab/Shift+Tab/Enter/Esc) bedienbar, Fokus bleibt im Dialog und kehrt zum Auslöser zurück; bei offenem Menü ändern Pfeiltasten `SIM.controls` nicht; Kontrast der Menütexte ≥ 4,5:1 (berechnet aus den CSS-Tokens).
39. **AK-39 Kompletter Ablauf:** Ein skriptgesteuerter Testflug (headless, einfacher Regler) fliegt `runway` → Start → Platzrunde → Endanflug → Landung → Ausrollen bis Stillstand ohne Neustart, ohne Crash und ohne Bodendurchdringung > 5 cm; drei aufeinanderfolgende Landungen gelingen.
40. **AK-40 Betrieb:** `nginx -t` mit `deploy/nginx.conf` ist fehlerfrei (Debian-13-Container oder VM); das Playbook legt Release-Verzeichnis + `current`-Symlink an; ein Rollback auf das vorige Release ist dokumentiert und praktisch geprüft; beim Seitenaufruf gibt es null Drittanbieter-Requests; eine fehlende Datei liefert 404.
41. **AK-41 Testflug-Abnahme (Mensch):** Fünf standardisierte Kurzflüge — ruhiger Geradeausflug, kleine Korrekturen, Startlauf, Stall + Abfangen, Landung — werden vom Nutzer geflogen und in `TESTFLIGHTS.md` kurz bewertet. Mängel am Fluggefühl haben Vorrang vor neuen Features.

