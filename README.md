# NACHTSCHICHT

**Nachtschicht** ist ein 3D-Open-World-Crime- & Einbruchsplanungs-Webspiel (*GTA trifft Der Clou!*), angesiedelt in **Salou / Costa Daurada** mit großem Finale in der fiktiven **Kurfürstlichen Schatzkammer Dresden**.

## Kernschleife

1. **Versteck („Werkstatt La Pineda“):** Ziele wählen, Mannschaft rekrutieren (Mara Voss, Jupp Kowalke, Jule Brandt, Toni Ferrer-Vidal, Rico Mendoza), Werkzeug ausrüsten, Werkstatt aufrüsten und **Die Akte „Nachtschicht“** von Inspectora Núria Ferrer im Blick behalten.
2. **Auskundschaften (3D):** Viertel zu Fuß und mit Fernglas erkunden, Schlösser/Kameras/Stromverteiler/Tresore scannen und Wachrunden mitstoppen. Ungesehenes bleibt Nebel.
3. **Das Reißbrett:** Grundriss von oben mit Etagenwechsel (Keller/EG/OG/Dach) + Mehrspur-Zeitleiste (eine Spur pro Komplize), **Synchronpunkte** zwischen Spuren, **Plan-B-Ausweichzweige** und vor-/zurückspulbarer **Geister-Probelauf**.
4. **Durchziehen (3D Live):** Mara live steuern, während die Mannschaft den Plan umsetzt — inklusive Charakter-Abweichungen (Gier, Nervenstärke), verborgener Sensoren und Live-Funkbefehlen (`Warten`, `Plan B`, `Abbruch`).
5. **Flucht & Verwertung:** Fluchtfahrt durch die nächtlichen Straßen Richtung La Pineda, Beute beim passenden Hehler absetzen, Anteile auszahlen und neue Spuren in **Die Akte** verarbeiten.

## Entwicklung

```bash
npm install
npm run dev       # Lokaler Vite-Dev-Server
npm test          # Vitest-Simulationstests (src/sim/__tests__/)
npm run typecheck # TypeScript Strict Check
npm run build     # Produktions-Build nach dist/
```

## Konzept & Dokumentation

- [Spielkonzept](docs/konzept.md)
- [Aufwandsschätzung](docs/aufwand.md)
- [Recherche](docs/recherche/2026-11-22-recherche.md)
