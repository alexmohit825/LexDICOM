import dicomParser from 'dicom-parser';
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';
import { DecodedSlice, DicomSliceRef } from '../types/dicom';

const MAX_CACHE_BYTES = 256 * 1024 * 1024; // 256 MB strict cap to prevent Chromium tab OOM
const sliceCache = new Map<string, DecodedSlice>();
let currentCacheBytes = 0;

let cornerstoneInitialized = false;
let cornerstoneLoaderPromise: Promise<typeof import('@cornerstonejs/dicom-image-loader') | null> | null = null;

async function getCornerstoneLoader() {
  if (!cornerstoneLoaderPromise) {
    cornerstoneLoaderPromise = (async () => {
      try {
        const csCore = await import('@cornerstonejs/core');
        const csLoader = await import('@cornerstonejs/dicom-image-loader');
        if (!cornerstoneInitialized) {
          await csCore.init();
          csLoader.init({ maxWebWorkers: Math.min(4, navigator.hardwareConcurrency || 2) });
          cornerstoneInitialized = true;
        }
        return csLoader;
      } catch {
        return null;
      }
    })();
  }
  return cornerstoneLoaderPromise;
}

export function evictSeriesFromCache(seriesInstanceUID: string): void {
  const prefix = `${seriesInstanceUID}::`;
  for (const [key, val] of sliceCache.entries()) {
    if (key.startsWith(prefix)) {
      currentCacheBytes = Math.max(0, currentCacheBytes - val.byteLength);
      sliceCache.delete(key);
    }
  }
}

export function clearDecodeCache(): void {
  sliceCache.clear();
  currentCacheBytes = 0;
}

export function getCacheStats(): { cachedSlices: number; usedMegabytes: number } {
  return {
    cachedSlices: sliceCache.size,
    usedMegabytes: Math.round((currentCacheBytes / (1024 * 1024)) * 10) / 10,
  };
}

function putInCache(key: string, decoded: DecodedSlice): void {
  if (sliceCache.has(key)) {
    const prev = sliceCache.get(key)!;
    currentCacheBytes = Math.max(0, currentCacheBytes - prev.byteLength);
    sliceCache.delete(key);
  }
  while (currentCacheBytes + decoded.byteLength > MAX_CACHE_BYTES && sliceCache.size > 0) {
    const oldestKey = sliceCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = sliceCache.get(oldestKey)!;
    currentCacheBytes = Math.max(0, currentCacheBytes - oldest.byteLength);
    sliceCache.delete(oldestKey);
  }
  sliceCache.set(key, decoded);
  currentCacheBytes += decoded.byteLength;
}

/** DICOM PS3.5 Annex G PackBits RLE Lossless Decoder (1.2.840.10008.1.2.5) */
export function decodeRleFrame(
  rleBytes: Uint8Array,
  rows: number,
  columns: number,
  bitsAllocated: number,
  samplesPerPixel: number
): Uint8Array {
  const view = new DataView(rleBytes.buffer, rleBytes.byteOffset, rleBytes.byteLength);
  const numSegments = view.getUint32(0, true);
  const pixelCount = rows * columns;
  const bytesPerSample = Math.ceil(bitsAllocated / 8);
  const totalBytes = pixelCount * bytesPerSample * samplesPerPixel;
  const out = new Uint8Array(totalBytes);

  for (let s = 0; s < numSegments; s++) {
    const segOffset = view.getUint32((s + 1) * 4, true);
    const nextOffset =
      s + 1 < numSegments ? view.getUint32((s + 2) * 4, true) : rleBytes.byteLength;

    const decodedPlane = new Uint8Array(pixelCount);
    let srcIdx = segOffset;
    let dstIdx = 0;

    while (srcIdx < nextOffset && dstIdx < pixelCount) {
      // Signed 8-bit header byte per PackBits spec
      const n = (rleBytes[srcIdx++] << 24) >> 24;
      if (n >= 0 && n <= 127) {
        const count = n + 1;
        for (let k = 0; k < count && srcIdx < nextOffset && dstIdx < pixelCount; k++) {
          decodedPlane[dstIdx++] = rleBytes[srcIdx++];
        }
      } else if (n >= -127 && n <= -1) {
        const count = -n + 1;
        const val = srcIdx < nextOffset ? rleBytes[srcIdx++] : 0;
        for (let k = 0; k < count && dstIdx < pixelCount; k++) {
          decodedPlane[dstIdx++] = val;
        }
      }
      // n === -128 is NOOP
    }

    if (samplesPerPixel === 1 && bytesPerSample === 2) {
      // Segment 0 = MSB, Segment 1 = LSB -> Little Endian [LSB, MSB]
      const bytePos = s === 0 ? 1 : 0;
      for (let i = 0; i < pixelCount; i++) {
        out[i * 2 + bytePos] = decodedPlane[i];
      }
    } else if (samplesPerPixel === 1 && bytesPerSample === 1) {
      out.set(decodedPlane.subarray(0, pixelCount));
    } else {
      for (let i = 0; i < pixelCount; i++) {
        out[i * numSegments + s] = decodedPlane[i];
      }
    }
  }
  return out;
}

function extractEncapsulatedFrame(dataSet: dicomParser.DataSet, pixelElement: dicomParser.Element): Uint8Array {
  if (pixelElement.fragments && pixelElement.fragments.length > 0) {
    if (pixelElement.basicOffsetTable && pixelElement.basicOffsetTable.length > 0) {
      return dicomParser.readEncapsulatedImageFrame(dataSet, pixelElement, 0);
    }
    return dicomParser.readEncapsulatedPixelDataFromFragments(
      dataSet,
      pixelElement,
      0,
      pixelElement.fragments.length
    );
  }
  return new Uint8Array(
    dataSet.byteArray.buffer,
    dataSet.byteArray.byteOffset + pixelElement.dataOffset,
    pixelElement.length
  );
}

function convertRawBytesToScalar(
  rawBytes: Uint8Array,
  slice: DicomSliceRef,
  bigEndian = false
): { scalarData: Float32Array; rgbData?: Uint8ClampedArray; minVal: number; maxVal: number } {
  const numPixels = slice.rows * slice.columns;
  const scalarData = new Float32Array(numPixels);
  const slope = slice.rescaleSlope || 1;
  const intercept = slice.rescaleIntercept || 0;

  if (slice.samplesPerPixel === 3) {
    const rgbData = new Uint8ClampedArray(numPixels * 4);
    let minVal = Infinity;
    let maxVal = -Infinity;
    const isPlanar = slice.planarConfiguration === 1;
    for (let i = 0; i < numPixels; i++) {
      const r = isPlanar ? rawBytes[i] : rawBytes[i * 3];
      const g = isPlanar ? rawBytes[i + numPixels] : rawBytes[i * 3 + 1];
      const b = isPlanar ? rawBytes[i + numPixels * 2] : rawBytes[i * 3 + 2];
      rgbData[i * 4] = r;
      rgbData[i * 4 + 1] = g;
      rgbData[i * 4 + 2] = b;
      rgbData[i * 4 + 3] = 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      scalarData[i] = lum;
      if (lum < minVal) minVal = lum;
      if (lum > maxVal) maxVal = lum;
    }
    return { scalarData, rgbData, minVal: minVal === Infinity ? 0 : minVal, maxVal: maxVal === -Infinity ? 255 : maxVal };
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const littleEndian = !bigEndian;

  if (slice.bitsAllocated <= 8) {
    const signed = slice.pixelRepresentation === 1;
    for (let i = 0; i < numPixels && i < rawBytes.byteLength; i++) {
      const raw = signed ? view.getInt8(i) : rawBytes[i];
      const val = raw * slope + intercept;
      scalarData[i] = val;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  } else if (slice.bitsAllocated <= 16) {
    const signed = slice.pixelRepresentation === 1;
    const shift = 16 - slice.bitsStored;
    const mask = (1 << slice.bitsStored) - 1;
    const maxBytes = Math.min(numPixels, Math.floor(rawBytes.byteLength / 2));
    for (let i = 0; i < maxBytes; i++) {
      let raw: number;
      if (signed) {
        const u = view.getUint16(i * 2, littleEndian);
        // Sign-extend if bitsStored < 16 (e.g. 12-bit signed CT)
        raw = shift > 0 ? ((u << shift) << 16) >> (16 + shift) : view.getInt16(i * 2, littleEndian);
      } else {
        raw = view.getUint16(i * 2, littleEndian) & mask;
      }
      const val = raw * slope + intercept;
      scalarData[i] = val;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  } else if (slice.bitsAllocated === 32) {
    const signed = slice.pixelRepresentation === 1;
    const maxItems = Math.min(numPixels, Math.floor(rawBytes.byteLength / 4));
    for (let i = 0; i < maxItems; i++) {
      const raw = signed ? view.getInt32(i * 4, littleEndian) : view.getUint32(i * 4, littleEndian);
      const val = raw * slope + intercept;
      scalarData[i] = val;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  }

  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = 1000;
  return { scalarData, minVal, maxVal };
}

/** Decodes any hospital DICOM slice into a rescaled Float32 clinical buffer */
export async function decodeDicomSlice(slice: DicomSliceRef): Promise<DecodedSlice> {
  const cached = sliceCache.get(slice.id);
  if (cached) {
    // Refresh LRU order
    sliceCache.delete(slice.id);
    sliceCache.set(slice.id, cached);
    return cached;
  }

  const file = await slice.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const byteArray = new Uint8Array(arrayBuffer);
  const ts = slice.transferSyntaxUID;

  const isUncompressed =
    ts === '1.2.840.10008.1.2' ||
    ts === '1.2.840.10008.1.2.1' ||
    ts === '1.2.840.10008.1.2.2';

  const isJpegLossless =
    ts === '1.2.840.10008.1.2.4.70' ||
    ts === '1.2.840.10008.1.2.4.57';

  const isRle = ts === '1.2.840.10008.1.2.5';
  const isJpegBaseline8 = ts === '1.2.840.10008.1.2.4.50';

  let scalarData: Float32Array | null = null;
  let rgbData: Uint8ClampedArray | undefined;
  let minVal = 0;
  let maxVal = 1000;

  const dataSet = dicomParser.parseDicom(byteArray);
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement) {
    throw new Error(`Missing PixelData (7FE0,0010) in ${slice.fileName}`);
  }

  if (isUncompressed) {
    const rawBytes = new Uint8Array(
      byteArray.buffer,
      byteArray.byteOffset + pixelElement.dataOffset,
      pixelElement.length
    );
    const res = convertRawBytesToScalar(rawBytes, slice, ts === '1.2.840.10008.1.2.2');
    scalarData = res.scalarData;
    rgbData = res.rgbData;
    minVal = res.minVal;
    maxVal = res.maxVal;
  } else if (isJpegLossless) {
    // Hospital CD #1 format: JPEG Lossless Process 14 (1.2.840.10008.1.2.4.70 / .57)
    const frameBytes = extractEncapsulatedFrame(dataSet, pixelElement);
    const decoder = new JpegLosslessDecoder();
    const bytesPerSample = slice.bitsAllocated <= 8 ? 1 : 2;
    const decodedBuf = decoder.decode(
      frameBytes.buffer as ArrayBuffer,
      frameBytes.byteOffset,
      frameBytes.byteLength,
      bytesPerSample
    );
    const res = convertRawBytesToScalar(new Uint8Array(decodedBuf), slice, false);
    scalarData = res.scalarData;
    rgbData = res.rgbData;
    minVal = res.minVal;
    maxVal = res.maxVal;
  } else if (isRle) {
    const frameBytes = extractEncapsulatedFrame(dataSet, pixelElement);
    const rawBytes = decodeRleFrame(
      frameBytes,
      slice.rows,
      slice.columns,
      slice.bitsAllocated,
      slice.samplesPerPixel
    );
    const res = convertRawBytesToScalar(rawBytes, slice, false);
    scalarData = res.scalarData;
    rgbData = res.rgbData;
    minVal = res.minVal;
    maxVal = res.maxVal;
  } else if (isJpegBaseline8 && typeof createImageBitmap === 'function') {
    const frameBytes = extractEncapsulatedFrame(dataSet, pixelElement);
    const frameCopy = new Uint8Array(frameBytes.byteLength);
    frameCopy.set(frameBytes);
    const blob = new Blob([frameCopy.buffer], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const imgData = ctx.getImageData(0, 0, slice.columns, slice.rows).data;
    const numPixels = slice.rows * slice.columns;
    scalarData = new Float32Array(numPixels);
    if (slice.samplesPerPixel === 3) {
      rgbData = new Uint8ClampedArray(imgData);
    }
    minVal = Infinity;
    maxVal = -Infinity;
    const slope = slice.rescaleSlope || 1;
    const intercept = slice.rescaleIntercept || 0;
    for (let i = 0; i < numPixels; i++) {
      const lum =
        slice.samplesPerPixel === 3
          ? 0.299 * imgData[i * 4] + 0.587 * imgData[i * 4 + 1] + 0.114 * imgData[i * 4 + 2]
          : imgData[i * 4] * slope + intercept;
      scalarData[i] = lum;
      if (lum < minVal) minVal = lum;
      if (lum > maxVal) maxVal = lum;
    }
  } else {
    // Delegate JPEG 2000 (.90/.91), JPEG-LS (.80/.81), Extended 12-bit JPEG (.51) to Cornerstone3D WASM Loader
    const csLoader = await getCornerstoneLoader();
    if (!csLoader) {
      throw new Error(`Unsupported compressed Transfer Syntax ${ts}`);
    }
    const imageId = csLoader.wadouri.fileManager.add(file);
    const csCore = await import('@cornerstonejs/core');
    const image = await csCore.imageLoader.loadImage(imageId);
    const pixData = image.getPixelData();
    const numPixels = slice.rows * slice.columns;
    scalarData = new Float32Array(numPixels);
    const slope = image.slope ?? slice.rescaleSlope ?? 1;
    const intercept = image.intercept ?? slice.rescaleIntercept ?? 0;
    minVal = Infinity;
    maxVal = -Infinity;
    for (let i = 0; i < numPixels; i++) {
      const val = Number(pixData[i]) * slope + intercept;
      scalarData[i] = val;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
  }

  // Fallback auto-window if header WW/WL was missing or degenerate
  let defaultWc = slice.windowCenter;
  let defaultWw = slice.windowWidth;
  if (!Number.isFinite(defaultWc) || !Number.isFinite(defaultWw) || defaultWw <= 1 || (defaultWc === 400 && defaultWw === 800 && maxVal < 300)) {
    defaultWc = (minVal + maxVal) / 2;
    defaultWw = Math.max(1, maxVal - minVal);
  }

  const decoded: DecodedSlice = {
    sliceId: slice.id,
    rows: slice.rows,
    columns: slice.columns,
    samplesPerPixel: slice.samplesPerPixel,
    photometricInterpretation: slice.photometricInterpretation,
    scalarData: scalarData!,
    rgbData,
    minValue: minVal,
    maxValue: maxVal,
    defaultWindowCenter: Math.round(defaultWc),
    defaultWindowWidth: Math.round(defaultWw),
    byteLength: scalarData!.byteLength + (rgbData ? rgbData.byteLength : 0),
  };

  putInCache(slice.id, decoded);
  return decoded;
}

/** Renders a decoded Float32 slice into RGBA pixels applying DICOM PS3.3 Linear VOI LUT (WW/WL) */
export function renderSliceToImageData(
  decoded: DecodedSlice,
  windowCenter: number,
  windowWidth: number,
  invert: boolean
): ImageData {
  const { rows, columns, scalarData, rgbData, photometricInterpretation } = decoded;
  const imgData = new ImageData(columns, rows);
  const dst = imgData.data;
  const numPixels = rows * columns;

  if (rgbData) {
    if (!invert) {
      dst.set(rgbData);
    } else {
      for (let i = 0; i < numPixels * 4; i += 4) {
        dst[i] = 255 - rgbData[i];
        dst[i + 1] = 255 - rgbData[i + 1];
        dst[i + 2] = 255 - rgbData[i + 2];
        dst[i + 3] = 255;
      }
    }
    return imgData;
  }

  const ww = Math.max(1, windowWidth);
  const low = windowCenter - 0.5 - (ww - 1) / 2;
  const high = windowCenter - 0.5 + (ww - 1) / 2;
  const invSpan = 255 / Math.max(1e-5, ww - 1);
  const flipPolarity = (photometricInterpretation === 'MONOCHROME1') !== invert;

  for (let i = 0; i < numPixels; i++) {
    const v = scalarData[i];
    let gray: number;
    if (v <= low) gray = 0;
    else if (v > high) gray = 255;
    else gray = ((v - (windowCenter - 0.5)) * invSpan + 127.5) | 0;

    if (flipPolarity) gray = 255 - gray;
    const p = i * 4;
    dst[p] = gray;
    dst[p + 1] = gray;
    dst[p + 2] = gray;
    dst[p + 3] = 255;
  }

  return imgData;
}

export async function generateSeriesThumbnail(slice: DicomSliceRef): Promise<string> {
  const decoded = await decodeDicomSlice(slice);
  const imgData = renderSliceToImageData(
    decoded,
    decoded.defaultWindowCenter,
    decoded.defaultWindowWidth,
    false
  );
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = decoded.columns;
  srcCanvas.height = decoded.rows;
  srcCanvas.getContext('2d')!.putImageData(imgData, 0, 0);

  const thumbSize = 96;
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbSize;
  thumbCanvas.height = thumbSize;
  const tctx = thumbCanvas.getContext('2d')!;
  tctx.fillStyle = '#05070b';
  tctx.fillRect(0, 0, thumbSize, thumbSize);

  const scale = Math.min(thumbSize / decoded.columns, thumbSize / decoded.rows);
  const drawW = decoded.columns * scale;
  const drawH = decoded.rows * scale;
  tctx.drawImage(srcCanvas, (thumbSize - drawW) / 2, (thumbSize - drawH) / 2, drawW, drawH);
  return thumbCanvas.toDataURL('image/jpeg', 0.85);
}
