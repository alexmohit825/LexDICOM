import React from 'react';
import { AlertTriangle, CheckCircle2, Crosshair, RotateCcw, Ruler, X } from 'lucide-react';
import { DicomSliceRef, SchwabLandmarks, SchwabStepKey, ToolMode } from '../types/dicom';
import { computeSchwabMetrics } from '../engine/schwabMath';

interface SrsSchwabDrawerProps {
  open: boolean;
  onClose: () => void;
  landmarks: SchwabLandmarks;
  activeStep: SchwabStepKey | null;
  onSelectStep: (step: SchwabStepKey | null) => void;
  onClearLandmarks: () => void;
  activeSlice: DicomSliceRef | null;
  manualCalibrationMmPerPx?: number;
  onActivateCalibrationTool: (tool: ToolMode) => void;
  onClearManualCalibration: () => void;
}

const LANDMARK_STEPS: { key: SchwabStepKey; label: string; hint: string }[] = [
  { key: 'femoralHead', label: '1. Femoral Head Axis', hint: 'Click center of femoral heads (or bicoxofemoral midpoint)' },
  { key: 's1Post', label: '2a. S1 Post-Sup Corner', hint: 'Posterior-superior corner of S1 endplate' },
  { key: 's1Ant', label: '2b. S1 Ant-Sup Corner', hint: 'Anterior-superior corner of S1 endplate' },
  { key: 'l1SupPost', label: '3a. L1 Sup-Post Corner', hint: 'Posterior-superior corner of L1 endplate' },
  { key: 'l1SupAnt', label: '3b. L1 Sup-Ant Corner', hint: 'Anterior-superior corner of L1 endplate' },
  { key: 't1SupPost', label: '4a. T1/T4 Sup-Post', hint: 'Posterior-superior corner of T1 or T4' },
  { key: 't1SupAnt', label: '4b. T1/T4 Sup-Ant', hint: 'Anterior-superior corner of T1 or T4' },
  { key: 'c7Centroid', label: '5. C7 Vertebral Centroid', hint: 'Drops vertical C7 Plumb Line to S1' },
  { key: 'uivInfPost', label: '6a. UIV Inf-Post (PJK)', hint: 'Optional: UIV inferior endplate posterior' },
  { key: 'uivInfAnt', label: '6b. UIV Inf-Ant (PJK)', hint: 'Optional: UIV inferior endplate anterior' },
  { key: 'uiv2SupPost', label: '7a. UIV+2 Sup-Post', hint: 'Optional: UIV+2 superior endplate posterior' },
  { key: 'uiv2SupAnt', label: '7b. UIV+2 Sup-Ant', hint: 'Optional: UIV+2 superior endplate anterior' },
];

export const SrsSchwabDrawer: React.FC<SrsSchwabDrawerProps> = ({
  open,
  onClose,
  landmarks,
  activeStep,
  onSelectStep,
  onClearLandmarks,
  activeSlice,
  manualCalibrationMmPerPx,
  onActivateCalibrationTool,
  onClearManualCalibration,
}) => {
  if (!open) return null;

  const metrics = computeSchwabMetrics(
    landmarks,
    activeSlice?.pixelSpacing,
    manualCalibrationMmPerPx
  );

  const fmtDeg = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}°`);

  return (
    <aside className="schwab-drawer" aria-label="SRS-Schwab Spinopelvic Calculator">
      <div className="drawer-header">
        <div>
          <div className="drawer-title">SRS–Schwab & Spinopelvic</div>
          <div className="drawer-subtitle">100% Geometry-Driven · Zero Pre-Filled Values</div>
        </div>
        <button type="button" className="rail-icon-btn" onClick={onClose} title="Hide SRS-Schwab Drawer">
          <X size={16} />
        </button>
      </div>

      {/* Courtroom Calibration Gate Status */}
      <div className={`calibration-card ${metrics.isCalibratedForMm ? 'cal-ok' : 'cal-warn'}`}>
        {metrics.isCalibratedForMm ? (
          <div className="cal-row">
            <CheckCircle2 size={16} />
            <div>
              <div className="cal-heading">Millimeter SVA Calibrated</div>
              <div className="cal-detail">
                {metrics.calibrationSource === 'MANUAL_REFERENCE'
                  ? `Reference Marker (${manualCalibrationMmPerPx?.toFixed(3)} mm/px)`
                  : `DICOM PixelSpacing (${activeSlice?.pixelSpacing?.[0].toFixed(3)} mm/px)`}
              </div>
            </div>
            {manualCalibrationMmPerPx && (
              <button
                type="button"
                className="rail-mini-btn"
                onClick={onClearManualCalibration}
                title="Reset manual calibration"
              >
                Reset
              </button>
            )}
          </div>
        ) : (
          <div className="cal-stack">
            <div className="cal-row">
              <AlertTriangle size={16} />
              <div>
                <div className="cal-heading">Uncalibrated Plain Radiograph Gate</div>
                <div className="cal-detail">
                  Angles (PI, PT, SS, LL) are magnification-invariant, but millimeter SVA is locked until you calibrate a known marker/implant length.
                </div>
              </div>
            </div>
            <button
              type="button"
              className="calibrate-cta-btn"
              onClick={() => {
                onSelectStep(null);
                onActivateCalibrationTool('calibrate');
              }}
            >
              <Ruler size={14} />
              <span>Calibrate Known Length (e.g. 25mm Marker Ball)</span>
            </button>
          </div>
        )}
      </div>

      {/* Computed Parameters Grid */}
      <div className="metrics-grid">
        <div className="metric-box">
          <span className="metric-name">Pelvic Incidence (PI)</span>
          <span className="metric-val">{fmtDeg(metrics.pelvicIncidenceDeg)}</span>
        </div>
        <div className="metric-box">
          <span className="metric-name">Pelvic Tilt (PT)</span>
          <span className="metric-val">
            {fmtDeg(metrics.pelvicTiltDeg)}
            {metrics.ptModifier && <em className="mod-chip">{metrics.ptModifier}</em>}
          </span>
        </div>
        <div className="metric-box">
          <span className="metric-name">Sacral Slope (SS)</span>
          <span className="metric-val">{fmtDeg(metrics.sacralSlopeDeg)}</span>
        </div>
        <div className="metric-box">
          <span className="metric-name">Lumbar Lordosis (LL)</span>
          <span className="metric-val">{fmtDeg(metrics.lumbarLordosisDeg)}</span>
        </div>
        <div className="metric-box">
          <span className="metric-name">PI – LL Mismatch</span>
          <span className="metric-val">
            {fmtDeg(metrics.piMinusLlDeg)}
            {metrics.piLlModifier && <em className="mod-chip">{metrics.piLlModifier}</em>}
          </span>
        </div>
        <div className="metric-box">
          <span className="metric-name">Thoracic Kyphosis</span>
          <span className="metric-val">{fmtDeg(metrics.thoracicKyphosisDeg)}</span>
        </div>
        <div className="metric-box wide">
          <span className="metric-name">Sagittal Vertical Axis (C7 SVA)</span>
          <span className="metric-val">
            {metrics.svaMillimeters !== null
              ? `${metrics.svaMillimeters.toFixed(1)} mm`
              : metrics.svaPixels !== null
                ? `${metrics.svaPixels.toFixed(1)} px [Uncalibrated]`
                : '—'}
            {metrics.svaModifier && <em className="mod-chip">{metrics.svaModifier}</em>}
          </span>
        </div>
        <div className="metric-box wide">
          <span className="metric-name">Proximal Junctional Angle (PJK)</span>
          <span className="metric-val">
            {fmtDeg(metrics.pjkAngleDeg)}
            {metrics.pjkAngleDeg !== null && metrics.pjkAngleDeg >= 10 && (
              <em className="mod-chip alert">≥10° PJK</em>
            )}
          </span>
        </div>
      </div>

      {/* Guided Landmark Placement Steps */}
      <div className="landmark-section">
        <div className="landmark-header">
          <span>Place Anatomical Landmarks</span>
          <button
            type="button"
            className="rail-mini-btn"
            onClick={onClearLandmarks}
            title="Clear all SRS-Schwab landmarks on active panel"
          >
            <RotateCcw size={12} /> Clear
          </button>
        </div>

        <div className="landmark-list">
          {LANDMARK_STEPS.map((st) => {
            const placed = Boolean(landmarks[st.key]);
            const isCurrent = activeStep === st.key;
            return (
              <button
                key={st.key}
                type="button"
                className={`landmark-btn ${isCurrent ? 'active' : ''} ${placed ? 'placed' : ''}`}
                onClick={() => onSelectStep(isCurrent ? null : st.key)}
                title={st.hint}
              >
                <Crosshair size={13} />
                <span className="lm-label">{st.label}</span>
                <span className="lm-status">{placed ? '✓' : isCurrent ? 'Click Film…' : 'Set'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
