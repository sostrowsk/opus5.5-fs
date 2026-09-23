# Testflug-Abnahme (AK-41)

Fünf standardisierte Kurzflüge, vom Nutzer geflogen und kurz bewertet. **Mängel am Fluggefühl haben Vorrang vor
neuen Features.** Standard: Qualität „Mittel“, Default-Einstellungen (Masse 1000 kg, Wind 8 kt aus 240°,
Böigkeit 20 %), Tastatur oder Maus-Yoke; Eingabegerät bitte notieren.

Bewertung je Kriterium: ++ überzeugt · + in Ordnung · o auffällig · − stört (mit Stichwort, was nicht passt).

| # | Flug | Ablauf | Worauf achten |
|---|---|---|---|
| 1 | Ruhiger Geradeausflug | `Reiseflug`, 2 min Kurs 270 halten, einmal nachtrimmen (T/G) | Schwimmt leicht in Böen, lässt sich austrimmen, fliegt danach ohne Eingabe geradeaus; Instrumente ruhig und plausibel |
| 2 | Kleine Korrekturen | `Reiseflug`, 3 Kurswechsel ±20°, 1 Höhenwechsel ±500 ft | Rollen/Nicken fein dosierbar, negatives Wendemoment spürbar, Kugel des Wendezeigers reagiert, keine digitalen Sprünge |
| 3 | Startlauf | `Startbereit Piste 27`: Parkbremse lösen (Shift+B), Vollgas, bei ≈ 55 KIAS rotieren | Linksdrall (Seitenruder nötig), Bugradlenkung, Abheben 52–62 KIAS, Steigflug ≈ 600 ft/min bei 76 KIAS; Motor-/Reifenklang |
| 4 | Stall + Abfangen | `Reiseflug`, Leerlauf, Fahrt mit ≈ 1 kt/s abbauen bis zum Abriss, dann nachlassen + Gas | Stall-Horn 5–10 kt vorher, Buffet/Abkippen ohne „Kippschalter“, Abfangen mit Höhenverlust < 300 ft |
| 5 | Landung | `Endanflug Piste 27`: PAPI halten, Klappen 30, abfangen, ausrollen, bremsen | Energie/Gleitweg plausibel, Bodeneffekt beim Abfangen, Aufsetzen weich, Bremsweg ≤ 250 m aus 50 KIAS |

## Protokoll

| Datum | Flug | Eingabe | Fluggefühl | Cockpit/Sicht | Klang | Mängel / Notizen |
|---|---|---|---|---|---|---|
| | 1 Geradeausflug | | | | | |
| | 2 Korrekturen | | | | | |
| | 3 Startlauf | | | | | |
| | 4 Stall | | | | | |
| | 5 Landung | | | | | |

Automatisch geprüfte Gegenstücke: `node --test tests/` (AK-01 … AK-18, AK-33/34/37/39); Messwerte mit
`AK_REPORT=1 node --test tests/`.
