# Recherche – zusammengeführt und geprüft

Stand: 22.11.2026. Drei Recherche-Agenten (Haiku) per Websuche, danach eine unabhängige Gegenprüfung der entscheidungsrelevanten Technikpunkte an den Originalseiten. Kennzeichnung: **geprüft** = an der Originalseite gegengelesen · **Presse** = mehrere Berichte, keine Primärquelle · **offen** = nicht belegt.

## 1. Open-World-Crime: Aufbau am Beispiel GTA VI

| Punkt | Befund | Status |
|---|---|---|
| Veröffentlichung | 19.11.2026 für PS5 und Xbox Series; keine PC-Version zum Start, PC-Termin unbestätigt | Presse |
| Engine | hauseigene RAGE-Engine, nicht lizenzierbar | Presse |
| Kosten | Schätzungen über 1 Mrd. USD, nicht offiziell | Presse, widersprüchlich |
| Entwicklungsdauer | Hauptproduktion ab etwa 2020 | Wikipedia ohne Primärquelle |
| Welt | fiktiver Bundesstaat mit Großstadt und mehreren Regionen | Presse |
| Hauptfiguren | zwei Protagonisten als Paar | Presse |
| Fahndung | Sterne plus länger wirkendes Gedächtnis der Polizei (Beschreibung, Kleidung, Fahrzeug, Kameras) | Presse, Details widersprüchlich |
| Kampf | Third-Person-Shooter, begrenzte Waffenzahl | Tests |
| Simulation | sehr dichte Passanten- und Verkehrssimulation, größter Lobpunkt | Tests |
| Missionen | viele Raubüberfälle; Planungsanteil des Spielers nicht belegt | offen |
| Wirtschaft, Immobilien, Online | nicht belastbar belegt | offen |
| Vorgänger GTA V | über 1.000 Mitarbeiter, ca. 265 Mio. USD inkl. Marketing; Raubzüge mit wählbaren KI-Komplizen und Vorbereitungsmissionen | Wikipedia |

**Folgerung für uns**: Die teuersten Systeme sind Simulation der Stadt, begehbare Welt und gekoppelte Fahndung. Genau dort muss ein kleines Team kürzen (kleine Fläche, reduzierte Dichte). Das „Gedächtnis der Polizei“ ist die interessanteste Genre-Entwicklung und passt zur Einbruchsthematik – bei uns als eigene Mechanik „Die Akte“.

## 2. Der Clou! (1994) und Der Clou! 2 (2001)

| Punkt | Befund | Status |
|---|---|---|
| Aufbau | zwei Modi: Stadt/Adventure und Planung von oben | Wikipedia |
| Schleife | auskundschaften → Komplizen, Wagen, Werkzeug → planen → ausführen → Hehler | Wikipedia |
| Hehler | drei, je mit bevorzugten Warengruppen | Wikipedia |
| Komplizen | Können (Fahren, Schlösser, Elektronik) bestimmt Dauer; Charakter (Geschick, Loyalität, Gier, Nerven) bestimmt Anteil, Spuren und Verrat; Erfahrung steigt | Wikipedia |
| Anwerbung | in Kneipen | Wikipedia |
| Werkzeug | Mindestkönnen je Werkzeug, unterschiedlicher Lärm, begrenzte Tragezahl | Wikipedia, Test zum Nachfolger |
| Planung | Ablauf wird aufgezeichnet und ist zurückspulbar („Videorekorder“) | Test zum Nachfolger |
| Zeitachse, Abstimmung mehrerer Figuren, Verhalten bei Abweichung | nicht belegt; Handbuch war nicht abrufbar | offen |
| Inspektor, Alarm, Wachen im Original | nur Erwähnungen | offen |
| Nachfolger | 3D, frei begehbare Stadt; gelobt für Atmosphäre, kritisiert für Tempo, Wegfindung, Grafikfehler | Wikipedia |
| Moderne Vergleichstitel | nicht recherchiert | offen |

**Folgerung für uns**: Die Kernschleife und das Komplizenmodell sind gut belegt und tragen. Die genaue Planungsmechanik entwerfen wir neu (Zeitleiste je Komplize, Synchronpunkte, Probelauf, Plan B). Die Schwächen des 3D-Nachfolgers – langsam, schwache Wegfindung – sind genau unsere größten Risiken.

## 3. Technik

| Punkt | Befund | Status |
|---|---|---|
| Unreal Engine 5.8 | existiert; Epic-Dokumentation trägt bereits den Titel „5.9“, aktuelle Version daher vor Projektstart prüfen | geprüft, mit Widerspruch |
| Unreal auf Mac | Nanite ab M2 (Beta); Lumen Software-Raytracing ab M1; Hardware-Raytracing ab M2 (experimentell); Xcode 26.4 unverträglich mit 5.8 | geprüft |
| Unreal-Lizenz | 5 % ab 1 Mio. USD Umsatz je Produkt | Drittquelle, Vertragstext nicht gelesen |
| Unreal Engine 6 | angekündigt, Early Access Ende 2027 | Presse |
| Unity 6 | Laufzeitgebühr abgeschafft; kostenlos bis 200.000 USD, danach ca. 2.300 USD je Platz und Jahr | Herstellerseite laut Agent |
| Godot 4.7 | kostenlos (MIT), aber ohne fertige Bausteine für Stadt, Verkehr, Fahrzeuge | Herstellerseite laut Agent |
| Black Forest Labs Video | FLUX 3 Video: 0,15–0,41 USD/s je nach Auflösung, Entwurf 0,06 USD/s, bis 20 s je Clip, Ton inklusive | geprüft |
| Nutzungsrechte | „You and your End Users may use Outputs for your or their own personal or commercial purposes“; Einwilligung bei erkennbaren Personen; keine dauerhafte Speicherung der Videos; EU-Fassung der Entwicklerbedingungen nicht gelesen | teilweise geprüft |
| Figurenkonsistenz | innerhalb einer Erzeugung über mehrere Einstellungen; über getrennte Clips nicht belegt | offen |
| Steam | KI-erzeugte Inhalte im ausgelieferten Spiel sind offenzulegen, reine Programmierhilfe nicht | Steamworks laut Agent |

**Engine-Entscheidung**: Unreal Engine 5.8. Godot wäre für KI-gestütztes Programmieren angenehmer, aber Stadt, Verkehr und Fahrzeuge müssten vollständig selbst gebaut werden. Unity ist die Rückfalloption.

## 4. Korrekturen aus der Gegenprüfung

- Der erste Agent hielt die Nutzungsrechte für unbelegt; die Entwicklerbedingungen erlauben kommerzielle Nutzung ausdrücklich (Rest offen, siehe oben).
- Lumen auf Mac war als „unsicher“ gemeldet; die Epic-Dokumentation regelt es eindeutig.
- Eine abweichende Preisangabe eines Vergleichsportals (0,85 USD je Video) ist verworfen; maßgeblich ist die Herstellerseite.

## 5. Noch offen

1. EU-Fassung der BFL-Entwicklerbedingungen und Unreal-Lizenzvertrag im Wortlaut
2. Probe: dieselbe Figur in zehn getrennten Clips – wie stabil bleibt sie?
3. Handbuch von Der Clou! für Details der Planungsmechanik (nur zur Inspiration)
4. Vergleich moderner Planungsspiele (Teardown, Payday, Monaco)
5. Altersfreigabe (USK) und Markenprüfung für den endgültigen Titel
