import dicomParser from 'dicom-parser';
import { DicomSeries, DicomSliceRef, DicomStudy, OrientationPlane } from '../types/dicom';

const HEADER_SCAN_BYTES = 131072; // 128 KB covers metadata preamble + tags without loading pixel bulk

const JUNK_EXTENSIONS = new Set([
  '.exe', '.dll', '.inf', '.ini', '.bat', '.cmd', '.msi', '.cab',
  '.html', '.htm', '.js', '.css', '.pdf', '.txt', '.xml', '.xsl',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.db', '.zip',
]);

export interface ScanProgress {
  scannedFiles: number;
  totalCandidateFiles: number;
  validDicomSlices: number;
  skippedJunkFiles: number;
  currentPath: string;
}

export interface CandidateFileEntry {
  name: string;
  relativePath: string;
  getFile: () => Promise<File>;
}

function shouldSkipByFilename(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === 'DICOMDIR' || upper === 'AUTORUN.INF' || upper === 'THUMBS.DB' || upper === '.DS_STORE') {
    return true;
  }
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = name.slice(dotIdx).toLowerCase();
    if (JUNK_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function parseNumberList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split('\\')
    .map((s) => Number.parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function formatDicomDate(raw: string): string {
  const clean = raw.replace(/[^0-9]/g, '');
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  }
  return raw || 'Undated Study';
}

function cleanPersonName(raw: string): string {
  if (!raw) return 'Unnamed Patient';
  return raw.replace(/\^+/g, ', ').replace(/,\s*$/, '').trim() || 'Unnamed Patient';
}

export function classifyOrientationPlane(
  iop?: [number, number, number, number, number, number],
  modality?: string
): OrientationPlane {
  if (!iop || iop.length !== 6) {
    if (modality === 'CR' || modality === 'DX' || modality === 'RF' || modality === 'MG') {
      return 'PROJECTION';
    }
    return 'AXIAL';
  }
  // Normal vector = rowCosines x colCosines in LPS coordinates
  const [rx, ry, rz, cx, cy, cz] = iop;
  const nx = Math.abs(ry * cz - rz * cy);
  const ny = Math.abs(rz * cx - rx * cz);
  const nz = Math.abs(rx * cy - ry * cx);
  const maxComp = Math.max(nx, ny, nz);
  if (maxComp < 0.75) return 'OBLIQUE';
  if (nx === maxComp) return 'SAGITTAL';
  if (ny === maxComp) return 'CORONAL';
  return 'AXIAL';
}

function computeNormalPosition(
  ipp?: [number, number, number],
  iop?: [number, number, number, number, number, number],
  fallbackSliceLoc = 0
): number {
  if (!ipp || !iop) return fallbackSliceLoc;
  const [rx, ry, rz, cx, cy, cz] = iop;
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;
  return ipp[0] * nx + ipp[1] * ny + ipp[2] * nz;
}

function hasDicomSignature(bytes: Uint8Array): { isDicom: boolean; implicitNoPreamble: boolean } {
  if (bytes.byteLength >= 132) {
    if (
      bytes[128] === 0x44 && // 'D'
      bytes[129] === 0x49 && // 'I'
      bytes[130] === 0x43 && // 'C'
      bytes[131] === 0x4d    // 'M'
    ) {
      return { isDicom: true, implicitNoPreamble: false };
    }
  }
  // Legacy ACR-NEMA / raw DICOM without 128-byte preamble starting at Group 0x0008 Little Endian
  if (bytes.byteLength >= 16 && bytes[0] === 0x08 && bytes[1] === 0x00 && bytes[3] === 0x00) {
    return { isDicom: true, implicitNoPreamble: true };
  }
  return { isDicom: false, implicitNoPreamble: false };
}

async function parseCandidateHeader(entry: CandidateFileEntry): Promise<{
  slice: DicomSliceRef;
  studyMeta: Omit<DicomStudy, 'series'>;
  seriesMeta: Omit<DicomSeries, 'slices' | 'isMprCapable' | 'thumbnailDataUrl'>;
} | null> {
  if (shouldSkipByFilename(entry.name)) return null;

  let file: File;
  try {
    file = await entry.getFile();
  } catch {
    return null;
  }
  if (file.size < 140) return null;

  const sliceBlob = file.slice(0, Math.min(file.size, HEADER_SCAN_BYTES));
  const buf = await sliceBlob.arrayBuffer();
  const byteArray = new Uint8Array(buf);
  const sig = hasDicomSignature(byteArray);
  if (!sig.isDicom) return null;

  let dataSet: dicomParser.DataSet;
  try {
    // Stop parsing right before PixelData (7FE0,0010) so partial 128 KB slice never throws
    dataSet = dicomParser.parseDicom(byteArray, { untilTag: 'x7fe00010' });
  } catch (err: unknown) {
    // dicomParser attaches partial dataSet on error if truncated inside a huge private tag
    const maybeDs = (err as { dataSet?: dicomParser.DataSet })?.dataSet;
    if (!maybeDs) return null;
    dataSet = maybeDs;
  }

  const rows = dataSet.uint16('x00280010') ?? 0;
  const columns = dataSet.uint16('x00280011') ?? 0;
  if (rows === 0 || columns === 0) {
    // Rejects DICOMDIR, Structured Reports (SR), Presentation States (PR), Key Object Selection
    return null;
  }

  const transferSyntaxUID = (dataSet.string('x00020010') ?? '1.2.840.10008.1.2').trim();
  const sopInstanceUID =
    (dataSet.string('x00080018') ?? `${entry.relativePath}-${file.size}`).trim();
  const studyInstanceUID =
    (dataSet.string('x0020000d') ?? `study-${dataSet.string('x00100020') ?? 'unknown'}`).trim();
  const seriesInstanceUID =
    (dataSet.string('x0020000e') ?? `${studyInstanceUID}-ser-${dataSet.intString('x00200011') ?? '1'}`).trim();
  const frameOfReferenceUID = (dataSet.string('x00200052') ?? '').trim();

  const modality = (dataSet.string('x00080060') ?? 'OT').trim();
  const instanceNumber = dataSet.intString('x00200013') ?? 1;
  const sliceLocation = dataSet.floatString('x00201041') ?? 0;

  const bitsAllocated = dataSet.uint16('x00280100') ?? 16;
  const bitsStored = dataSet.uint16('x00280101') ?? bitsAllocated;
  const highBit = dataSet.uint16('x00280102') ?? bitsStored - 1;
  const pixelRepresentation = dataSet.uint16('x00280103') ?? 0;
  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  const photometricInterpretation = (dataSet.string('x00280004') ?? 'MONOCHROME2').trim();
  const planarConfiguration = dataSet.uint16('x00280006') ?? 0;

  const rescaleSlope = dataSet.floatString('x00281053') ?? 1;
  const rescaleIntercept = dataSet.floatString('x00281052') ?? 0;

  const wcList = parseNumberList(dataSet.string('x00281050'));
  const wwList = parseNumberList(dataSet.string('x00281051'));
  const defaultWc = wcList[0] ?? (modality === 'CT' ? 40 : 400);
  const defaultWw = Math.max(1, wwList[0] ?? (modality === 'CT' ? 400 : 800));

  const psList = parseNumberList(dataSet.string('x00280030'));
  const pixelSpacing: [number, number] | undefined =
    psList.length >= 2 && psList[0] > 0 && psList[1] > 0 ? [psList[0], psList[1]] : undefined;

  const ipsList = parseNumberList(dataSet.string('x00181164'));
  const imagerPixelSpacing: [number, number] | undefined =
    ipsList.length >= 2 && ipsList[0] > 0 && ipsList[1] > 0 ? [ipsList[0], ipsList[1]] : undefined;

  const sliceThickness = dataSet.floatString('x00180050');
  const spacingBetweenSlices = dataSet.floatString('x00180088');

  const ippList = parseNumberList(dataSet.string('x00200032'));
  const imagePositionPatient: [number, number, number] | undefined =
    ippList.length === 3 ? [ippList[0], ippList[1], ippList[2]] : undefined;

  const iopList = parseNumberList(dataSet.string('x00200037'));
  const imageOrientationPatient: [number, number, number, number, number, number] | undefined =
    iopList.length === 6
      ? [iopList[0], iopList[1], iopList[2], iopList[3], iopList[4], iopList[5]]
      : undefined;

  const orientationPlane = classifyOrientationPlane(imageOrientationPatient, modality);
  const normalPosition = computeNormalPosition(
    imagePositionPatient,
    imageOrientationPatient,
    sliceLocation
  );

  const studyDateRaw = (dataSet.string('x00080020') ?? '').trim();
  const studyMeta: Omit<DicomStudy, 'series'> = {
    studyInstanceUID,
    studyDateRaw,
    studyDateFormatted: formatDicomDate(studyDateRaw),
    studyTime: (dataSet.string('x00080030') ?? '').trim(),
    studyDescription: (dataSet.string('x00081030') ?? `${modality} Study`).trim(),
    accessionNumber: (dataSet.string('x00080050') ?? '').trim(),
    institutionName: (dataSet.string('x00080080') ?? '').trim(),
    patientName: cleanPersonName(dataSet.string('x00100010') ?? ''),
    patientID: (dataSet.string('x00100020') ?? 'N/A').trim(),
    patientBirthDate: formatDicomDate((dataSet.string('x00100030') ?? '').trim()),
    patientAge: (dataSet.string('x00101010') ?? '').trim(),
    patientSex: (dataSet.string('x00100040') ?? '').trim(),
  };

  const seriesNumber = dataSet.intString('x00200011') ?? 1;
  const seriesDescription = (
    dataSet.string('x0008103e') ?? `${modality} Series ${seriesNumber}`
  ).trim();

  const seriesMeta: Omit<DicomSeries, 'slices' | 'isMprCapable' | 'thumbnailDataUrl'> = {
    seriesInstanceUID,
    studyInstanceUID,
    seriesNumber,
    seriesDescription,
    modality,
    bodyPartExamined: (dataSet.string('x00180015') ?? '').trim(),
    frameOfReferenceUID,
    orientationPlane,
  };

  const slice: DicomSliceRef = {
    id: `${seriesInstanceUID}::${sopInstanceUID}::${entry.relativePath}`,
    getFile: entry.getFile,
    fileName: entry.name,
    relativePath: entry.relativePath,
    transferSyntaxUID,
    sopInstanceUID,
    studyInstanceUID,
    seriesInstanceUID,
    frameOfReferenceUID,
    instanceNumber,
    sliceLocation,
    normalPosition,
    rows,
    columns,
    bitsAllocated,
    bitsStored,
    highBit,
    pixelRepresentation,
    samplesPerPixel,
    photometricInterpretation,
    planarConfiguration,
    rescaleSlope,
    rescaleIntercept,
    windowCenter: defaultWc,
    windowWidth: defaultWw,
    pixelSpacing,
    imagerPixelSpacing,
    sliceThickness,
    spacingBetweenSlices,
    imagePositionPatient,
    imageOrientationPatient,
  };

  return { slice, studyMeta, seriesMeta };
}

/** Recursively crawls a FileSystemDirectoryHandle (Chrome/Edge showDirectoryPicker) */
export async function collectFromDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  prefix = ''
): Promise<CandidateFileEntry[]> {
  const entries: CandidateFileEntry[] = [];
  // Iterate directory entries lazily without loading file contents
  const iter = (dirHandle as unknown as {
    values: () => AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }).values();

  for await (const handle of iter) {
    const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === 'file') {
      const fileHandle = handle as FileSystemFileHandle;
      entries.push({
        name: fileHandle.name,
        relativePath: rel,
        getFile: () => fileHandle.getFile(),
      });
    } else if (handle.kind === 'directory') {
      const sub = await collectFromDirectoryHandle(handle as FileSystemDirectoryHandle, rel);
      for (const item of sub) entries.push(item);
    }
  }
  return entries;
}

/** Recursively crawls DataTransferItemList from Drag-and-Drop folders (reading all 100-item batches) */
export async function collectFromDataTransfer(items: DataTransferItemList): Promise<CandidateFileEntry[]> {
  const out: CandidateFileEntry[] = [];

  async function traverseEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      out.push({
        name: fileEntry.name,
        relativePath: rel,
        getFile: () =>
          new Promise<File>((resolve, reject) => {
            fileEntry.file(resolve, reject);
          }),
      });
    } else if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 entries per call in Chromium; loop until empty
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          dirReader.readEntries(resolve, reject);
        });
        if (!batch || batch.length === 0) break;
        for (const child of batch) {
          await traverseEntry(child, rel);
        }
      }
    }
  }

  const rootEntries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (entry) rootEntries.push(entry);
    else if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) {
        out.push({
          name: f.name,
          relativePath: f.webkitRelativePath || f.name,
          getFile: async () => f,
        });
      }
    }
  }

  for (const entry of rootEntries) {
    await traverseEntry(entry, '');
  }
  return out;
}

export function collectFromFileList(files: FileList | File[]): CandidateFileEntry[] {
  const arr = Array.from(files);
  return arr.map((f) => ({
    name: f.name,
    relativePath: f.webkitRelativePath || f.name,
    getFile: async () => f,
  }));
}

/** Indexes chaotic DICOM folders with bounded concurrency & sorts chronologically */
export async function indexDicomEntries(
  candidates: CandidateFileEntry[],
  existingStudies: DicomStudy[],
  onProgress?: (p: ScanProgress) => void
): Promise<DicomStudy[]> {
  const studyMap = new Map<string, DicomStudy>();
  const seriesMap = new Map<string, DicomSeries>();
  const seenSopIds = new Set<string>();

  for (const st of existingStudies) {
    studyMap.set(st.studyInstanceUID, {
      ...st,
      series: st.series.map((s) => ({ ...s, slices: [...s.slices] })),
    });
    for (const ser of studyMap.get(st.studyInstanceUID)!.series) {
      seriesMap.set(ser.seriesInstanceUID, ser);
      for (const sl of ser.slices) seenSopIds.add(sl.sopInstanceUID);
    }
  }

  let scannedFiles = 0;
  let validDicomSlices = 0;
  let skippedJunkFiles = 0;
  const concurrency = 16;

  for (let i = 0; i < candidates.length; i += concurrency) {
    const chunk = candidates.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((c) => parseCandidateHeader(c)));
    for (let j = 0; j < results.length; j++) {
      scannedFiles++;
      const parsed = results[j];
      if (!parsed) {
        skippedJunkFiles++;
        continue;
      }
      if (seenSopIds.has(parsed.slice.sopInstanceUID)) {
        continue;
      }
      seenSopIds.add(parsed.slice.sopInstanceUID);
      validDicomSlices++;

      let study = studyMap.get(parsed.studyMeta.studyInstanceUID);
      if (!study) {
        study = { ...parsed.studyMeta, series: [] };
        studyMap.set(study.studyInstanceUID, study);
      }

      let series = seriesMap.get(parsed.seriesMeta.seriesInstanceUID);
      if (!series) {
        series = {
          ...parsed.seriesMeta,
          slices: [],
          isMprCapable: false,
        };
        seriesMap.set(series.seriesInstanceUID, series);
        study.series.push(series);
      }
      series.slices.push(parsed.slice);
    }

    if (onProgress) {
      onProgress({
        scannedFiles,
        totalCandidateFiles: candidates.length,
        validDicomSlices,
        skippedJunkFiles,
        currentPath: chunk[chunk.length - 1]?.relativePath ?? '',
      });
    }
  }

  // Deterministically sort slices within each series, series within studies, and studies chronologically
  const allStudies = Array.from(studyMap.values());
  for (const study of allStudies) {
    for (const series of study.series) {
      const hasDistinctNormal =
        series.slices.length > 1 &&
        Math.abs(series.slices[0].normalPosition - series.slices[series.slices.length - 1].normalPosition) > 0.01;

      series.slices.sort((a, b) => {
        if (hasDistinctNormal && Math.abs(a.normalPosition - b.normalPosition) > 1e-4) {
          return a.normalPosition - b.normalPosition;
        }
        if (Math.abs(a.sliceLocation - b.sliceLocation) > 1e-4) {
          return a.sliceLocation - b.sliceLocation;
        }
        return a.instanceNumber - b.instanceNumber;
      });

      const first = series.slices[0];
      series.isMprCapable =
        series.slices.length >= 8 &&
        Boolean(first?.pixelSpacing) &&
        Boolean(first?.imagePositionPatient) &&
        series.slices[0].samplesPerPixel === 1;
    }

    study.series.sort((a, b) => a.seriesNumber - b.seriesNumber);
  }

  // Sort chronologically (Pre-Incident -> Post-Incident -> Post-Op), grouped by Patient
  allStudies.sort((a, b) => {
    const patCmp = a.patientName.localeCompare(b.patientName);
    if (patCmp !== 0) return patCmp;
    return (a.studyDateRaw || '99999999').localeCompare(b.studyDateRaw || '99999999');
  });

  return allStudies;
}
