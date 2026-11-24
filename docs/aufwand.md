# Nachtschicht – Aufwandsschätzung

Stand: 22.11.2026 · Grobschätzung (Genauigkeit etwa ±50 %), keine Kalkulation

## Vorab: der Maßstab

Ein Spiel „genau wie GTA 6“ ist nicht erreichbar. Analysten schätzen dessen Kosten auf über 1 Mrd. USD (nicht offiziell bestätigt), bei mehreren tausend Beteiligten und rund sechs Jahren Hauptproduktion. Schon der Vorgänger lag bei über 1.000 Mitarbeitern. Realistisch ist ein Spiel im selben Genre mit bewusst kleinem Zuschnitt und einem eigenen Schwerpunkt – der Einbruchsplanung.

## Vier Ausbaustufen

| Stufe | Inhalt | Team | Dauer | Personenaufwand | Kosten (grob) |
|---|---|---|---|---|---|
| **A – Spielbarer Prototyp** | ein Häuserblock als Graubox, 3 Einbruchsziele, Reißbrett mit Probelauf, 3 Komplizen, 1 Fahrzeug, einfache Polizei, 2–3 Min. KI-Video | 1–2 Personen + KI-Agenten | 4–6 Monate | 6–9 Personenmonate | 60–120 T€ (bei Eigenleistung nur 5–15 T€ Fremdkosten) |
| **B – Veröffentlichbares Spiel (Early Access)** | Costa Daurada verdichtet (Salou, Cap Salou, La Pineda, Tarragona, Cambrils; zusammen 4–6 km² bebaute Spielfläche) plus Dresdner Altstadtkern, fotorealistisch, 12–15 Ziele, 8–10 Std. Geschichte, 6–8 Komplizen, 10–15 Fahrzeuge, Verkehr und Passanten, Akte-System, 20–30 Min. KI-Video, Vertonung | 10–15 Personen | 3 Jahre | 30–45 Personenjahre | 3,5–8 Mio. € |
| **C – Mittelgroße Produktion** | große Stadt, 25+ Std. Geschichte, volle Vertonung, Motion Capture, Konsolen | 40–80 Personen | 3–4 Jahre | 150–300 Personenjahre | 15–40 Mio. € |
| **D – GTA-6-Niveau** | – | tausende | 6+ Jahre | – | über 1 Mrd. USD, nicht planbar |

**Änderung 22.11.2026**: Stufe B wurde nach den Vorgaben „fotorealistische Grafik auf Spitzenniveau“ und „zweiter Schauplatz Dresden“ und „Salou mit Nachbarorten“ neu geschätzt (vorher 1–2,5 Mio. € mit stilisiertem Look und einer Stadt). Treiber sind Figuren, Animation und die Detailmenge je Quadratmeter. Wie viel davon KI-Agenten statt Menschen leisten können, zeigt erst Stufe A.

**Mac-Version**: bei Stufe B etwa 3–5 Personenmonate zusätzlich (Build-Pipeline, Leistungsoptimierung für Apple Silicon, Test), sofern der Mac-Build von Anfang an mitläuft. Nachträglich portiert eher das Doppelte.

## Was KI-Unterstützung spart – und was nicht

| Bereich | Wirkung |
|---|---|
| Spiellogik, Werkzeuge, Datenstrukturen, Tests (C++) | groß; hier ist Stufe A mit sehr kleinem Team überhaupt erst möglich |
| Zwischensequenzen | groß; ersetzt Animationsstudio und Motion Capture |
| Texte, Dialoge, Konzeptbilder, Texturen | mittel bis groß |
| 3D-Modelle, Figurenanimation, Fahrzeuge | gering bis mittel; Zukauf im Marktplatz bleibt nötig |
| Leveldesign, Spielgefühl (Fahren, Kamera), Balancing, Spieltests | gering; das bleibt Handarbeit und bestimmt die Qualität |
| Leistungsoptimierung offene Welt, Mac | gering |

## Kosten der KI-Zwischensequenzen

Listenpreis FLUX 3 Video (bfl.ai/pricing, am 22.11.2026 gegengeprüft): 0,15 USD/s (HD), 0,24 (Full HD), 0,28 (2K), 0,41 (4K); Entwurfsmodus 0,06 USD/s; Ton inklusive; höchstens 20 Sekunden je Clip.

- 30 Minuten fertiges Material = 1.800 s → 270–740 USD reiner Endschnitt.
- Realistisch 10- bis 20-facher Ausschuss → **3.000–15.000 USD** Erzeugungskosten.
- Der eigentliche Aufwand ist Arbeit: Figurenkonsistenz über viele Clips, Schnitt, Sprache, Lippensynchronität. Ansatz: 2–4 Personenmonate für Stufe B.

## Größte Aufwandstreiber (in dieser Reihenfolge)

1. Stadt mit begehbaren Innenräumen der Einbruchsziele
2. Verkehrs- und Passantensimulation
3. Komplizen-KI, die Pläne glaubwürdig ausführt und bei Störungen sinnvoll reagiert
4. Fahrgefühl und Verfolgungsjagden
5. Akte-/Fahndungssystem (viele gekoppelte Systeme, schwer zu testen)
6. Leistung auf dem Mac

## Größte Risiken

- **Umfang**: Offene Welten wachsen unkontrolliert. Gegenmittel: 2 km² als harte Grenze, Liste „bewusst nicht enthalten“ im Konzept.
- **Spielspaß des Reißbretts** ist unbewiesen. Deshalb zuerst Stufe A.
- **Stilbruch** zwischen KI-Video und Spielbild; Figuren sehen von Clip zu Clip anders aus.
- **Rechte**: Die Entwicklerbedingungen von Black Forest Labs erlauben kommerzielle Nutzung der Ergebnisse; die für EU-Kunden geltende Fassung ist noch nicht gelesen, und der Fall „eingebettet in ein verkauftes Spiel“ ist nicht ausdrücklich geregelt. Vor Stufe B klären.
- **Engine-Wechsel**: Unreal Engine 6 ist angekündigt (Early Access Ende 2027).

## Empfehlung

Stufe A als Auftrag mit festem Abbruchkriterium: Nach etwa fünf Monaten muss ein fremder Tester einen Einbruch auskundschaften, planen, durchziehen und flüchten können und es noch einmal spielen wollen. Erst dann über Stufe B entscheiden. Innerhalb von A zuerst das Reißbrett (4–6 Wochen), weil es das Einzige ist, was dieses Spiel von allen anderen unterscheidet.
