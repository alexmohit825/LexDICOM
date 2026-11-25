import { Point2D, SchwabLandmarks } from '../types/dicom';

export interface SchwabComputedMetrics {
  sacralSlopeDeg: number | null;
  pelvicTiltDeg: number | null;
  pelvicIncidenceDeg: number | null;
  lumbarLordosisDeg: number | null;
  thoracicKyphosisDeg: number | null;
  piMinusLlDeg: number | null;
  pjkAngleDeg: number | null;
  /** Raw horizontal pixel offset from C7 Plumb Line to S1 posterior-superior corner */
  svaPixels: number | null;
  /** Strictly null unless calibrated physical PixelSpacing or Manual Reference Calibration exists */
  svaMillimeters: number | null;
  isCalibratedForMm: boolean;
  calibrationSource: 'DICOM_PIXEL_SPACING' | 'MANUAL_REFERENCE' | 'UNCALIBRATED_RADIOGRAPH';
  piLlModifier: '0' | '+' | '++' | null;
  ptModifier: '0' | '+' | '++' | null;
  svaModifier: '0' | '+' | '++' | null;
}

function lineAngleBetween(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): number {
  const ux = a2.x - a1.x;
  const uy = a2.y - a1.y;
  const vx = b2.x - b1.x;
  const vy = b2.y - b1.y;
  const mag = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (mag < 1e-6) return 0;
  // Acute angle between two endplate lines [0..90] or obtuse if needed; Cobb angles measure acute intersection of endplate lines
  const cosTheta = Math.min(1, Math.max(-1, Math.abs(ux * vx + uy * vy) / mag));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

/**
 * Deterministic SRS-Schwab & Spinopelvic Geometric Solver.
 * Angles are 100% magnification-invariant; linear SVA (mm) enforces a strict calibration gate.
 */
export function computeSchwabMetrics(
  lm: SchwabLandmarks,
  dicomPixelSpacing?: [number, number],
  manualMmPerPx?: number
): SchwabComputedMetrics {
  const rowMm = manualMmPerPx ?? dicomPixelSpacing?.[0];
  const colMm = manualMmPerPx ?? dicomPixelSpacing?.[1];
  const isCalibratedForMm = Boolean(rowMm && colMm && rowMm > 0 && colMm > 0);
  const calibrationSource = manualMmPerPx
    ? 'MANUAL_REFERENCE'
    : dicomPixelSpacing
      ? 'DICOM_PIXEL_SPACING'
      : 'UNCALIBRATED_RADIOGRAPH';

  // Normalize coordinates into isotropic geometric space if anisotropic pixel spacing exists
  const sx = colMm ?? 1;
  const sy = rowMm ?? 1;
  const iso = (p: Point2D): Point2D => ({ x: p.x * sx, y: p.y * sy });

  let sacralSlopeDeg: number | null = null;
  let pelvicTiltDeg: number | null = null;
  let pelvicIncidenceDeg: number | null = null;
  let lumbarLordosisDeg: number | null = null;
  let thoracicKyphosisDeg: number | null = null;
  let piMinusLlDeg: number | null = null;
  let pjkAngleDeg: number | null = null;
  let svaPixels: number | null = null;
  let svaMillimeters: number | null = null;

  if (lm.s1Post && lm.s1Ant) {
    const pPost = iso(lm.s1Post);
    const pAnt = iso(lm.s1Ant);
    const dx = pAnt.x - pPost.x;
    const dy = pAnt.y - pPost.y;
    // Sacral Slope: angle between S1 superior endplate and horizontal
    sacralSlopeDeg = Math.round(lineAngleBetween(pPost, pAnt, { x: 0, y: 0 }, { x: 100, y: 0 }) * 10) / 10;

    if (lm.femoralHead) {
      const fh = iso(lm.femoralHead);
      const s1Mid: Point2D = { x: (pPost.x + pAnt.x) / 2, y: (pPost.y + pAnt.y) / 2 };

      // Pelvic Tilt: angle between line (FemoralHead -> S1 Midpoint) and vertical axis
      const vx = s1Mid.x - fh.x;
      const vy = s1Mid.y - fh.y; // y grows downward in image coordinates, so S1 above FH -> vy < 0
      const ptRad = Math.acos(Math.min(1, Math.max(-1, Math.abs(vy) / Math.max(1e-6, Math.hypot(vx, vy)))));
      // Sign: if S1 midpoint is posterior to femoral head relative to anterior facing direction (dx sign)
      const facingSign = dx >= 0 ? 1 : -1;
      const retrovertedSign = (fh.x - s1Mid.x) * facingSign >= 0 ? 1 : -1;
      pelvicTiltDeg = Math.round(((ptRad * 180) / Math.PI) * retrovertedSign * 10) / 10;

      // Pelvic Incidence: angle between downward perpendicular to S1 endplate at s1Mid and (s1Mid -> FemoralHead)
      // Endplate tangent from post -> ant is (dx, dy). Downward (caudal) normal has positive y component:
      let nx = -dy;
      let ny = dx;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const fVecX = fh.x - s1Mid.x;
      const fVecY = fh.y - s1Mid.y;
      const cosPi = Math.min(
        1,
        Math.max(-1, (nx * fVecX + ny * fVecY) / Math.max(1e-6, Math.hypot(nx, ny) * Math.hypot(fVecX, fVecY)))
      );
      pelvicIncidenceDeg = Math.round(((Math.acos(cosPi) * 180) / Math.PI) * 10) / 10;
    }

    if (lm.l1SupPost && lm.l1SupAnt) {
      lumbarLordosisDeg =
        Math.round(lineAngleBetween(iso(lm.l1SupPost), iso(lm.l1SupAnt), pPost, pAnt) * 10) / 10;
    }

    if (lm.c7Centroid) {
      const facingSign = lm.s1Ant.x - lm.s1Post.x >= 0 ? 1 : -1;
      const rawPx = (lm.c7Centroid.x - lm.s1Post.x) * facingSign;
      svaPixels = Math.round(rawPx * 10) / 10;
      if (isCalibratedForMm && colMm) {
        svaMillimeters = Math.round(rawPx * colMm * 10) / 10;
      }
    }
  }

  if (lm.l1SupPost && lm.l1SupAnt && lm.t1SupPost && lm.t1SupAnt) {
    thoracicKyphosisDeg =
      Math.round(
        lineAngleBetween(iso(lm.t1SupPost), iso(lm.t1SupAnt), iso(lm.l1SupPost), iso(lm.l1SupAnt)) * 10
      ) / 10;
  }

  if (lm.uivInfPost && lm.uivInfAnt && lm.uiv2SupPost && lm.uiv2SupAnt) {
    pjkAngleDeg =
      Math.round(
        lineAngleBetween(iso(lm.uivInfPost), iso(lm.uivInfAnt), iso(lm.uiv2SupPost), iso(lm.uiv2SupAnt)) * 10
      ) / 10;
  }

  if (pelvicIncidenceDeg !== null && lumbarLordosisDeg !== null) {
    piMinusLlDeg = Math.round((pelvicIncidenceDeg - lumbarLordosisDeg) * 10) / 10;
  }

  // SRS-Schwab Sagittal Modifiers
  const piLlModifier: '0' | '+' | '++' | null =
    piMinusLlDeg === null ? null : piMinusLlDeg < 10 ? '0' : piMinusLlDeg <= 20 ? '+' : '++';

  const ptModifier: '0' | '+' | '++' | null =
    pelvicTiltDeg === null ? null : pelvicTiltDeg < 20 ? '0' : pelvicTiltDeg <= 30 ? '+' : '++';

  const svaModifier: '0' | '+' | '++' | null =
    svaMillimeters === null ? null : svaMillimeters < 40 ? '0' : svaMillimeters <= 95 ? '+' : '++';

  return {
    sacralSlopeDeg,
    pelvicTiltDeg,
    pelvicIncidenceDeg,
    lumbarLordosisDeg,
    thoracicKyphosisDeg,
    piMinusLlDeg,
    pjkAngleDeg,
    svaPixels,
    svaMillimeters,
    isCalibratedForMm,
    calibrationSource,
    piLlModifier,
    ptModifier,
    svaModifier,
  };
}
