# LexDICOM — Medicolegal DICOM Workstation & Courtroom Exhibit Studio

**LexDICOM** is a 100% local-first, zero-cloud desktop Progressive Web Application (PWA) inspired by **RadiAnt DICOM Viewer**, purpose-engineered for medicolegal spine & neurosurgical consulting.

## Key Capabilities
- **Chaotic Legal-Firm Folder Ingestion:** Recursively crawls nested hospital CD directories, sniffs binary `DICM` & implicit Group `0008` headers (including extensionless `IM00001` files), filters `.exe`/`.dll`/`DICOMDIR` junk, reads only the first `128 KB` header during indexing (`256 MB` LRU decode cap — zero browser OOM), and sorts **Patient → Chronological Study Date (`T1`, `T2`, ...) → Modality/Series**.
- **Hospital Compression Codecs:** Explicit/Implicit VR Little/Big Endian (8/12/16/32-bit), **JPEG Lossless Process 14 (`1.2.840.10008.1.2.4.70` / `.57`)**, **RLE Lossless (`1.2.840.10008.1.2.5`)**, JPEG Baseline/Extended, JPEG-LS, and JPEG 2000 via Cornerstone3D WASM workers.
- **RadiAnt Layout & Ergonomics:** Compact 3-group top toolbar, simultaneous **Left / Middle / Right / Wheel** mouse-button bindings (click toolbar buttons with Left, Middle, or Right mouse button to bind), multi-panel grids (`1×1`, `1×2`, `2×2`, `2×3`) with per-panel header tabs (`Tab` cycles maximized panels), longitudinal slice sync, 3D Sagittal ↔ Axial yellow scout cross-reference lines, and 3-plane **2D Orthogonal MPR**.
- **Court & Deposition Exhibit Studio:** 1-click Hospital PHI Scrubber, courtroom case captions & per-panel banners (`PRE-INCIDENT` vs `POST-INCIDENT`), vector callout arrows, spinal level stamps (`C2-C3` through `L5-S1`), clinical ROI calipers, and **4K High-DPI PNG/JPEG composite export**.
- **On-Demand SRS–Schwab Spinopelvic Drawer:** Strictly hidden by default; computes deterministic `PI`, `PT`, `SS`, `LL`, `TK`, `PI–LL`, `PJK`, and enforces a **Courtroom Millimeter Calibration Gate** on plain radiographs before reporting `SVA (mm)`.

## Local Development & Verification
```powershell
npm.cmd install
npm.cmd run build
npm.cmd run test:preflight
npm.cmd run dev
```

© 2026 A. Alex Mohit
