# Nachtschicht (Arbeitstitel) – Spielkonzept

Stand: 22.11.2026 · Status: Entwurf, noch nicht freigegeben

## 1. Idee in einem Satz

Ein Open-World-Crime-Spiel in einer kompakten, fiktiven Hafenstadt, in dem man Einbrüche nicht nur spielt, sondern mit einer Mannschaft aus Komplizen auskundschaftet, minutengenau plant und dann live durchzieht.

## 2. Abgrenzung zu den Vorbildern

Das Spiel ist eigenständig. Aus dem Genre übernommen werden Mechaniken, nicht Inhalte:

| Vorbild | Was wir als Genre-Mechanik aufgreifen | Was wir ausdrücklich nicht übernehmen |
|---|---|---|
| Open-World-Crime (Referenz: GTA-Reihe) | frei befahrbare Stadt, Third-Person, Fahrzeuge, Fahndung, Missionen plus freie Aktivitäten | Name, Figuren, Schauplatz (Florida/Miami), Look, Musik, Missionen |
| Einbruchsplanung (Referenz: Der Clou!) | Schleife auskundschaften → Mannschaft/Wagen/Werkzeug → Plan aufzeichnen → ausführen → Hehler; Komplizen mit Können und Charakter | Schauplatz London 1953, Figuren, Texte, Grafik |

**Grafik (Vorgabe 22.11.2026): fotorealistisch, Messlatte ist das aktuelle Spitzenniveau des Genres.** Der zuvor empfohlene stilisierte Look ist damit verworfen. Einordnung: Die Darstellungstechnik (Beleuchtung, Geometrie, Materialien) erreicht Unreal Engine 5 auf einem starken Windows-PC; Figurenanimation, Passantendichte und Detailmenge eines Milliardenprojekts erreicht ein kleines Team nicht. Realistisches Ziel: Standbilder nahe am Spitzenniveau, in Bewegung sichtbar darunter. Mittel: gescannte Materialien und Objekte aus der Unreal-Bibliothek, MetaHuman-Figuren, zugekaufte Bewegungsdaten. Eigene Farbstimmung und eigene Bildsprache, keine Nachahmung der Optik von GTA VI.

## 3. Schauplatz

### Costa Daurada mit Salou als Zentrum (Hauptschauplatz)

Vorgabe (22.11.2026): realer Schauplatz Salou in Katalonien, Gegenwart, mit den Nachbarorten zum Erkunden. Die Küste wird nicht maßstäblich nachgebaut, sondern verdichtet: Die rund 20 km zwischen Cambrils und Tarragona schrumpfen auf wenige Fahrminuten, die erkennbaren Orte und Blickachsen bleiben.

- **Salou** (Zentrum, am detailliertesten) – Strandpromenade, Hotelzeile, Bars und Clubs bei Nacht, Juweliere, Pfandhäuser; hier wird angeworben
- **Cap Salou** – Klippen, Buchten, Leuchtturm, abgeschirmte Villen mit Alarmanlagen der Oberklasse
- **La Pineda und Industriehafen** – Ferienanlagen, dahinter Raffinerien und Chemiewerke, nachts ein Lichtermeer; Werkstatt/Versteck, Hehler, Schrauber
- **Cambrils** – Fischerhafen, Yachthafen, Restaurants; Übergabeorte, Boote als Fluchtweg (spätere Ausbaustufe)
- **Tarragona** – römisches Amphitheater, Altstadt mit Kathedrale, Rambla, Handelshafen mit Zollfreilager; Banken, Museen, Polizeipräsidium
- **Hinterland** – Weinberge, Landstraßen, Autobahn und Bahntrasse; Fluchtrouten und Verstecke

Reihenfolge im Bau: zuerst Salou mit Cap Salou, dann La Pineda mit Industriehafen, danach Tarragona, zuletzt Cambrils.

Leitplanken für den realen Ort (meine Einordnung): Orts-, Straßen- und Landschaftsnamen sowie öffentliche Bauten von außen sind verwendbar. Hotels, Läden, Clubs, Firmen und der Freizeitpark bekommen erfundene Namen und eigenes Aussehen (Marken- und Hausrecht). Keine realen Personen. Geodaten: Straßennetz, Gebäudeumrisse und Geländehöhen gibt es nach meinem Kenntnisstand als offene Daten (OpenStreetMap, spanisches Kataster, katalanisches Kartografie-Institut); Lizenzbedingungen und Namensnennung vor der Nutzung prüfen.

### Dresden (Schlusskapitel)

Kein zweites frei befahrbares Stadtgebiet, sondern der historische Kern als dichtes Kapitel (rund 0,5 km²): Residenzschloss, Frauenkirche mit Neumarkt, Zwinger, Semperoper, Brühlsche Terrasse, Augustusbrücke und Elbufer.

Vorbild für den Schlusscoup ist der Einbruch ins Grüne Gewölbe vom 25.11.2019 – als Inspiration für den Ablauf, nicht als Nacherzählung:

- **Was wir aufgreifen**: Vorbereitung Tage vorher (Fenstergitter angesägt), Stromverteiler lahmlegen, wenige Minuten im Objekt, Fluchtwagen wechseln und vernichten. Das sind genau die Bausteine des Reißbretts.
- **Was wir erfinden**: Museum, Sammlung und Schmuckstücke („Kurfürstliche Schatzkammer“), alle Figuren, den Tathergang im Einzelnen.
- **Rechtliche Leitplanken (meine Einordnung)**: Außenansichten der Wahrzeichen sind unproblematisch – die Bauten sind urheberrechtlich längst gemeinfrei, im Übrigen deckt § 59 UrhG Ansichten von öffentlichen Wegen. Innenräume realer Museen und reale Kunstwerke nur fiktionalisiert oder mit Erlaubnis des Hausherrn. Keine realen Täter, Ermittler oder Familien, auch nicht erkennbar verfremdet (allgemeines Persönlichkeitsrecht, Art. 2 Abs. 1 i. V. m. Art. 1 Abs. 1 GG). Geschützte Namen und Logos (z. B. Opernhaus, Kunstsammlungen) nicht als Marke verwenden. Vor Veröffentlichung anwaltlich prüfen lassen.

### Leveldesign-Grundsätze

Vorgabe (22.11.2026): Das Leveldesign orientiert sich an der Bauweise großer Open-World-Crime-Spiele, insbesondere GTA VI. Übernommen werden Gestaltungsprinzipien, nicht Karte, Orte, Wahrzeichen oder Optik.

- **Viertel mit eigenem Charakter**: Jedes Viertel ist an Silhouette, Farbe, Geräuschkulisse und Passanten sofort erkennbar und hat eigene Spielregeln (Polizeidichte, Kameras, Verkehr).
- **Orientierung über Wahrzeichen**: Von fast jedem Punkt ist mindestens ein markantes Bauwerk sichtbar; man findet sich ohne Karte zurecht.
- **Straßennetz fürs Fahren gebaut**: Hauptachsen für Tempo, Nebenstraßen und Hinterhöfe zum Abschütteln, bewusst gesetzte Abkürzungen, Sprünge und Engstellen für Verfolgungsjagden.
- **Dichte statt Fläche**: lieber wenig Fläche mit vielen begehbaren Innenräumen, Dächern, Höfen und Kellern als weite leere Strecken.
- **Kontraste auf kurzer Distanz**: Reich neben Arm, Glasfassade neben Hafenschuppen, Stadt neben Wasser und Umland.
- **Lebendige Welt**: Tagesablauf, Wetter, Ereignisse am Straßenrand, Passanten mit erkennbaren Routinen – auch als Material fürs Auskundschaften.
- **Mehrere Wege ins Objekt**: Jedes Einbruchsziel hat mindestens drei Zugänge und ist von der Straße aus einsehbar. Als Zugang zählt alles, was baulich plausibel ist: Türen, Fenster, Dach und Dachluken, Balkone, Keller und Lichtschächte, Lieferzugang, Garage, Nachbargebäude. Jeder Zugang hat eigene Anforderungen an Werkzeug, Können, Lärm und Zeit.

## 4. Kernschleife

1. **Tipp** – aus Kneipengesprächen, vom Hehler, aus der Story oder selbst entdeckt.
2. **Auskundschaften** in der offenen Welt: beobachten, fotografieren, Wachrunden mitstoppen, als Handwerker hineingehen, Baupläne besorgen. Alles Gesehene landet auf dem Grundriss; Ungesehenes bleibt Nebel.
3. **Mannschaft und Material**: Komplizen anwerben, Werkzeug kaufen oder bauen, Fluchtwagen besorgen (kaufen, leihen, stehlen).
4. **Planen** am Reißbrett im Versteck (siehe 5).
5. **Durchziehen** live in der Stadt: Der Spieler steuert eine Figur selbst, die anderen folgen dem Plan.
6. **Flucht** durch die offene Stadt, Fahndung abschütteln.
7. **Verwerten**: Beute zum passenden Hehler, Anteile auszahlen, Spuren kühlen lassen.

## 5. Das Reißbrett (Alleinstellungsmerkmal)

- Grundriss von oben, darunter eine **Zeitleiste mit einer Spur je Komplize**.
- Aktionen werden als Blöcke gesetzt: gehen, Schloss öffnen, Alarm überbrücken, Schmiere stehen, tragen, Wagen vorfahren. Die Dauer ergibt sich aus Können und Werkzeug.
- **Synchronpunkte** („erst wenn Jule den Strom gekappt hat“) verbinden die Spuren.
- **Probelauf**: Der Plan läuft als Geisterbild ab, vor- und zurückspulbar. Bekannte Wachrunden laufen mit; Unbekanntes kann der Probelauf nicht zeigen.
- **Plan B**: Für kritische Stellen lassen sich Ausweichzweige hinterlegen (Rückzug, anderer Ausgang).
- **Bei Abweichung** im Ernstfall entscheidet der Charakter des Komplizen: Nervenstarke improvisieren, Nervöse brechen ab oder machen Lärm, Gierige greifen nach zusätzlicher Beute und sprengen den Zeitplan.

## 6. Komplizen

Können: Schlösser, Elektronik, Fahren, Kraft, Klettern. Charakter: Loyalität, Gier, Nerven. Dazu Beuteanteil, eigene Vorgeschichte und kleine Loyalitätsaufträge. Erfahrung steigt mit jedem gelungenen Coup. Wer schlecht behandelt, knapp bezahlt oder zurückgelassen wird, redet bei einer Festnahme – oder verrät die Mannschaft (Story-Wendepunkt, siehe 9).

## 7. Offene Welt und Fahndung

- Third-Person zu Fuß und im Fahrzeug, Verkehr und Passanten als Simulation in reduzierter Dichte.
- **Die Akte** statt reiner Fahndungssterne: Jede Spur (Fingerabdruck, Kamera, Zeuge, wiedererkannter Wagen, geschwätziger Komplize) füllt die Ermittlungsakte der Inspectora. Akute Verfolgung klingt ab, die Akte nicht. Sie lässt sich nur aufwendig drücken (Wagen umlackieren, Zeugen, Beute liegen lassen, Stadtteil meiden).
- Gewalt ist möglich, aber teuer: Schüsse und Verletzte treiben die Akte steil nach oben. Das Spiel belohnt den sauberen Bruch.
- Wirtschaft: Beute, Hehlerpreise je Warengruppe, Anteile, Werkstattausbau, Fahrzeuge, Tarngeschäft.
- Nebenaktivitäten (klein gehalten): Kurierfahrten, Autodiebstahl auf Bestellung, Gelegenheitsbrüche, Komplizenaufträge.

## 8. Bewusst nicht enthalten (erste Fassung)

Online-Modus, Flugzeuge/Boote, mehrere spielbare Hauptfiguren, große Landschaft außerhalb der Stadt, voll vertonte Passantengespräche, Deckungsshooter-Tiefe.

## 9. Geschichte

**Mara Voss**, 34, aus Dresden, hat für die Südeuropa-Tochter des Dresdner Sicherheitskonzerns **Securion** Alarmanlagen in halb Salou und Tarragona eingebaut. Nach einer Einbruchserie bei Securion-Kunden hängt man ihr die „fehlerhaften Installationen“ an: fristlos entlassen, Regressforderung, Schulden.

**Akt 1 – Kleine Fische.** In der Kneipe „El Último Turno“ in Salou trifft Mara **Jupp Kowalke**, 68, Tresorknacker alter Schule, frisch entlassen. Er plant mit Bleistift auf Butterbrotpapier; sie kennt jede Anlage der Stadt. Kiosk, Pfandhaus, erste Villa – das Spiel lehrt Auskundschaften, Reißbrett und Flucht. Die offene Welt öffnet sich Viertel für Viertel.

**Akt 2 – Die Mannschaft.** Werkstatt hinter dem Industriehafen von La Pineda, vier bis sechs Komplizen, größere Objekte. Inspectora **Núria Ferrer** von der katalanischen Polizei legt die Akte „Nachtschicht“ an. In den Securion-Anlagen findet Mara ein Muster: Die Einbruchserie, die ihr angehängt wurde, war ein Insider-Geschäft. Securion-Vorstand **Henrik Lassen** verkauft Lagepläne und Wartungsfenster an einen eigenen Einbrecherring, kassiert bei den Versicherern mit und lagert die Beute im Zollfreilager im Hafen von Tarragona. Maras Mannschaft kommt diesem Ring in die Quere.

**Akt 3 – Der große Wurf.** Lassen kauft sich einen von Maras Leuten. Wer das ist, entscheidet das Spiel: der Komplize mit der niedrigsten Loyalität. Ein Coup platzt, Jupp wird gefasst. Im Zollfreilager des Hafens von Tarragona findet Mara statt der Beute nur Lassens nächsten Plan: Securion sichert in Dresden, dem Konzernsitz, die „Kurfürstliche Schatzkammer“ – und Lassens Ring will sie mit den eigenen Wartungsfenstern ausräumen. Die Mannschaft reist nach Dresden. Finale ist der Bruch in die Schatzkammer, eine Nacht vor Lassens Leuten – der längste Plan des Spiels, alle Systeme zusammen.

**Enden** (abhängig von Akte, Loyalität und Entscheidung im Tresorraum): mit der Beute verschwinden · Ferrer die Beweise gegen Lassen zuspielen und Jupp freibekommen · Lassens Ring übernehmen.

So greifen beide Hälften ineinander: Die offene Welt liefert Tipps, Auskundschaften, Flucht und Konsequenzen; das Reißbrett ist der Ort, an dem die Geschichte ihre Entscheidungen fällt.

## 10. Technik

- **Engine: Unreal Engine 5.8**, C++-zentriert, Blueprints nur für Daten und Feinschliff (Textdateien sind für KI-gestütztes Entwickeln und Reviews deutlich besser als binäre Blueprints). Gründe: World Partition, Verkehrs-/Passantensimulation, Fahrzeugphysik und prozedurale Stadtwerkzeuge sind vorhanden; Windows und macOS werden offiziell unterstützt; bis 1 Mio. USD Umsatz lizenzkostenfrei.
- **Plattformen**: Windows zuerst (DX12), macOS/Apple Silicon (Metal) als zweite Stufe. Mac-Build ab dem ersten Monat mitkompilieren, sonst wird der Port teuer. Laut Epic-Dokumentation ist auf Apple Silicon Nanite erst ab M2 und nur als Beta verfügbar, Lumen mit Software-Raytracing ab M1, mit Hardware-Raytracing nur experimentell. Folge: Die höchste Grafikstufe gibt es nur unter Windows; die Mac-Fassung läuft mit reduzierter Stufe. Entwickelt und im Alltag getestet wird auf dem Mac (MacBook Pro M3 Max, 48 GB), Windows-Builds und Grafikabnahme laufen auf einem gemieteten Windows-Rechner mit Grafikkarte oder einem eigenen Spiele-PC. Zu klären: Installiert ist Xcode 27.2, Epic nennt für 5.8 Xcode 26.0 bis 26.1.1.
- **Risiko UE6**: Early Access laut Ankündigung Ende 2027. Auf 5.8 bleiben, Umstieg erst nach Veröffentlichung bewerten.
- **Zwischensequenzen**: vorgerenderte Videos mit Black Forest Labs. Ablauf: Figurenblätter und Schlüsselbilder (FLUX-Bildmodell) → Bild-zu-Video (FLUX 3 Video) → Schnitt, Ton, Sprache → Abspielen im Spiel. Ein Clip ist höchstens 20 Sekunden lang, Sequenzen entstehen also im Schnitt aus vielen Einstellungen. Bei fotorealistischem Spielbild fallen Unterschiede zwischen KI-Video und Spielfiguren stärker auf; die Schlüsselbilder werden deshalb aus Aufnahmen der Spielfiguren in der Engine abgeleitet. Die Entwicklerbedingungen erlauben kommerzielle Nutzung der Ergebnisse; die EU-Fassung ist noch nicht gelesen, und Figuren dürfen keinen realen Personen ähneln (Einwilligungspflicht). Erzeugte Videos sofort herunterladen und selbst archivieren, der Anbieter speichert sie nicht dauerhaft.
- **Figurenanimation** (Entscheidung 22.11.2026, sichtbare Lücke zum Spitzenniveau ist akzeptiert): Grundbewegungen aus Epics „Game Animation Sample Project“; spezielle Bewegungen per Bewegungserfassung aus Video in Unreal 5.8 (nur Windows, experimentell); Gesicht und Lippen mit MetaHuman Animator (iPhone-Aufnahme, Aufbereitung unter Windows); Nachbessern in Cascadeur. Ausweichwege: Move.ai, Web-Dienste, Sensoranzug. Offen: Lizenz der Videoerfassung für verkaufte Spiele.
- **Offene KI-Modelle**: Vor jedem Abschnitt prüfen, ob es brauchbare offene Modelle gibt (Bewegung aus Text wie Tencent HY-Motion, 3D-Modelle, Texturen, Sprache, Lippensynchronität). Aufnahme nur nach Qualitätsprobe und gelesenem Lizenztext; „offen“ heißt nicht automatisch kommerziell nutzbar.
- **Steam**: KI-erzeugte Inhalte im ausgelieferten Spiel müssen offengelegt werden.

## 11. Aufwand

Siehe [aufwand.md](aufwand.md).
