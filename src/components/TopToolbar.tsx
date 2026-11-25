import React from 'react';
import {
  Activity,
  ArrowUpRight,
  Circle,
  Compass,
  Crosshair,
  Download,
  Eye,
  FolderOpen,
  Grid2x2,
  Hand,
  Layers,
  Link2,
  Maximize2,
  Play,
  Pause,
  RotateCcw,
  Ruler,
  Scale,
  ShieldCheck,
  Sliders,
  Sparkles,
  SunMedium,
  Tag,
  ZoomIn,
} from 'lucide-react';
import { ExhibitConfig, GridLayout, MouseButtonBindings, ToolMode } from '../types/dicom';

interface TopToolbarProps {
  bindings: MouseButtonBindings;
  onBindTool: (tool: ToolMode, mouseButton: 0 | 1 | 2) => void;
  gridLayout: GridLayout;
  onChangeGridLayout: (layout: GridLayout) => void;
  syncEnabled: boolean;
  onToggleSync: () => void;
  showTextOverlay: boolean;
  onToggleTextOverlay: () => void;
  cinePlaying: boolean;
  onToggleCine: () => void;
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onLoadSampleCase: () => void;
  onApplyPreset: (wc: number, ww: number) => void;
  onToggleInvert: () => void;
  onResetViewport: () => void;
  onOpenMpr: () => void;
  canOpenMpr: boolean;
  exhibit: ExhibitConfig;
  onChangeExhibit: (patch: Partial<ExhibitConfig>) => void;
  onExportExhibit: (format: 'png' | 'jpeg') => void;
  schwabOpen: boolean;
  onToggleSchwab: () => void;
  installPromptAvailable: boolean;
  onInstallPwa: () => void;
}

const SPINE_LEVELS = [
  'C2-C3', 'C3-C4', 'C4-C5', 'C5-C6', 'C6-C7', 'C7-T1',
  'T11-T12', 'T12-L1', 'L1-L2', 'L2-L3', 'L3-L4', 'L4-L5', 'L5-S1',
];

const WL_PRESETS = [
  { label: 'Auto Slice', wc: -99999, ww: -99999 },
  { label: 'CT Spine Bone (1800 / 400)', wc: 400, ww: 1800 },
  { label: 'CT Soft Tissue (350 / 50)', wc: 50, ww: 350 },
  { label: 'CT Brain (80 / 40)', wc: 40, ww: 80 },
  { label: 'CT Angio (600 / 200)', wc: 200, ww: 600 },
  { label: 'CT Lung (1500 / -600)', wc: -600, ww: 1500 },
  { label: 'MR Spine T2 (900 / 450)', wc: 450, ww: 900 },
];

export const TopToolbar: React.FC<TopToolbarProps> = ({
  bindings,
  onBindTool,
  gridLayout,
  onChangeGridLayout,
  syncEnabled,
  onToggleSync,
  showTextOverlay,
  onToggleTextOverlay,
  cinePlaying,
  onToggleCine,
  onOpenFolder,
  onOpenFiles,
  onLoadSampleCase,
  onApplyPreset,
  onToggleInvert,
  onResetViewport,
  onOpenMpr,
  canOpenMpr,
  exhibit,
  onChangeExhibit,
  onExportExhibit,
  schwabOpen,
  onToggleSchwab,
  installPromptAvailable,
  onInstallPwa,
}) => {
  const getMouseBadges = (tool: ToolMode): string[] => {
    const out: string[] = [];
    if (bindings.left === tool) out.push('L');
    if (bindings.middle === tool) out.push('M');
    if (bindings.right === tool) out.push('R');
    return out;
  };

  const renderToolBtn = (
    tool: ToolMode,
    label: string,
    icon: React.ReactNode,
    shortcut?: string
  ) => {
    const badges = getMouseBadges(tool);
    const active = badges.length > 0;
    return (
      <button
        key={tool}
        type="button"
        className={`tool-btn ${active ? 'active' : ''}`}
        title={`${label}${shortcut ? ` (${shortcut})` : ''} — Left/Middle/Right-click to bind to that mouse button`}
        onClick={() => onBindTool(tool, 0)}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onBindTool(tool, 1);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onBindTool(tool, 2);
        }}
      >
        <span className="tool-icon">{icon}</span>
        <span className="tool-label">{label}</span>
        {badges.length > 0 && (
          <span className="mouse-badges">
            {badges.map((b) => (
              <span key={b} className={`mouse-badge badge-${b.toLowerCase()}`}>
                {b}
              </span>
            ))}
          </span>
        )}
      </button>
    );
  };

  return (
    <header className="top-chrome">
      <div className="radiant-toolbar">
        {/* Brand + Group 1: Chaotic Folder Ingestion & Multi-Panel Grid */}
        <div className="toolbar-group">
          <div className="brand-mark" title="LexDICOM — Local-First Medicolegal DICOM Workstation">
            <Layers size={18} className="brand-icon" />
            <span className="brand-name">LexDICOM</span>
          </div>

          <button
            type="button"
            className="tool-btn primary-ingest"
            onClick={onOpenFolder}
            title="Recursively scan an entire unsorted legal-firm DICOM folder (Ctrl+O)"
          >
            <FolderOpen size={16} />
            <span className="tool-label">Open Folder</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            onClick={onOpenFiles}
            title="Open individual DICOM files"
          >
            <span className="tool-label">+ Files</span>
          </button>

          <button
            type="button"
            className="tool-btn subtle"
            onClick={onLoadSampleCase}
            title="Load built-in Multi-Timepoint Lumbar MRI + Standing Spine X-Ray verification case"
          >
            <Sparkles size={15} />
            <span className="tool-label">Sample Case</span>
          </button>

          <div className="toolbar-divider" />

          <div className="layout-pill-group" role="group" aria-label="Viewport Grid Split">
            <Grid2x2 size={15} className="muted-icon" />
            {(['1x1', '1x2', '2x2', '2x3'] as GridLayout[]).map((g) => (
              <button
                key={g}
                type="button"
                className={`mini-pill ${gridLayout === g ? 'selected' : ''}`}
                onClick={() => onChangeGridLayout(g)}
                title={`Switch panel grid to ${g}`}
              >
                {g}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`tool-btn ${syncEnabled ? 'active' : ''}`}
            onClick={onToggleSync}
            title="Synchronize longitudinal slice scrolling across matching planes"
          >
            <Link2 size={15} />
            <span className="tool-label">Sync</span>
          </button>

          <button
            type="button"
            className={`tool-btn ${exhibit.showScoutLines ? 'active' : ''}`}
            onClick={() => onChangeExhibit({ showScoutLines: !exhibit.showScoutLines })}
            title="Toggle 3D Sagittal ↔ Axial Scout Cross-Reference Lines"
          >
            <Crosshair size={15} />
            <span className="tool-label">Scout</span>
          </button>

          <button
            type="button"
            className={`tool-btn ${showTextOverlay ? 'active' : ''}`}
            onClick={onToggleTextOverlay}
            title="Toggle DICOM Corner Overlays (A)"
          >
            <Eye size={15} />
            <span className="tool-label">A</span>
          </button>
        </div>

        {/* Group 2: RadiAnt Simultaneous Mouse-Mapped Tools & ROI Calipers */}
        <div className="toolbar-group">
          {renderToolBtn('stackScroll', 'Browse', <Layers size={15} />, 'B')}
          {renderToolBtn('windowLevel', 'W/L', <SunMedium size={15} />, 'W')}
          {renderToolBtn('pan', 'Pan', <Hand size={15} />, 'P')}
          {renderToolBtn('zoom', 'Zoom', <ZoomIn size={15} />, 'Z')}

          <select
            className="wl-preset-select"
            aria-label="Window/Level Presets"
            defaultValue=""
            onChange={(e) => {
              const idx = Number(e.target.value);
              if (!Number.isNaN(idx) && WL_PRESETS[idx]) {
                onApplyPreset(WL_PRESETS[idx].wc, WL_PRESETS[idx].ww);
              }
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              WW/WL Presets…
            </option>
            {WL_PRESETS.map((p, idx) => (
              <option key={p.label} value={idx}>
                {p.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="tool-btn"
            onClick={onToggleInvert}
            title="Invert Grayscale Polarity (I)"
          >
            <Sliders size={14} />
            <span className="tool-label">Invert</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            onClick={onResetViewport}
            title="Reset Active Panel Zoom, Pan & Window/Level (R)"
          >
            <RotateCcw size={14} />
          </button>

          <div className="toolbar-divider" />

          {renderToolBtn('length', 'Ruler', <Ruler size={15} />, 'L')}
          {renderToolBtn('angle', 'Angle', <Compass size={15} />)}
          {renderToolBtn('cobb', 'Cobb', <Activity size={15} />, 'C')}
          {renderToolBtn('ellipse', 'ROI', <Circle size={14} />)}
          {renderToolBtn('probe', 'HU', <Crosshair size={14} />)}
        </div>

        {/* Group 3: Volumetric MPR, Courtroom Exhibit Studio & On-Demand SRS-Schwab */}
        <div className="toolbar-group">
          <button
            type="button"
            className="tool-btn"
            disabled={!canOpenMpr}
            onClick={onOpenMpr}
            title={
              canOpenMpr
                ? 'Launch 3-Plane Orthogonal MPR Reconstruction for active volumetric series'
                : 'Select a volumetric multi-slice CT/MR series (>=8 slices) to enable MPR'
            }
          >
            <Maximize2 size={14} />
            <span className="tool-label">MPR</span>
          </button>

          <button
            type="button"
            className={`tool-btn ${cinePlaying ? 'active' : ''}`}
            onClick={onToggleCine}
            title="Cine Loop Stack Playback (Space)"
          >
            {cinePlaying ? <Pause size={14} /> : <Play size={14} />}
            <span className="tool-label">Cine</span>
          </button>

          <button
            type="button"
            className={`tool-btn exhibit-toggle ${exhibit.enabled ? 'active-gold' : ''}`}
            onClick={() => onChangeExhibit({ enabled: !exhibit.enabled })}
            title="Toggle Court & Deposition Exhibit Mode (PHI Scrubber, Banners, Callouts & 4K Export)"
          >
            <ShieldCheck size={15} />
            <span className="tool-label">Exhibit Mode</span>
          </button>

          <button
            type="button"
            className={`tool-btn schwab-toggle ${schwabOpen ? 'active-cyan' : ''}`}
            onClick={onToggleSchwab}
            title="Toggle On-Demand SRS-Schwab & Spinopelvic Deformity Drawer"
          >
            <Scale size={15} />
            <span className="tool-label">SRS–Schwab</span>
          </button>

          {installPromptAvailable && (
            <button
              type="button"
              className="tool-btn primary-ingest"
              onClick={onInstallPwa}
              title="Install LexDICOM to Windows Taskbar / Desktop for standalone offline use"
            >
              <Download size={14} />
              <span className="tool-label">Install App</span>
            </button>
          )}
        </div>
      </div>

      {/* Slim Context-Sensitive Courtroom Exhibit Ribbon (Hidden Unless Exhibit Mode Active) */}
      {exhibit.enabled && (
        <div className="exhibit-ribbon">
          <label className="exhibit-check">
            <input
              type="checkbox"
              checked={exhibit.scrubPhi}
              onChange={(e) => onChangeExhibit({ scrubPhi: e.target.checked })}
            />
            <span>Scrub Hospital PHI</span>
          </label>

          <input
            type="text"
            className="exhibit-input"
            placeholder="Case Caption (e.g. DOE v. ACME FREIGHT — CASE 24-CV-1082)"
            value={exhibit.caseCaption}
            onChange={(e) => onChangeExhibit({ caseCaption: e.target.value })}
          />

          <input
            type="text"
            className="exhibit-input"
            placeholder="Exhibit Header (e.g. EXHIBIT 4 — PRE- vs. POST-INCIDENT LUMBAR MRI)"
            value={exhibit.exhibitTitle}
            onChange={(e) => onChangeExhibit({ exhibitTitle: e.target.value })}
          />

          <div className="toolbar-divider" />

          {renderToolBtn('arrow', 'Callout Arrow', <ArrowUpRight size={15} />)}
          {renderToolBtn('spineLabel', 'Spine Level', <Tag size={14} />)}

          <select
            className="wl-preset-select"
            value={exhibit.activeSpineTag}
            onChange={(e) => onChangeExhibit({ activeSpineTag: e.target.value })}
            title="Spinal Level Stamp"
          >
            {SPINE_LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>

          <div className="color-swatches" role="group" aria-label="Exhibit Callout Color">
            {['#facc15', '#38bdf8', '#fb7185', '#4ade80'].map((c) => (
              <button
                key={c}
                type="button"
                className={`color-dot ${exhibit.annotationColor === c ? 'selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => onChangeExhibit({ annotationColor: c })}
                title={`Callout color ${c}`}
              />
            ))}
          </div>

          <div className="exhibit-export-actions">
            <button
              type="button"
              className="export-btn"
              onClick={() => onExportExhibit('png')}
              title="Export High-DPI Lossless 4K PNG Exhibit"
            >
              <Download size={14} />
              <span>Export 4K PNG</span>
            </button>
            <button
              type="button"
              className="export-btn secondary"
              onClick={() => onExportExhibit('jpeg')}
              title="Export High-DPI Courtroom JPEG Exhibit"
            >
              <span>Export JPG</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
