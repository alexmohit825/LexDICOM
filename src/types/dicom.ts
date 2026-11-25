export type ToolMode =
  | 'stackScroll'
  | 'windowLevel'
  | 'pan'
  | 'zoom'
  | 'length'
  | 'angle'
  | 'cobb'
  | 'ellipse'
  | 'probe'
  | 'arrow'
  | 'spineLabel'
  | 'calibrate';

export type GridLayout = '1x1' | '1x2' | '2x2' | '2x3';

export type OrientationPlane = 'SAGITTAL' | 'AXIAL' | 'CORONAL' | 'OBLIQUE' | 'PROJECTION';

export interface MouseButtonBindings {
  left: ToolMode;
  middle: ToolMode;
  right: ToolMode;
  wheel: 'stackScroll' | 'zoom';
}

export interface DicomSliceRef {
  id: string;
  getFile: () => Promise<File>;
  fileName: string;
  relativePath: string;
  transferSyntaxUID: string;
  sopInstanceUID: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameOfReferenceUID: string;
  instanceNumber: number;
  sliceLocation: number;
  normalPosition: number;
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  photometricInterpretation: string;
  planarConfiguration: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  windowCenter: number;
  windowWidth: number;
  /** Calibrated physical spacing [rowMm, colMm] from (0028,0030) */
  pixelSpacing?: [number, number];
  /** Uncalibrated detector spacing [rowMm, colMm] from (0018,1164) on plain radiographs */
  imagerPixelSpacing?: [number, number];
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
}

export interface DicomSeries {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  seriesNumber: number;
  seriesDescription: string;
  modality: string;
  bodyPartExamined: string;
  frameOfReferenceUID: string;
  orientationPlane: OrientationPlane;
  slices: DicomSliceRef[];
  thumbnailDataUrl?: string;
  isMprCapable: boolean;
}

export interface DicomStudy {
  studyInstanceUID: string;
  studyDateRaw: string;
  studyDateFormatted: string;
  studyTime: string;
  studyDescription: string;
  accessionNumber: string;
  institutionName: string;
  patientName: string;
  patientID: string;
  patientBirthDate: string;
  patientAge: string;
  patientSex: string;
  series: DicomSeries[];
}

export interface DecodedSlice {
  sliceId: string;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  photometricInterpretation: string;
  /** Rescaled clinical values (e.g. Hounsfield Units or MR signal intensity) */
  scalarData: Float32Array;
  /** Present if RGB color image */
  rgbData?: Uint8ClampedArray;
  minValue: number;
  maxValue: number;
  defaultWindowCenter: number;
  defaultWindowWidth: number;
  byteLength: number;
}

export interface Point2D {
  x: number; // Image column coordinate (px)
  y: number; // Image row coordinate (px)
}

export interface ViewportAnnotation {
  id: string;
  sliceId: string;
  type: 'length' | 'angle' | 'cobb' | 'ellipse' | 'probe' | 'arrow' | 'spineLabel' | 'calibrate';
  points: Point2D[];
  color: string;
  label?: string;
  knownMm?: number;
}

export interface SchwabLandmarks {
  femoralHead?: Point2D;
  s1Post?: Point2D;
  s1Ant?: Point2D;
  l1SupPost?: Point2D;
  l1SupAnt?: Point2D;
  t1SupPost?: Point2D;
  t1SupAnt?: Point2D;
  c7Centroid?: Point2D;
  uivInfPost?: Point2D;
  uivInfAnt?: Point2D;
  uiv2SupPost?: Point2D;
  uiv2SupAnt?: Point2D;
}

export type SchwabStepKey =
  | 'femoralHead'
  | 's1Post'
  | 's1Ant'
  | 'l1SupPost'
  | 'l1SupAnt'
  | 't1SupPost'
  | 't1SupAnt'
  | 'c7Centroid'
  | 'uivInfPost'
  | 'uivInfAnt'
  | 'uiv2SupPost'
  | 'uiv2SupAnt';

export interface ViewportState {
  panelIndex: number;
  studyInstanceUID: string | null;
  seriesInstanceUID: string | null;
  sliceIndex: number;
  windowCenter: number;
  windowWidth: number;
  zoom: number;
  panX: number;
  panY: number;
  invert: boolean;
  exhibitBanner: string;
  /** Manual pixel spacing override [rowMm, colMm] set via Known-Length Calibration */
  manualCalibrationMmPerPx?: number;
  annotations: ViewportAnnotation[];
  schwabLandmarks: SchwabLandmarks;
}

export interface ExhibitConfig {
  enabled: boolean;
  scrubPhi: boolean;
  caseCaption: string;
  exhibitTitle: string;
  annotationColor: string;
  activeSpineTag: string;
  showScoutLines: boolean;
}
