import { DicomSeries, DicomSliceRef, Point2D } from '../types/dicom';

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function pixelToPatient3D(slice: DicomSliceRef, col: number, row: number): Vec3 | null {
  const ipp = slice.imagePositionPatient;
  const iop = slice.imageOrientationPatient;
  const ps = slice.pixelSpacing;
  if (!ipp || !iop || !ps) return null;

  const rowDir: Vec3 = [iop[0], iop[1], iop[2]]; // X direction along columns
  const colDir: Vec3 = [iop[3], iop[4], iop[5]]; // Y direction along rows
  const [rowSpacing, colSpacing] = ps;

  return add(add(ipp, scale(rowDir, col * colSpacing)), scale(colDir, row * rowSpacing));
}

function patient3DToPixel(target: DicomSliceRef, pt: Vec3): Point2D | null {
  const ipp = target.imagePositionPatient;
  const iop = target.imageOrientationPatient;
  const ps = target.pixelSpacing;
  if (!ipp || !iop || !ps) return null;

  const rowDir: Vec3 = [iop[0], iop[1], iop[2]];
  const colDir: Vec3 = [iop[3], iop[4], iop[5]];
  const [rowSpacing, colSpacing] = ps;

  const rel = sub(pt, ipp);
  const x = dot(rel, rowDir) / colSpacing;
  const y = dot(rel, colDir) / rowSpacing;
  return { x, y };
}

/**
 * Computes the exact 2D Scout Reference Line segment on `targetSlice` (e.g. Sagittal T2)
 * representing the intersection with `sourceSlice` (e.g. Axial L4-L5 disc slice).
 */
export function computeScoutIntersectionLine(
  sourceSlice: DicomSliceRef,
  targetSlice: DicomSliceRef
): [Point2D, Point2D] | null {
  if (sourceSlice.seriesInstanceUID === targetSlice.seriesInstanceUID) return null;
  if (
    sourceSlice.frameOfReferenceUID &&
    targetSlice.frameOfReferenceUID &&
    sourceSlice.frameOfReferenceUID !== targetSlice.frameOfReferenceUID
  ) {
    return null;
  }

  const tIpp = targetSlice.imagePositionPatient;
  const tIop = targetSlice.imageOrientationPatient;
  const sIop = sourceSlice.imageOrientationPatient;
  if (!tIpp || !tIop || !sIop) return null;

  const tNormal = cross([tIop[0], tIop[1], tIop[2]], [tIop[3], tIop[4], tIop[5]]);
  const sNormal = cross([sIop[0], sIop[1], sIop[2]], [sIop[3], sIop[4], sIop[5]]);

  // Parallel planes (e.g. both Sagittal) do not intersect in a scout line
  const parallelDot = Math.abs(dot(tNormal, sNormal)) / Math.max(1e-6, norm(tNormal) * norm(sNormal));
  if (parallelDot > 0.92) return null;

  // Intersect the 4 edges of sourceSlice's 3D bounding quad with targetSlice's plane
  const c0 = pixelToPatient3D(sourceSlice, 0, 0);
  const c1 = pixelToPatient3D(sourceSlice, sourceSlice.columns, 0);
  const c2 = pixelToPatient3D(sourceSlice, sourceSlice.columns, sourceSlice.rows);
  const c3 = pixelToPatient3D(sourceSlice, 0, sourceSlice.rows);
  if (!c0 || !c1 || !c2 || !c3) return null;

  const edges: [Vec3, Vec3][] = [
    [c0, c1],
    [c1, c2],
    [c2, c3],
    [c3, c0],
  ];

  const hits3D: Vec3[] = [];
  for (const [pA, pB] of edges) {
    const dA = dot(sub(pA, tIpp), tNormal);
    const dB = dot(sub(pB, tIpp), tNormal);
    if ((dA <= 0 && dB >= 0) || (dA >= 0 && dB <= 0)) {
      const denom = dA - dB;
      if (Math.abs(denom) > 1e-6) {
        const t = dA / denom;
        if (t >= 0 && t <= 1) {
          hits3D.push(add(pA, scale(sub(pB, pA), t)));
        }
      }
    }
  }

  if (hits3D.length < 2) return null;
  const pt1 = patient3DToPixel(targetSlice, hits3D[0]);
  const pt2 = patient3DToPixel(targetSlice, hits3D[hits3D.length - 1]);
  if (!pt1 || !pt2) return null;
  if (Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y) < 4) return null;

  return [pt1, pt2];
}

/**
 * Synchronizes slice scrolling across longitudinal timepoints (e.g. 2022 Sagittal T2 vs 2024 Sagittal T2)
 * when orientation planes match.
 */
export function findSynchronizedSliceIndex(
  sourceSeries: DicomSeries,
  sourceSliceIndex: number,
  targetSeries: DicomSeries
): number | null {
  if (targetSeries.slices.length <= 1 || sourceSeries.slices.length <= 1) return null;
  if (sourceSeries.orientationPlane !== targetSeries.orientationPlane) return null;

  const srcSlice = sourceSeries.slices[sourceSliceIndex];
  if (!srcSlice) return null;

  // Same FrameOfReferenceUID -> match exact normalPosition (mm)
  if (
    sourceSeries.frameOfReferenceUID &&
    sourceSeries.frameOfReferenceUID === targetSeries.frameOfReferenceUID
  ) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < targetSeries.slices.length; i++) {
      const d = Math.abs(targetSeries.slices[i].normalPosition - srcSlice.normalPosition);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Cross-timepoint comparison (2022 vs 2024 MRI): match normalized anatomical progression [0..1]
  const frac = sourceSliceIndex / Math.max(1, sourceSeries.slices.length - 1);
  return Math.min(
    targetSeries.slices.length - 1,
    Math.max(0, Math.round(frac * (targetSeries.slices.length - 1)))
  );
}
