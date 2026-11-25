import { CandidateFileEntry } from './folderScanner';

interface DicomTagSpec {
  group: number;
  element: number;
  vr: string;
  value: string | number | Uint8Array | Uint16Array;
}

const LONG_LENGTH_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

function encodeTag(spec: DicomTagSpec): Uint8Array {
  let payload: Uint8Array;
  const enc = new TextEncoder();

  if (typeof spec.value === 'string') {
    const raw = enc.encode(spec.value);
    const padByte = spec.vr === 'UI' ? 0x00 : 0x20;
    if (raw.byteLength % 2 === 1) {
      payload = new Uint8Array(raw.byteLength + 1);
      payload.set(raw);
      payload[raw.byteLength] = padByte;
    } else {
      payload = raw;
    }
  } else if (typeof spec.value === 'number') {
    if (spec.vr === 'US') {
      payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, spec.value, true);
    } else {
      const str = String(spec.value);
      return encodeTag({ ...spec, vr: spec.vr === 'UL' ? 'IS' : spec.vr, value: str });
    }
  } else if (spec.value instanceof Uint16Array) {
    payload = new Uint8Array(spec.value.byteLength);
    const dv = new DataView(payload.buffer);
    for (let i = 0; i < spec.value.length; i++) {
      dv.setUint16(i * 2, spec.value[i], true);
    }
  } else {
    payload = spec.value;
  }

  const isLong = LONG_LENGTH_VRS.has(spec.vr);
  const headerLen = isLong ? 12 : 8;
  const out = new Uint8Array(headerLen + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, spec.group, true);
  dv.setUint16(2, spec.element, true);
  out[4] = spec.vr.charCodeAt(0);
  out[5] = spec.vr.charCodeAt(1);
  if (isLong) {
    dv.setUint16(6, 0, true);
    dv.setUint32(8, payload.byteLength, true);
  } else {
    dv.setUint16(6, payload.byteLength, true);
  }
  out.set(payload, headerLen);
  return out;
}

/** Builds a standards-compliant Explicit VR Little Endian DICOM Part-10 binary file */
function buildDicomPart10File(tags: DicomTagSpec[], pixels: Uint16Array): Uint8Array {
  const metaTags: DicomTagSpec[] = [
    { group: 0x0002, element: 0x0001, vr: 'OB', value: new Uint8Array([0x00, 0x01]) },
    { group: 0x0002, element: 0x0002, vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.4' },
    { group: 0x0002, element: 0x0010, vr: 'UI', value: '1.2.840.10008.1.2.1' },
    { group: 0x0002, element: 0x0012, vr: 'UI', value: '1.2.826.0.1.3680043.9.7400.1' },
  ];

  const encodedMeta = metaTags.map(encodeTag);
  const metaLen = encodedMeta.reduce((acc, b) => acc + b.byteLength, 0);
  const groupLenBytes = new Uint8Array(4);
  new DataView(groupLenBytes.buffer).setUint32(0, metaLen, true);
  const groupLenTag = encodeTag({ group: 0x0002, element: 0x0000, vr: 'UL', value: groupLenBytes });

  // Fix UL length header manually (UL is 8-byte short VR)
  const ulTag = new Uint8Array(12);
  const ulDv = new DataView(ulTag.buffer);
  ulDv.setUint16(0, 0x0002, true);
  ulDv.setUint16(2, 0x0000, true);
  ulTag[4] = 'U'.charCodeAt(0);
  ulTag[5] = 'L'.charCodeAt(0);
  ulDv.setUint16(6, 4, true);
  ulDv.setUint32(8, metaLen, true);
  void groupLenTag;

  const sortedBody = [...tags, { group: 0x7fe0, element: 0x0010, vr: 'OW', value: pixels }].sort(
    (a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element)
  );
  const encodedBody = sortedBody.map(encodeTag);

  const totalBytes =
    132 +
    ulTag.byteLength +
    metaLen +
    encodedBody.reduce((acc, b) => acc + b.byteLength, 0);

  const fileBytes = new Uint8Array(totalBytes);
  fileBytes[128] = 0x44; // D
  fileBytes[129] = 0x49; // I
  fileBytes[130] = 0x43; // C
  fileBytes[131] = 0x4d; // M

  let offset = 132;
  fileBytes.set(ulTag, offset);
  offset += ulTag.byteLength;
  for (const b of encodedMeta) {
    fileBytes.set(b, offset);
    offset += b.byteLength;
  }
  for (const b of encodedBody) {
    fileBytes.set(b, offset);
    offset += b.byteLength;
  }
  return fileBytes;
}

function drawSagittalLumbarSlice(
  cols: number,
  rows: number,
  sliceOffsetMm: number,
  postIncidentExtrusion: boolean
): Uint16Array {
  const buf = new Uint16Array(cols * rows);
  const midFade = Math.exp(-(sliceOffsetMm * sliceOffsetMm) / 180);

  // Background subcutaneous & paraspinal signal
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let val = 60;
      if (x > cols * 0.18 && x < cols * 0.86) {
        // Posterior subcutaneous adipose bright T2 band
        if (x > cols * 0.74) val = 620;
        else if (x > cols * 0.58) val = 240; // Paraspinal muscle
        else val = 170;
      }
      buf[y * cols + x] = val;
    }
  }

  // CSF thecal sac bright T2 column along lordotic curve
  for (let y = 24; y < rows - 20; y++) {
    const t = y / rows;
    const curveX = cols * 0.49 - Math.sin(t * Math.PI) * 24;
    const canalHalfW = 9 * midFade + 2;
    for (let x = Math.floor(curveX - canalHalfW); x <= Math.ceil(curveX + canalHalfW); x++) {
      if (x >= 0 && x < cols) {
        const dist = Math.abs(x - curveX) / canalHalfW;
        // Cauda equina nerve rootlets inside bright CSF
        const rootlet = Math.abs(Math.sin((x - curveX) * 1.4)) < 0.25 ? 210 : 0;
        buf[y * cols + x] = Math.max(180, Math.round((890 * (1 - dist * 0.35) - rootlet) * midFade + 140));
      }
    }
  }

  // L1 through S1 vertebral bodies + intervertebral discs
  const levels = [
    { name: 'L1', cy: 48, h: 24 },
    { name: 'L2', cy: 84, h: 25 },
    { name: 'L3', cy: 122, h: 26 },
    { name: 'L4', cy: 162, h: 26 },
    { name: 'L5', cy: 202, h: 25 },
    { name: 'S1', cy: 238, h: 24 },
  ];

  for (let idx = 0; idx < levels.length; idx++) {
    const lv = levels[idx];
    const t = lv.cy / rows;
    const cx = cols * 0.37 - Math.sin(t * Math.PI) * 24;
    const w = 36;

    // Cancellous marrow + cortical rim
    for (let y = Math.round(lv.cy - lv.h / 2); y <= Math.round(lv.cy + lv.h / 2); y++) {
      if (y < 0 || y >= rows) continue;
      for (let x = Math.round(cx - w / 2); x <= Math.round(cx + w / 2); x++) {
        if (x < 0 || x >= cols) continue;
        const rim =
          Math.abs(y - (lv.cy - lv.h / 2)) <= 1.5 ||
          Math.abs(y - (lv.cy + lv.h / 2)) <= 1.5 ||
          Math.abs(x - (cx - w / 2)) <= 1.5 ||
          Math.abs(x - (cx + w / 2)) <= 1.5;
        buf[y * cols + x] = rim ? 95 : Math.round(430 * (0.75 + 0.25 * midFade));
      }
    }

    // Intervertebral disc below level
    if (idx < levels.length - 1) {
      const next = levels[idx + 1];
      const discY = (lv.cy + next.cy) / 2;
      const discH = 9;
      const isL4L5 = lv.name === 'L4';
      const hydrated = !isL4L5 || !postIncidentExtrusion;

      for (let y = Math.round(discY - discH / 2); y <= Math.round(discY + discH / 2); y++) {
        if (y < 0 || y >= rows) continue;
        for (let x = Math.round(cx - w / 2); x <= Math.round(cx + w / 2); x++) {
          if (x < 0 || x >= cols) continue;
          const nx = (x - cx) / (w / 2);
          const ny = (y - discY) / (discH / 2);
          const r2 = nx * nx + ny * ny;
          if (r2 <= 1.05) {
            // Annulus dark (110), hydrated nucleus bright T2 (760), desiccated post-MVC L4-L5 dark (210)
            buf[y * cols + x] = r2 > 0.62 ? 115 : hydrated ? Math.round(760 * midFade + 150) : 215;
          }
        }
      }

      // Post-incident L4-L5 posterior paracentral disc extrusion indenting bright CSF thecal sac!
      if (isL4L5 && postIncidentExtrusion && Math.abs(sliceOffsetMm + 2) < 9) {
        const extCx = cx + w / 2 + 5.5;
        const extCy = discY + 1;
        for (let y = Math.round(extCy - 8); y <= Math.round(extCy + 8); y++) {
          for (let x = Math.round(extCx - 8); x <= Math.round(extCx + 9); x++) {
            if (x >= 0 && x < cols && y >= 0 && y < rows) {
              const d = Math.hypot((x - extCx) / 7.5, (y - extCy) / 6.5);
              if (d <= 1.0) {
                buf[y * cols + x] = d > 0.75 ? 95 : 195;
              }
            }
          }
        }
      }
    }
  }

  return buf;
}

function drawAxialLumbarSlice(
  cols: number,
  rows: number,
  zOffsetFromDiscMm: number,
  postIncidentExtrusion: boolean
): Uint16Array {
  const buf = new Uint16Array(cols * rows);
  const cx = cols / 2;
  const cy = rows * 0.48;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // Body contour ellipse
      const bx = (x - cx) / (cols * 0.43);
      const by = (y - cy) / (rows * 0.34);
      const b2 = bx * bx + by * by;
      let val = 35;
      if (b2 <= 1.0) {
        val = b2 > 0.84 ? 590 : 210; // Subcutaneous fat rim + psoas/paraspinal soft tissue
      }

      // Disc / vertebral body anterior oval
      const vx = (x - cx) / 36;
      const vy = (y - (cy - 18)) / 27;
      const v2 = vx * vx + vy * vy;
      const isDiscPlane = Math.abs(zOffsetFromDiscMm) < 6;
      if (v2 <= 1.0) {
        if (isDiscPlane) {
          val = v2 > 0.65 ? 120 : postIncidentExtrusion ? 225 : 740;
        } else {
          val = v2 > 0.86 ? 95 : 420;
        }
      }

      // Spinal canal / bright T2 thecal sac posterior to disc
      const sx = (x - cx) / 15;
      const sy = (y - (cy + 15)) / 12;
      const s2 = sx * sx + sy * sy;
      if (s2 <= 1.0) {
        val = 880;
      }

      // Left paracentral L4-L5 extrusion (radiological left = image right, x > cx)
      if (postIncidentExtrusion && Math.abs(zOffsetFromDiscMm) < 5.5) {
        const ex = (x - (cx + 5.5)) / 9.5;
        const ey = (y - (cy + 9.5)) / 7.5;
        if (ex * ex + ey * ey <= 1.0) {
          val = 155;
        }
      }

      // Lamina & spinous process
      if (Math.abs(x - cx) < 5 && y > cy + 26 && y < cy + 56) {
        val = 360;
      }
      buf[y * cols + x] = val;
    }
  }
  return buf;
}

function drawStandingLateralRadiograph(cols: number, rows: number): Uint16Array {
  const buf = new Uint16Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let val = 85;
      // Soft tissue silhouette
      if (x > cols * 0.2 && x < cols * 0.82) val = 230;
      buf[y * cols + x] = val;
    }
  }

  // Spine column from C7 (top) through T1..L5 to S1 & bicoxofemoral heads (facing right -> anterior is +x)
  for (let i = 0; i < 19; i++) {
    const t = i / 18; // 0 = C7, 1 = L5
    const cy = 36 + t * 226;
    // Positive sagittal balance: C7 shifted anterior (+x) relative to S1 posterior corner
    const kyphosisLordosis = Math.sin(t * Math.PI * 1.85) * 18;
    const cx = cols * 0.56 - t * 24 - kyphosisLordosis;
    const w = 18 + t * 10;
    const h = 9 + t * 3;
    for (let y = Math.round(cy - h / 2); y <= Math.round(cy + h / 2); y++) {
      for (let x = Math.round(cx - w / 2); x <= Math.round(cx + w / 2); x++) {
        if (x >= 0 && x < cols && y >= 0 && y < rows) {
          const edge =
            Math.abs(y - (cy - h / 2)) <= 1.2 ||
            Math.abs(y - (cy + h / 2)) <= 1.2 ||
            Math.abs(x - (cx - w / 2)) <= 1.2 ||
            Math.abs(x - (cx + w / 2)) <= 1.2;
          buf[y * cols + x] = edge ? 940 : 690;
        }
      }
    }
  }

  // Sacrum S1 tilted ~36 deg downward-anterior (+x, +y)
  const s1PostX = cols * 0.44;
  const s1PostY = 278;
  const s1SlopeRad = (36 * Math.PI) / 180;
  for (let s = 0; s <= 30; s++) {
    const ex = s1PostX + Math.cos(s1SlopeRad) * s;
    const ey = s1PostY + Math.sin(s1SlopeRad) * s;
    for (let d = 0; d < 22; d++) {
      const px = Math.round(ex - Math.sin(s1SlopeRad) * d * 0.7);
      const py = Math.round(ey + Math.cos(s1SlopeRad) * d);
      if (px >= 0 && px < cols && py >= 0 && py < rows) {
        buf[py * cols + px] = d <= 2 ? 960 : 710;
      }
    }
  }

  // Femoral Heads (bicoxofemoral center anterior-inferior to S1)
  const fhX = s1PostX + 26;
  const fhY = s1PostY + 46;
  for (let y = Math.round(fhY - 18); y <= Math.round(fhY + 18); y++) {
    for (let x = Math.round(fhX - 18); x <= Math.round(fhX + 18); x++) {
      const r = Math.hypot(x - fhX, y - fhY);
      if (r <= 17 && x >= 0 && x < cols && y >= 0 && y < rows) {
        buf[y * cols + x] = r > 14 ? 950 : 720;
      }
    }
  }

  // 25.0 mm Radiopaque Steel Calibration Sphere (radius = 12.5 px -> 25.0 px diameter => 1.0 mm/px)
  const calCx = 46;
  const calCy = 180;
  for (let y = calCy - 14; y <= calCy + 14; y++) {
    for (let x = calCx - 14; x <= calCx + 14; x++) {
      if (Math.hypot(x - calCx, y - calCy) <= 12.5) {
        buf[y * cols + x] = 995;
      }
    }
  }

  return buf;
}

/**
 * Generates real binary DICOM Part-10 files in chaotic legal-firm subfolder paths
 * (including extensionless `IM00001` filenames) for instant zero-PHI verification.
 */
export function buildSampleLegalCaseEntries(): CandidateFileEntry[] {
  const entries: CandidateFileEntry[] = [];
  const patientTags: DicomTagSpec[] = [
    { group: 0x0010, element: 0x0010, vr: 'PN', value: 'VANCE^MARCUS^E' },
    { group: 0x0010, element: 0x0020, vr: 'LO', value: 'ML-2024-0891' },
    { group: 0x0010, element: 0x0030, vr: 'DA', value: '19740519' },
    { group: 0x0010, element: 0x0040, vr: 'CS', value: 'M' },
    { group: 0x0010, element: 0x1010, vr: 'AS', value: '050Y' },
    { group: 0x0008, element: 0x0080, vr: 'LO', value: 'PACIFIC NORTHWEST IMAGING CENTER' },
  ];

  const studies = [
    {
      studyUID: '1.2.826.0.1.3680043.9.7400.100.20220314',
      forUID: '1.2.826.0.1.3680043.9.7400.900.1',
      date: '20220314',
      desc: 'MRI LUMBAR SPINE W/O CONTRAST (PRE-INCIDENT)',
      folder: 'Bates_001_2022_PriorRecords/CDROM/DICOM/PA0001',
      postIncident: false,
    },
    {
      studyUID: '1.2.826.0.1.3680043.9.7400.100.20240908',
      forUID: '1.2.826.0.1.3680043.9.7400.900.1', // Co-registered RCS for instant comparison
      date: '20240908',
      desc: 'MRI LUMBAR SPINE W/O CONTRAST (POST-MVC)',
      folder: 'Plaintiff_Production_Supp2/Hospital_Disc2/IMAGES',
      postIncident: true,
    },
  ];

  for (const st of studies) {
    // Series 1: Sagittal T2 (13 slices, X = -18..+18 mm, Y = AP, Z = SI)
    const sagCols = 256;
    const sagRows = 256;
    for (let i = 0; i < 13; i++) {
      const xMm = (i - 6) * 3.0;
      const pixels = drawSagittalLumbarSlice(sagCols, sagRows, xMm, st.postIncident);
      const bytes = buildDicomPart10File(
        [
          ...patientTags,
          { group: 0x0008, element: 0x0018, vr: 'UI', value: `${st.studyUID}.1.${i + 1}` },
          { group: 0x0008, element: 0x0020, vr: 'DA', value: st.date },
          { group: 0x0008, element: 0x0030, vr: 'TM', value: '101500' },
          { group: 0x0008, element: 0x0060, vr: 'CS', value: 'MR' },
          { group: 0x0008, element: 0x1030, vr: 'LO', value: st.desc },
          { group: 0x0008, element: 0x103e, vr: 'LO', value: 'SAG T2 FRFSE' },
          { group: 0x0018, element: 0x0015, vr: 'CS', value: 'LSPINE' },
          { group: 0x0018, element: 0x0050, vr: 'DS', value: '3.0' },
          { group: 0x0018, element: 0x0088, vr: 'DS', value: '3.0' },
          { group: 0x0020, element: 0x000d, vr: 'UI', value: st.studyUID },
          { group: 0x0020, element: 0x000e, vr: 'UI', value: `${st.studyUID}.101` },
          { group: 0x0020, element: 0x0011, vr: 'IS', value: '1' },
          { group: 0x0020, element: 0x0013, vr: 'IS', value: String(i + 1) },
          { group: 0x0020, element: 0x0032, vr: 'DS', value: `${xMm.toFixed(1)}\\-128.0\\128.0` },
          { group: 0x0020, element: 0x0037, vr: 'DS', value: '0\\1\\0\\0\\0\\-1' },
          { group: 0x0020, element: 0x0052, vr: 'UI', value: st.forUID },
          { group: 0x0020, element: 0x1041, vr: 'DS', value: xMm.toFixed(1) },
          { group: 0x0028, element: 0x0002, vr: 'US', value: 1 },
          { group: 0x0028, element: 0x0004, vr: 'CS', value: 'MONOCHROME2' },
          { group: 0x0028, element: 0x0010, vr: 'US', value: sagRows },
          { group: 0x0028, element: 0x0011, vr: 'US', value: sagCols },
          { group: 0x0028, element: 0x0030, vr: 'DS', value: '1.0\\1.0' },
          { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
          { group: 0x0028, element: 0x0101, vr: 'US', value: 16 },
          { group: 0x0028, element: 0x0102, vr: 'US', value: 15 },
          { group: 0x0028, element: 0x0103, vr: 'US', value: 0 },
          { group: 0x0028, element: 0x1050, vr: 'DS', value: '450' },
          { group: 0x0028, element: 0x1051, vr: 'DS', value: '900' },
        ],
        pixels
      );
      // Deliberately extensionless hospital CD filename (`IM00001`)
      const fname = `IM${String(i + 1).padStart(5, '0')}`;
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      entries.push({
        name: fname,
        relativePath: `${st.folder}/SER01/${fname}`,
        getFile: async () => new File([ab], fname),
      });
    }

    // Series 2: Axial T2 through L4-L5 disc space (Z centered around y=182 -> Z = 128 - 182 = -54 mm)
    const axCols = 224;
    const axRows = 224;
    for (let i = 0; i < 12; i++) {
      const zOff = (i - 5.5) * 3.0;
      const zWorld = -54.0 - zOff;
      const pixels = drawAxialLumbarSlice(axCols, axRows, zOff, st.postIncident);
      const bytes = buildDicomPart10File(
        [
          ...patientTags,
          { group: 0x0008, element: 0x0018, vr: 'UI', value: `${st.studyUID}.2.${i + 1}` },
          { group: 0x0008, element: 0x0020, vr: 'DA', value: st.date },
          { group: 0x0008, element: 0x0030, vr: 'TM', value: '102200' },
          { group: 0x0008, element: 0x0060, vr: 'CS', value: 'MR' },
          { group: 0x0008, element: 0x1030, vr: 'LO', value: st.desc },
          { group: 0x0008, element: 0x103e, vr: 'LO', value: 'AX T2 L4-L5 DISC' },
          { group: 0x0018, element: 0x0015, vr: 'CS', value: 'LSPINE' },
          { group: 0x0018, element: 0x0050, vr: 'DS', value: '3.0' },
          { group: 0x0018, element: 0x0088, vr: 'DS', value: '3.0' },
          { group: 0x0020, element: 0x000d, vr: 'UI', value: st.studyUID },
          { group: 0x0020, element: 0x000e, vr: 'UI', value: `${st.studyUID}.102` },
          { group: 0x0020, element: 0x0011, vr: 'IS', value: '2' },
          { group: 0x0020, element: 0x0013, vr: 'IS', value: String(i + 1) },
          { group: 0x0020, element: 0x0032, vr: 'DS', value: `-112.0\\-112.0\\${zWorld.toFixed(1)}` },
          { group: 0x0020, element: 0x0037, vr: 'DS', value: '1\\0\\0\\0\\1\\0' },
          { group: 0x0020, element: 0x0052, vr: 'UI', value: st.forUID },
          { group: 0x0020, element: 0x1041, vr: 'DS', value: zWorld.toFixed(1) },
          { group: 0x0028, element: 0x0002, vr: 'US', value: 1 },
          { group: 0x0028, element: 0x0004, vr: 'CS', value: 'MONOCHROME2' },
          { group: 0x0028, element: 0x0010, vr: 'US', value: axRows },
          { group: 0x0028, element: 0x0011, vr: 'US', value: axCols },
          { group: 0x0028, element: 0x0030, vr: 'DS', value: '1.0\\1.0' },
          { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
          { group: 0x0028, element: 0x0101, vr: 'US', value: 16 },
          { group: 0x0028, element: 0x0102, vr: 'US', value: 15 },
          { group: 0x0028, element: 0x0103, vr: 'US', value: 0 },
          { group: 0x0028, element: 0x1050, vr: 'DS', value: '450' },
          { group: 0x0028, element: 0x1051, vr: 'DS', value: '900' },
        ],
        pixels
      );
      const fname = `AX${String(i + 1).padStart(4, '0')}`;
      const axAb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      entries.push({
        name: fname,
        relativePath: `${st.folder}/SER02/${fname}`,
        getFile: async () => new File([axAb], fname),
      });
    }
  }

  // Study 3: Standing Full-Spine Lateral Radiograph (only ImagerPixelSpacing -> tests Calibration Gate!)
  const xrCols = 256;
  const xrRows = 360;
  const xrPixels = drawStandingLateralRadiograph(xrCols, xrRows);
  const xrStudyUID = '1.2.826.0.1.3680043.9.7400.100.20240920';
  const xrBytes = buildDicomPart10File(
    [
      ...patientTags,
      { group: 0x0008, element: 0x0018, vr: 'UI', value: `${xrStudyUID}.1.1` },
      { group: 0x0008, element: 0x0020, vr: 'DA', value: '20240920' },
      { group: 0x0008, element: 0x0030, vr: 'TM', value: '141000' },
      { group: 0x0008, element: 0x0060, vr: 'CS', value: 'DX' },
      { group: 0x0008, element: 0x1030, vr: 'LO', value: 'XR SCOLIOSIS STANDING LATERAL (25MM MARKER)' },
      { group: 0x0008, element: 0x103e, vr: 'LO', value: 'STANDING LATERAL FULL SPINE' },
      { group: 0x0018, element: 0x0015, vr: 'CS', value: 'SPINE' },
      { group: 0x0018, element: 0x1164, vr: 'DS', value: '1.15\\1.15' }, // Detector spacing (uncalibrated magnification!)
      { group: 0x0020, element: 0x000d, vr: 'UI', value: xrStudyUID },
      { group: 0x0020, element: 0x000e, vr: 'UI', value: `${xrStudyUID}.201` },
      { group: 0x0020, element: 0x0011, vr: 'IS', value: '1' },
      { group: 0x0020, element: 0x0013, vr: 'IS', value: '1' },
      { group: 0x0028, element: 0x0002, vr: 'US', value: 1 },
      { group: 0x0028, element: 0x0004, vr: 'CS', value: 'MONOCHROME2' },
      { group: 0x0028, element: 0x0010, vr: 'US', value: xrRows },
      { group: 0x0028, element: 0x0011, vr: 'US', value: xrCols },
      { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
      { group: 0x0028, element: 0x0101, vr: 'US', value: 16 },
      { group: 0x0028, element: 0x0102, vr: 'US', value: 15 },
      { group: 0x0028, element: 0x0103, vr: 'US', value: 0 },
      { group: 0x0028, element: 0x1050, vr: 'DS', value: '500' },
      { group: 0x0028, element: 0x1051, vr: 'DS', value: '1000' },
    ],
    xrPixels
  );
  const xrAb = xrBytes.buffer.slice(xrBytes.byteOffset, xrBytes.byteOffset + xrBytes.byteLength) as ArrayBuffer;
  entries.push({
    name: 'IM00099',
    relativePath: 'Standing_Alignment_XRay/DICOM/IM00099',
    getFile: async () => new File([xrAb], 'IM00099'),
  });

  // Simulated hospital CD junk file to verify automatic junk filtering
  entries.push({
    name: 'AUTORUN.INF',
    relativePath: 'Bates_001_2022_PriorRecords/CDROM/AUTORUN.INF',
    getFile: async () => new File(['[autorun]\nopen=viewer.exe'], 'AUTORUN.INF'),
  });

  return entries;
}
