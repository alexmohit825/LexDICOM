import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Maximize2, Minimize2, X } from 'lucide-react';
import {
  DecodedSlice,
  DicomSeries,
  DicomSliceRef,
  DicomStudy,
  ExhibitConfig,
  MouseButtonBindings,
  Point2D,
  SchwabStepKey,
  ToolMode,
  ViewportAnnotation,
  ViewportState,
} from '../types/dicom';
import { decodeDicomSlice } from '../engine/dicomDecoder';
import { renderPanelToContext } from '../engine/exhibitExporter';

interface ViewportPanelProps {
  panel: ViewportState;
  isActive: boolean;
  isMaximized: boolean;
  study: DicomStudy | null;
  series: DicomSeries | null;
  slice: DicomSliceRef | null;
  scoutLines: { p1: Point2D; p2: Point2D; label: string }[];
  bindings: MouseButtonBindings;
  exhibit: ExhibitConfig;
  showTextOverlay: boolean;
  activeSchwabStep: SchwabStepKey | null;
  onActivatePanel: () => void;
  onUpdatePanel: (patch: Partial<ViewportState>) => void;
  onStepSlice: (delta: number) => void;
  onToggleMaximize: () => void;
  onCloseOrClearPanel: (clearAnnotationsOnly: boolean) => void;
  onDropSeries: (studyInstanceUID: string, seriesInstanceUID: string) => void;
  onAdvanceSchwabStep: (placedKey: SchwabStepKey) => void;
  onHoverPixelValue: (info: string) => void;
}

export const ViewportPanel: React.FC<ViewportPanelProps> = ({
  panel,
  isActive,
  isMaximized,
  study,
  series,
  slice,
  scoutLines,
  bindings,
  exhibit,
  showTextOverlay,
  activeSchwabStep,
  onActivatePanel,
  onUpdatePanel,
  onStepSlice,
  onToggleMaximize,
  onCloseOrClearPanel,
  onDropSeries,
  onAdvanceSchwabStep,
  onHoverPixelValue,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [decoded, setDecoded] = useState<DecodedSlice | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 640, h: 480 });

  // Multi-click / drag interaction state
  const dragRef = useRef<{
    tool: ToolMode;
    startClientX: number;
    startClientY: number;
    startWc: number;
    startWw: number;
    startPanX: number;
    startPanY: number;
    startZoom: number;
    startSliceIdx: number;
    draftAnnotationId?: string;
  } | null>(null);

  const [multiPointDraft, setMultiPointDraft] = useState<ViewportAnnotation | null>(null);

  // Inline modal prompts for Callout Arrow text or Calibration Known-Length (zero browser alert/prompt)
  const [pendingArrowId, setPendingArrowId] = useState<string | null>(null);
  const [arrowDraftText, setArrowDraftText] = useState('L4-L5 Disc Extrusion');
  const [pendingCalibratePx, setPendingCalibratePx] = useState<{ annId: string; distPx: number } | null>(null);
  const [calibrateMmInput, setCalibrateMmInput] = useState('25.0');

  // ResizeObserver for crisp DPR rendering
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(120, Math.floor(entry.contentRect.width));
        const h = Math.max(100, Math.floor(entry.contentRect.height));
        setCanvasSize({ w, h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Decode active DICOM slice with Anti-Leap 6 strict try...finally spinner protection
  useEffect(() => {
    if (!slice) {
      setDecoded(null);
      setDecodeError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setDecodeError(null);

    (async () => {
      try {
        const dec = await decodeDicomSlice(slice);
        if (cancelled) return;
        setDecoded(dec);
        // Apply slice's true auto-window if panel still has sentinel -99999
        if (panel.windowWidth <= 0 || panel.windowCenter === -99999) {
          onUpdatePanel({
            windowCenter: dec.defaultWindowCenter,
            windowWidth: dec.defaultWindowWidth,
          });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setDecodeError(err instanceof Error ? err.message : 'Failed to decode DICOM frame');
          setDecoded(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slice?.id]);

  // Convert client mouse coordinates to image pixel coordinates (col, row)
  const clientToImagePoint = useCallback(
    (clientX: number, clientY: number): Point2D | null => {
      const canvas = canvasRef.current;
      if (!canvas || !slice || !decoded) return null;
      const rect = canvas.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;

      const bannerHeight = exhibit.enabled || panel.exhibitBanner ? 32 : 0;
      const viewY = bannerHeight;
      const viewH = Math.max(40, rect.height - bannerHeight);

      const psRow = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[0] ?? 1;
      const psCol = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[1] ?? 1;
      const physWidth = decoded.columns * psCol;
      const physHeight = decoded.rows * psRow;

      const baseScale = Math.min(rect.width / physWidth, viewH / physHeight) * 0.94;
      const effScale = baseScale * panel.zoom;
      const drawW = physWidth * effScale;
      const drawH = physHeight * effScale;
      const originX = (rect.width - drawW) / 2 + panel.panX;
      const originY = viewY + (viewH - drawH) / 2 + panel.panY;

      const imgX = ((localX - originX) / drawW) * decoded.columns;
      const imgY = ((localY - originY) / drawH) * decoded.rows;
      return { x: imgX, y: imgY };
    },
    [decoded, exhibit.enabled, panel.exhibitBanner, panel.manualCalibrationMmPerPx, panel.panX, panel.panY, panel.zoom, slice]
  );

  // Render canvas at devicePixelRatio
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvasSize.w * dpr);
    canvas.height = Math.floor(canvasSize.h * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const effectivePanel: ViewportState = multiPointDraft
      ? { ...panel, annotations: [...panel.annotations, multiPointDraft] }
      : panel;

    renderPanelToContext(
      ctx,
      0,
      0,
      canvasSize.w,
      canvasSize.h,
      {
        panel: effectivePanel,
        study,
        series,
        slice,
        decoded,
        scoutLines,
      },
      exhibit,
      showTextOverlay,
      1
    );
  }, [
    canvasSize,
    decoded,
    exhibit,
    multiPointDraft,
    panel,
    scoutLines,
    series,
    showTextOverlay,
    slice,
    study,
  ]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    onActivatePanel();
    if (!slice || !decoded) return;

    // 1. Check if SRS-Schwab guided landmark placement is active on Left Click
    if (e.button === 0 && activeSchwabStep) {
      const pt = clientToImagePoint(e.clientX, e.clientY);
      if (pt) {
        onUpdatePanel({
          schwabLandmarks: {
            ...panel.schwabLandmarks,
            [activeSchwabStep]: pt,
          },
        });
        onAdvanceSchwabStep(activeSchwabStep);
      }
      return;
    }

    const tool: ToolMode =
      e.button === 1 ? bindings.middle : e.button === 2 ? bindings.right : bindings.left;

    const pt = clientToImagePoint(e.clientX, e.clientY);

    // Multi-click tools: Angle (3 clicks) & Cobb (4 clicks)
    if (e.button === 0 && (tool === 'angle' || tool === 'cobb') && pt) {
      const targetPoints = tool === 'angle' ? 3 : 4;
      if (!multiPointDraft || multiPointDraft.type !== tool) {
        setMultiPointDraft({
          id: `ann-${Date.now()}`,
          sliceId: slice.id,
          type: tool,
          points: [pt, pt],
          color: exhibit.annotationColor,
        });
      } else {
        const committedPts = [...multiPointDraft.points];
        committedPts[committedPts.length - 1] = pt;
        if (committedPts.length >= targetPoints) {
          onUpdatePanel({
            annotations: [...panel.annotations, { ...multiPointDraft, points: committedPts }],
          });
          setMultiPointDraft(null);
        } else {
          setMultiPointDraft({
            ...multiPointDraft,
            points: [...committedPts, pt],
          });
        }
      }
      return;
    }

    // Single-click tools: Probe & Spine Level Stamp
    if (e.button === 0 && (tool === 'probe' || tool === 'spineLabel') && pt) {
      const newAnn: ViewportAnnotation = {
        id: `ann-${Date.now()}`,
        sliceId: slice.id,
        type: tool,
        points: [pt],
        color: exhibit.annotationColor,
        label: tool === 'spineLabel' ? exhibit.activeSpineTag : undefined,
      };
      onUpdatePanel({ annotations: [...panel.annotations, newAnn] });
      return;
    }

    // Two-point drag tools: Ruler, Ellipse ROI, Courtroom Callout Arrow, Calibrate Known Length
    if (
      e.button === 0 &&
      (tool === 'length' || tool === 'ellipse' || tool === 'arrow' || tool === 'calibrate') &&
      pt
    ) {
      const id = `ann-${Date.now()}`;
      const newAnn: ViewportAnnotation = {
        id,
        sliceId: slice.id,
        type: tool,
        points: [pt, pt],
        color: tool === 'calibrate' ? '#4ade80' : exhibit.annotationColor,
        label: tool === 'arrow' ? arrowDraftText : undefined,
      };
      onUpdatePanel({ annotations: [...panel.annotations, newAnn] });
      dragRef.current = {
        tool,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWc: panel.windowCenter,
        startWw: panel.windowWidth,
        startPanX: panel.panX,
        startPanY: panel.panY,
        startZoom: panel.zoom,
        startSliceIdx: panel.sliceIndex,
        draftAnnotationId: id,
      };
      return;
    }

    // Continuous manipulation tools (Stack Scroll, Window/Level, Pan, Zoom)
    dragRef.current = {
      tool,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWc: panel.windowCenter,
      startWw: panel.windowWidth,
      startPanX: panel.panX,
      startPanY: panel.panY,
      startZoom: panel.zoom,
      startSliceIdx: panel.sliceIndex,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (slice && decoded) {
      const hoverPt = clientToImagePoint(e.clientX, e.clientY);
      if (
        hoverPt &&
        hoverPt.x >= 0 &&
        hoverPt.x < decoded.columns &&
        hoverPt.y >= 0 &&
        hoverPt.y < decoded.rows
      ) {
        const col = Math.floor(hoverPt.x);
        const row = Math.floor(hoverPt.y);
        const val = decoded.scalarData[row * decoded.columns + col];
        const unit = series?.modality === 'CT' ? 'HU' : 'SI';
        onHoverPixelValue(`X:${col} Y:${row} · ${Math.round(val)} ${unit}`);
      }

      if (multiPointDraft && hoverPt) {
        const updated = [...multiPointDraft.points];
        updated[updated.length - 1] = hoverPt;
        setMultiPointDraft({ ...multiPointDraft, points: updated });
      }
    }

    const drag = dragRef.current;
    if (!drag || !slice || !decoded) return;

    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;

    if (drag.draftAnnotationId) {
      const pt = clientToImagePoint(e.clientX, e.clientY);
      if (!pt) return;
      onUpdatePanel({
        annotations: panel.annotations.map((a) =>
          a.id === drag.draftAnnotationId ? { ...a, points: [a.points[0], pt] } : a
        ),
      });
      return;
    }

    if (drag.tool === 'windowLevel') {
      const sensitivity = Math.max(1, drag.startWw / 250);
      onUpdatePanel({
        windowWidth: Math.max(1, Math.round(drag.startWw + dx * sensitivity * 2)),
        windowCenter: Math.round(drag.startWc + dy * sensitivity * 1.5),
      });
    } else if (drag.tool === 'pan') {
      onUpdatePanel({
        panX: drag.startPanX + dx,
        panY: drag.startPanY + dy,
      });
    } else if (drag.tool === 'zoom') {
      const factor = Math.exp(-dy * 0.006);
      onUpdatePanel({
        zoom: Math.min(12, Math.max(0.2, drag.startZoom * factor)),
      });
    } else if (drag.tool === 'stackScroll' && series && series.slices.length > 1) {
      const sliceDelta = Math.round(dy / 10);
      const targetIdx = Math.max(
        0,
        Math.min(series.slices.length - 1, drag.startSliceIdx + sliceDelta)
      );
      if (targetIdx !== panel.sliceIndex) {
        onStepSlice(targetIdx - panel.sliceIndex);
      }
    }
  };

  const handleMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.draftAnnotationId) return;

    const finished = panel.annotations.find((a) => a.id === drag.draftAnnotationId);
    if (!finished || finished.points.length < 2) return;

    const distPx = Math.hypot(
      finished.points[1].x - finished.points[0].x,
      finished.points[1].y - finished.points[0].y
    );
    if (distPx < 3) {
      // Remove accidental zero-length click
      onUpdatePanel({
        annotations: panel.annotations.filter((a) => a.id !== finished.id),
      });
      return;
    }

    if (finished.type === 'arrow') {
      setPendingArrowId(finished.id);
    } else if (finished.type === 'calibrate') {
      setPendingCalibratePx({ annId: finished.id, distPx });
    }
  };

  const tabTitle =
    study && series
      ? `${exhibit.scrubPhi ? '[REDACTED]' : study.patientName} — ${study.studyDateFormatted} · ${series.seriesDescription}`
      : `Panel ${panel.panelIndex + 1} — Empty`;

  return (
    <div
      className={`viewport-panel ${isActive ? 'active-panel' : ''}`}
      onClick={onActivatePanel}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-lexdicom-series')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData('application/x-lexdicom-series');
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          try {
            const parsed = JSON.parse(raw) as {
              studyInstanceUID: string;
              seriesInstanceUID: string;
            };
            onDropSeries(parsed.studyInstanceUID, parsed.seriesInstanceUID);
          } catch {
            // Ignore malformed payload
          }
        }
      }}
    >
      {/* RadiAnt-Style Per-Panel Header Tab Bar */}
      <div className="panel-tab-bar">
        <span className="panel-tab-title" title={tabTitle}>
          {tabTitle}
        </span>

        <div className="panel-tab-controls">
          {exhibit.enabled && slice && (
            <input
              type="text"
              className="panel-banner-input"
              placeholder="Panel Exhibit Banner (e.g. PRE-INCIDENT 2022)…"
              value={panel.exhibitBanner}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onUpdatePanel({ exhibitBanner: e.target.value })}
            />
          )}

          {panel.annotations.length > 0 && (
            <button
              type="button"
              className="panel-win-btn"
              title="Clear annotations on this panel"
              onClick={(e) => {
                e.stopPropagation();
                onCloseOrClearPanel(true);
              }}
            >
              <Eraser size={12} />
            </button>
          )}

          <button
            type="button"
            className="panel-win-btn"
            title={isMaximized ? 'Restore Grid (Tab)' : 'Maximize Panel (Tab cycles panels)'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize();
            }}
          >
            {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>

          <button
            type="button"
            className="panel-win-btn close"
            title="Clear Panel (Ctrl+Click clears annotations only)"
            onClick={(e) => {
              e.stopPropagation();
              onCloseOrClearPanel(e.ctrlKey);
            }}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Main Viewport Canvas Area */}
      <div ref={containerRef} className="panel-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="dicom-canvas"
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={(e) => {
            if (!series) return;
            e.preventDefault();
            if (bindings.wheel === 'zoom' || e.ctrlKey) {
              const factor = e.deltaY < 0 ? 1.12 : 0.89;
              onUpdatePanel({ zoom: Math.min(12, Math.max(0.2, panel.zoom * factor)) });
            } else {
              onStepSlice(e.deltaY > 0 ? 1 : -1);
            }
          }}
        />

        {/* Right-edge RadiAnt Slice Scroll Thumb Track */}
        {series && series.slices.length > 1 && (
          <input
            type="range"
            className="slice-scrubber"
            aria-label="Slice Scrubber"
            min={0}
            max={series.slices.length - 1}
            value={panel.sliceIndex}
            onChange={(e) => onStepSlice(Number(e.target.value) - panel.sliceIndex)}
          />
        )}

        {!slice && !isLoading && (
          <div className="panel-empty-hint">
            <span>Click or drag a series from the left rail</span>
          </div>
        )}

        {isLoading && <div className="panel-badge-overlay">Decoding DICOM…</div>}
        {decodeError && <div className="panel-badge-overlay error">{decodeError}</div>}

        {/* Inline Callout Arrow Label Popover */}
        {pendingArrowId && (
          <div className="inline-popover" onClick={(e) => e.stopPropagation()}>
            <div className="popover-title">Exhibit Callout Label</div>
            <input
              type="text"
              value={arrowDraftText}
              autoFocus
              onChange={(e) => setArrowDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onUpdatePanel({
                    annotations: panel.annotations.map((a) =>
                      a.id === pendingArrowId ? { ...a, label: arrowDraftText } : a
                    ),
                  });
                  setPendingArrowId(null);
                }
              }}
            />
            <div className="popover-chips">
              {[
                'L4-L5 Disc Extrusion',
                'C5-C6 Cord Compression',
                'Neural Foramen Stenosis',
                'Annular Fissure / HIZ',
                'Post-Surgical Hardware',
              ].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setArrowDraftText(preset);
                    onUpdatePanel({
                      annotations: panel.annotations.map((a) =>
                        a.id === pendingArrowId ? { ...a, label: preset } : a
                      ),
                    });
                    setPendingArrowId(null);
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
            <div className="popover-actions">
              <button
                type="button"
                className="export-btn"
                onClick={() => {
                  onUpdatePanel({
                    annotations: panel.annotations.map((a) =>
                      a.id === pendingArrowId ? { ...a, label: arrowDraftText } : a
                    ),
                  });
                  setPendingArrowId(null);
                }}
              >
                Apply Callout
              </button>
            </div>
          </div>
        )}

        {/* Inline Known-Length Calibration Gate Popover */}
        {pendingCalibratePx && (
          <div className="inline-popover" onClick={(e) => e.stopPropagation()}>
            <div className="popover-title">Calibrate Radiograph Reference Length</div>
            <p className="popover-desc">
              Measured <strong>{pendingCalibratePx.distPx.toFixed(1)} px</strong>. Enter known physical length in millimeters (e.g. 25.0 mm marker sphere):
            </p>
            <input
              type="number"
              step="0.1"
              min="1"
              value={calibrateMmInput}
              autoFocus
              onChange={(e) => setCalibrateMmInput(e.target.value)}
            />
            <div className="popover-actions">
              <button
                type="button"
                className="export-btn"
                onClick={() => {
                  const mm = Number.parseFloat(calibrateMmInput);
                  if (Number.isFinite(mm) && mm > 0) {
                    const mmPerPx = mm / pendingCalibratePx.distPx;
                    onUpdatePanel({
                      manualCalibrationMmPerPx: mmPerPx,
                      annotations: panel.annotations.map((a) =>
                        a.id === pendingCalibratePx.annId ? { ...a, knownMm: mm } : a
                      ),
                    });
                  }
                  setPendingCalibratePx(null);
                }}
              >
                Lock Millimeter Calibration
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
