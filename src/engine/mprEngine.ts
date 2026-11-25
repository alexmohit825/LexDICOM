import { DicomSeries } from '../types/dicom';
import { decodeDicomSlice } from './dicomDecoder';

export interface MprVolume {
  seriesInstanceUID: string;
  seriesDescription: string;
  dimX: number; // Columns
  dimY: number; // Rows
  dimZ: number; // Slices
  spacingX: number; // mm
  spacingY: number; // mm
  spacingZ: number; // mm
  voxels: Float32Array;
  minVal: number;
  maxVal: number;
  defaultWc: number;
  defaultWw: number;
}

export async function buildMprVolume(
  series: DicomSeries,
  onProgress?: (loaded: number, total: number) => void
): Promise<MprVolume> {
  const slices = series.slices;
  if (slices.length < 3) {
    throw new Error('MPR requires a volumetric series with at least 3 slices.');
  }

  const first = slices[0];
  const dimX = first.columns;
  const dimY = first.rows;
  const dimZ = slices.length;
  const voxels = new Float32Array(dimX * dimY * dimZ);

  const spacingY = first.pixelSpacing?.[0] ?? 1.0;
  const spacingX = first.pixelSpacing?.[1] ?? 1.0;
  let spacingZ = first.spacingBetweenSlices ?? first.sliceThickness ?? 2.0;
  if (slices.length >= 2) {
    const dz = Math.abs(slices[1].normalPosition - slices[0].normalPosition);
    if (dz > 0.05) spacingZ = dz;
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  const sliceSize = dimX * dimY;

  for (let z = 0; z < dimZ; z++) {
    const decoded = await decodeDicomSlice(slices[z]);
    const copyLen = Math.min(sliceSize, decoded.scalarData.length);
    voxels.set(decoded.scalarData.subarray(0, copyLen), z * sliceSize);
    if (decoded.minValue < minVal) minVal = decoded.minValue;
    if (decoded.maxValue > maxVal) maxVal = decoded.maxValue;
    onProgress?.(z + 1, dimZ);
  }

  return {
    seriesInstanceUID: series.seriesInstanceUID,
    seriesDescription: series.seriesDescription,
    dimX,
    dimY,
    dimZ,
    spacingX,
    spacingY,
    spacingZ,
    voxels,
    minVal: Number.isFinite(minVal) ? minVal : 0,
    maxVal: Number.isFinite(maxVal) ? maxVal : 1000,
    defaultWc: first.windowCenter,
    defaultWw: first.windowWidth,
  };
}

export type MprPlane = 'AXIAL' | 'SAGITTAL' | 'CORONAL';

export interface MprSliceRender {
  imageData: ImageData;
  /** Physical aspect ratio (pixelWidthMm / pixelHeightMm) so anisotropic Z slices never appear squashed */
  pixelAspectRatio: number;
  width: number;
  height: number;
}

export function extractMprPlane(
  vol: MprVolume,
  plane: MprPlane,
  index: number,
  wc: number,
  ww: number
): MprSliceRender {
  const { dimX, dimY, dimZ, spacingX, spacingY, spacingZ, voxels } = vol;
  const span = Math.max(1, ww);
  const low = wc - span / 2;
  const scale = 255 / span;

  const toGray = (v: number): number => {
    if (v <= low) return 0;
    if (v >= low + span) return 255;
    return ((v - low) * scale) | 0;
  };

  if (plane === 'AXIAL') {
    const z = Math.max(0, Math.min(dimZ - 1, Math.round(index)));
    const img = new ImageData(dimX, dimY);
    const dst = img.data;
    const zOff = z * dimX * dimY;
    for (let i = 0; i < dimX * dimY; i++) {
      const g = toGray(voxels[zOff + i]);
      const p = i * 4;
      dst[p] = g;
      dst[p + 1] = g;
      dst[p + 2] = g;
      dst[p + 3] = 255;
    }
    return {
      imageData: img,
      pixelAspectRatio: spacingX / spacingY,
      width: dimX,
      height: dimY,
    };
  }

  if (plane === 'SAGITTAL') {
    // X fixed, columns = Y (anterior->posterior), rows = Z (superior->inferior)
    const x = Math.max(0, Math.min(dimX - 1, Math.round(index)));
    const img = new ImageData(dimY, dimZ);
    const dst = img.data;
    for (let z = 0; z < dimZ; z++) {
      // Flip Z top-to-bottom if slices run inferior->superior
      const srcZ = dimZ - 1 - z;
      const zOff = srcZ * dimX * dimY;
      for (let y = 0; y < dimY; y++) {
        const g = toGray(voxels[zOff + y * dimX + x]);
        const p = (z * dimY + y) * 4;
        dst[p] = g;
        dst[p + 1] = g;
        dst[p + 2] = g;
        dst[p + 3] = 255;
      }
    }
    return {
      imageData: img,
      pixelAspectRatio: spacingY / spacingZ,
      width: dimY,
      height: dimZ,
    };
  }

  // CORONAL: Y fixed, columns = X, rows = Z
  const y = Math.max(0, Math.min(dimY - 1, Math.round(index)));
  const img = new ImageData(dimX, dimZ);
  const dst = img.data;
  for (let z = 0; z < dimZ; z++) {
    const srcZ = dimZ - 1 - z;
    const zOff = srcZ * dimX * dimY + y * dimX;
    for (let x = 0; x < dimX; x++) {
      const g = toGray(voxels[zOff + x]);
      const p = (z * dimX + x) * 4;
      dst[p] = g;
      dst[p + 1] = g;
      dst[p + 2] = g;
      dst[p + 3] = 255;
    }
  }
  return {
    imageData: img,
    pixelAspectRatio: spacingX / spacingZ,
    width: dimX,
    height: dimZ,
  };
}
