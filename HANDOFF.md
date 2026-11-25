# LexDICOM — Multi-Machine Engineering Handoff (`HANDOFF.md`)

## 1. Overview & Repository Identity
- **Application:** `LexDICOM` — RadiAnt-Style Medicolegal DICOM Workstation & Courtroom Exhibit Studio
- **Local Path:** `C:\Users\mohal\Documents\antigravity\LexDICOM`
- **GitHub Remote:** `https://github.com/alexmohit825/LexDICOM` (`main` branch)
- **Originating Thread:** `[LexDICOM]` (`2d1bdb9e-d1f3-42e8-94f0-fb72fc5b557f` inside `joyful-hawking` on `Mobile1`, following discovery in archived thread `0f579140-07c7-4aad-b277-8b2a317c1f41`)
- **Tech Stack:** Vite 6 + React 18 + TypeScript 5.6 + `dicom-parser` + `jpeg-lossless-decoder-js` + `@cornerstonejs/core` / `@cornerstonejs/dicom-image-loader` + Offline Desktop PWA (`manifest.webmanifest` + `sw.js`).
- **Privacy Architecture:** 100% client-side local execution. Zero network uploads, zero external AI API keys required.

## 2. Architectural Map & Key Files
- `src/types/dicom.ts` — Strict TypeScript interfaces for Studies, Series, Slices, Mouse Button Bindings, Viewport State, Annotations, Exhibit Config, and SRS–Schwab Landmarks.
- `src/engine/folderScanner.ts` — Lazy `128 KB` header-only recursive folder crawler (`showDirectoryPicker`, drag-and-drop directory reader looping all 100-item batches, and `<input webkitdirectory>`), extensionless binary `DICM` sniffing, non-DICOM CD junk rejection, 3D slice normal sorting, and chronological study ordering.
- `src/engine/dicomDecoder.ts` — `256 MB` LRU slice cache + multi-syntax decoder: Explicit/Implicit VR LE/BE, JPEG Lossless Process 14 (`1.2.840.10008.1.2.4.70`/`.57`), DICOM PS3.5 Annex G RLE Lossless (`1.2.840.10008.1.2.5`), JPEG Baseline, and Cornerstone3D WASM fallback for JPEG 2000 / JPEG-LS.
- `src/engine/scoutGeometry.ts` — 3D DICOM Patient Coordinate System (`ImagePositionPatient` / `ImageOrientationPatient`) plane-plane intersection for yellow Sagittal ↔ Axial Scout Cross-Reference Lines + longitudinal slice sync.
- `src/engine/mprEngine.ts` — Volumetric 3-plane Orthogonal MPR (`Axial` / `Sagittal` / `Coronal`) with anisotropic physical Z-aspect correction.
- `src/engine/schwabMath.ts` — Deterministic geometric solver (`PI`, `PT`, `SS`, `LL`, `TK`, `PI–LL`, `PJK`, SRS–Schwab modifiers) + strict plain-film `SVA (mm)` calibration gate.
- `src/engine/exhibitExporter.ts` — Shared interactive + 4K High-DPI offscreen canvas renderer (`PNG` / `JPEG`) with 1-click PHI redaction, courtroom banners, vector callout arrows, and spinal level stamps.
- `src/engine/sampleCaseGenerator.ts` — Generates standards-compliant binary DICOM Part-10 files (`2022` Pre-Incident vs. `2024` Post-MVC Lumbar MRI Sagittal/Axial + Standing Lateral Spine X-Ray with `25.0 mm` calibration sphere) for instant verification.
- `src/components/` — `TopToolbar.tsx`, `SeriesRail.tsx`, `ViewportPanel.tsx`, `SrsSchwabDrawer.tsx`, `MprModal.tsx`.
- `scripts/preflight.mjs` — Hard Anti-Leap CI gate (`npm run test:preflight`).

## 3. Completed Milestones (V1.0)
- [x] Chaotic legal-firm recursive folder ingestion & chronological Patient → Study Date → Modality/Series rail.
- [x] RadiAnt-style compact toolbar, Left/Middle/Right mouse-button tool bindings (`L`/`M`/`R` badges), per-panel header tabs (`Tab` maximize cycle), timepoint sync, scout reference lines, and 2D Orthogonal MPR.
- [x] Court & Deposition Exhibit Mode (1-click PHI scrubber, custom case/panel banners, callout arrows, spinal level tags, 4K PNG/JPG export).
- [x] Hidden-by-default On-Demand SRS–Schwab Spinopelvic drawer with zero mock values and a strict millimeter calibration gate.
- [x] Installable Offline Desktop PWA (`manifest.webmanifest` + `sw.js` + `192`/`512` icons) + executable `npm run test:preflight` gate.

## 4. Environment & Cross-Machine Notes (`AMdesk` ↔ `Mobile1`)
- **Zero Secrets Needed:** Runs 100% locally. Dev port `5179`, preview port `4179`.
- **Windows PowerShell Note:** Invoke `npm.cmd` (not `npm.ps1`) when PowerShell script execution policy is restricted, and always pass `--prefix "C:\Users\mohal\Documents\antigravity\LexDICOM"` or `git -C "C:\Users\mohal\Documents\antigravity\LexDICOM"` (never raw `cd`).
- **Quick Recovery on Another PC:** `git clone https://github.com/alexmohit825/LexDICOM "C:\Users\mohal\Documents\antigravity\LexDICOM"`, then `npm.cmd --prefix "C:\Users\mohal\Documents\antigravity\LexDICOM" install` and `npm.cmd --prefix "C:\Users\mohal\Documents\antigravity\LexDICOM" run dev`.

## 5. Potential Next Enhancements (V1.1+)
- Optional Cloudflare Pages static deployment (`lexdicom.pages.dev`) so every PC can click "Install App" from one bookmark URL with automatic silent PWA updates (still 100% local file execution, zero server uploads).
- Optional multi-page PDF Exhibit Booklet export (combining multiple saved courtroom comparison plates into a Bates-ready exhibit packet).
- Optional Tauri/Electron native wrapper if Windows `.dcm` double-click file association is ever desired.
