import {
  DecodedSlice,
  DicomSeries,
  DicomSliceRef,
  DicomStudy,
  ExhibitConfig,
  Point2D,
  ViewportAnnotation,
  ViewportState,
} from '../types/dicom';
import { decodeDicomSlice, renderSliceToImageData } from './dicomDecoder';
import { computeSchwabMetrics } from './schwabMath';
import { computeScoutIntersectionLine } from './scoutGeometry';

export interface PanelRenderBundle {
  panel: ViewportState;
  study: DicomStudy | null;
  series: DicomSeries | null;
  slice: DicomSliceRef | null;
  decoded: DecodedSlice | null;
  scoutLines: { p1: Point2D; p2: Point2D; label: string }[];
}

export function computeEllipseStats(
  decoded: DecodedSlice,
  p1: Point2D,
  p2: Point2D,
  mmPerPxRow?: number,
  mmPerPxCol?: number
): { mean: number; sd: number; areaLabel: string } {
  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  const rx = Math.max(1, Math.abs(p2.x - p1.x) / 2);
  const ry = Math.max(1, Math.abs(p2.y - p1.y) / 2);

  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(decoded.columns - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(decoded.rows - 1, Math.ceil(cy + ry));

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1.0) {
        const v = decoded.scalarData[y * decoded.columns + x];
        sum += v;
        sumSq += v * v;
        count++;
      }
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 1 ? Math.max(0, sumSq / count - mean * mean) : 0;
  const sd = Math.sqrt(variance);

  const areaLabel =
    mmPerPxRow && mmPerPxCol
      ? `${(Math.PI * rx * mmPerPxCol * ry * mmPerPxRow).toFixed(1)} mm²`
      : `${Math.round(Math.PI * rx * ry)} px²`;

  return { mean, sd, areaLabel };
}

function drawPillText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fgColor: string,
  fontPx: number
): void {
  ctx.save();
  ctx.font = `600 ${fontPx}px "Inter", "Segoe UI", system-ui, sans-serif`;
  const metrics = ctx.measureText(text);
  const padX = Math.round(fontPx * 0.55);
  const padY = Math.round(fontPx * 0.35);
  const w = metrics.width + padX * 2;
  const h = fontPx + padY * 2;

  ctx.fillStyle = 'rgba(7, 10, 18, 0.86)';
  ctx.strokeStyle = fgColor;
  ctx.lineWidth = Math.max(1.5, fontPx * 0.1);
  ctx.beginPath();
  ctx.roundRect(x - padX, y - fontPx - padY + 2, w, h, Math.round(fontPx * 0.35));
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = fgColor;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawArrowSegment(
  ctx: CanvasRenderingContext2D,
  from: Point2D,
  to: Point2D,
  color: string,
  lineWidth: number
): void {
  const headLen = Math.max(12, lineWidth * 4.5);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headLen * Math.cos(angle - Math.PI / 6),
    to.y - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    to.x - headLen * Math.cos(angle + Math.PI / 6),
    to.y - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Shared deterministic vector renderer used by both the live interactive ViewportPanel
 * and the High-DPI 4K Courtroom Exhibit Exporter.
 */
export function renderPanelToContext(
  ctx: CanvasRenderingContext2D,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  bundle: PanelRenderBundle,
  exhibit: ExhibitConfig,
  showTextOverlay: boolean,
  scaleFactor = 1
): void {
  const { panel, study, series, slice, decoded, scoutLines } = bundle;

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX, boxY, boxW, boxH);
  ctx.clip();

  ctx.fillStyle = '#04060a';
  ctx.fillRect(boxX, boxY, boxW, boxH);

  if (!slice || !decoded) {
    ctx.restore();
    return;
  }

  const bannerHeight = exhibit.enabled || panel.exhibitBanner ? Math.round(32 * scaleFactor) : 0;
  const viewY = boxY + bannerHeight;
  const viewH = Math.max(40, boxH - bannerHeight);

  // Compute physical aspect-corrected image transform
  const psRow = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[0] ?? 1;
  const psCol = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[1] ?? 1;
  const physWidth = decoded.columns * psCol;
  const physHeight = decoded.rows * psRow;

  const baseScale = Math.min(boxW / physWidth, viewH / physHeight) * 0.94;
  const effScale = baseScale * panel.zoom;
  const drawW = physWidth * effScale;
  const drawH = physHeight * effScale;
  const originX = boxX + (boxW - drawW) / 2 + panel.panX * scaleFactor;
  const originY = viewY + (viewH - drawH) / 2 + panel.panY * scaleFactor;

  const imgToScreen = (pt: Point2D): Point2D => ({
    x: originX + (pt.x / decoded.columns) * drawW,
    y: originY + (pt.y / decoded.rows) * drawH,
  });

  // Render DICOM VOI-LUT slice onto offscreen canvas then draw smoothly
  const imgData = renderSliceToImageData(
    decoded,
    panel.windowCenter,
    panel.windowWidth,
    panel.invert
  );
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = decoded.columns;
  srcCanvas.height = decoded.rows;
  srcCanvas.getContext('2d')!.putImageData(imgData, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, originX, originY, drawW, drawH);

  const lw = Math.max(1.8, 2.0 * scaleFactor);
  const fontPx = Math.round(12.5 * scaleFactor);

  // 1. Yellow 3D Sagittal <-> Axial Scout Reference Lines
  if (exhibit.showScoutLines && scoutLines.length > 0) {
    for (const sl of scoutLines) {
      const s1 = imgToScreen(sl.p1);
      const s2 = imgToScreen(sl.p2);
      ctx.save();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = Math.max(1.5, 1.8 * scaleFactor);
      ctx.setLineDash([7 * scaleFactor, 5 * scaleFactor]);
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawPillText(ctx, sl.label, s2.x + 6 * scaleFactor, s2.y, '#facc15', Math.round(11 * scaleFactor));
      ctx.restore();
    }
  }

  // 2. Effective millimeter calibration check
  const calRowMm = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[0];
  const calColMm = panel.manualCalibrationMmPerPx ?? slice.pixelSpacing?.[1];
  const hasCalibratedMm = Boolean(calRowMm && calColMm);

  // 3. Vector Annotations & Courtroom Callouts
  const sliceAnnotations: ViewportAnnotation[] = panel.annotations.filter(
    (a) => a.sliceId === slice.id
  );
  for (const ann of sliceAnnotations) {
    const pts = ann.points.map(imgToScreen);
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = lw;

    if ((ann.type === 'length' || ann.type === 'calibrate') && pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5 * scaleFactor, 0, Math.PI * 2);
        ctx.fill();
      }
      const dxPx = ann.points[1].x - ann.points[0].x;
      const dyPx = ann.points[1].y - ann.points[0].y;
      const text =
        ann.type === 'calibrate' && ann.knownMm
          ? `Ref: ${ann.knownMm.toFixed(1)} mm`
          : hasCalibratedMm && calColMm && calRowMm
            ? `${Math.hypot(dxPx * calColMm, dyPx * calRowMm).toFixed(1)} mm`
            : `${Math.hypot(dxPx, dyPx).toFixed(1)} px [Uncal]`;
      drawPillText(
        ctx,
        text,
        (pts[0].x + pts[1].x) / 2 + 6 * scaleFactor,
        (pts[0].y + pts[1].y) / 2 - 6 * scaleFactor,
        ann.color,
        fontPx
      );
    } else if (ann.type === 'angle' && pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      if (pts[2]) ctx.lineTo(pts[2].x, pts[2].y);
      ctx.stroke();
      if (ann.points.length >= 3) {
        const u = {
          x: (ann.points[0].x - ann.points[1].x) * (calColMm ?? 1),
          y: (ann.points[0].y - ann.points[1].y) * (calRowMm ?? 1),
        };
        const v = {
          x: (ann.points[2].x - ann.points[1].x) * (calColMm ?? 1),
          y: (ann.points[2].y - ann.points[1].y) * (calRowMm ?? 1),
        };
        const cosA = Math.min(
          1,
          Math.max(-1, (u.x * v.x + u.y * v.y) / Math.max(1e-6, Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)))
        );
        const deg = ((Math.acos(cosA) * 180) / Math.PI).toFixed(1);
        drawPillText(ctx, `${deg}°`, pts[1].x + 8 * scaleFactor, pts[1].y - 6 * scaleFactor, ann.color, fontPx);
      }
    } else if (ann.type === 'cobb' && pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      if (pts.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.stroke();

        const ux = (ann.points[1].x - ann.points[0].x) * (calColMm ?? 1);
        const uy = (ann.points[1].y - ann.points[0].y) * (calRowMm ?? 1);
        const vx = (ann.points[3].x - ann.points[2].x) * (calColMm ?? 1);
        const vy = (ann.points[3].y - ann.points[2].y) * (calRowMm ?? 1);
        const cosC = Math.min(
          1,
          Math.max(-1, Math.abs(ux * vx + uy * vy) / Math.max(1e-6, Math.hypot(ux, uy) * Math.hypot(vx, vy)))
        );
        const cobbDeg = ((Math.acos(cosC) * 180) / Math.PI).toFixed(1);
        drawPillText(
          ctx,
          `Cobb: ${cobbDeg}°`,
          (pts[1].x + pts[3].x) / 2 + 8 * scaleFactor,
          (pts[1].y + pts[3].y) / 2,
          ann.color,
          fontPx
        );
      }
    } else if (ann.type === 'ellipse' && pts.length >= 2) {
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const rx = Math.abs(pts[1].x - pts[0].x) / 2;
      const ry = Math.abs(pts[1].y - pts[0].y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(2, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
      ctx.stroke();
      const stats = computeEllipseStats(decoded, ann.points[0], ann.points[1], calRowMm, calColMm);
      const unit = series?.modality === 'CT' ? 'HU' : 'SI';
      drawPillText(
        ctx,
        `Mean ${stats.mean.toFixed(0)} ± ${stats.sd.toFixed(0)} ${unit} (${stats.areaLabel})`,
        cx + rx + 6 * scaleFactor,
        cy,
        ann.color,
        Math.round(11.5 * scaleFactor)
      );
    } else if (ann.type === 'probe' && pts.length >= 1) {
      const px = Math.min(decoded.columns - 1, Math.max(0, Math.round(ann.points[0].x)));
      const py = Math.min(decoded.rows - 1, Math.max(0, Math.round(ann.points[0].y)));
      const val = decoded.scalarData[py * decoded.columns + px];
      const unit = series?.modality === 'CT' ? 'HU' : 'SI';
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 4 * scaleFactor, 0, Math.PI * 2);
      ctx.fill();
      drawPillText(
        ctx,
        `${Math.round(val)} ${unit}`,
        pts[0].x + 8 * scaleFactor,
        pts[0].y - 6 * scaleFactor,
        ann.color,
        fontPx
      );
    } else if (ann.type === 'arrow' && pts.length >= 2) {
      // Tail = pts[0], Arrowhead Tip = pts[1] pointing directly at pathology
      drawArrowSegment(ctx, pts[0], pts[1], ann.color, Math.max(2.5, 2.8 * scaleFactor));
      if (ann.label) {
        drawPillText(
          ctx,
          ann.label,
          pts[0].x,
          pts[0].y - 8 * scaleFactor,
          ann.color,
          Math.round(13 * scaleFactor)
        );
      }
    } else if (ann.type === 'spineLabel' && pts.length >= 1) {
      drawPillText(
        ctx,
        ann.label || 'L4-L5',
        pts[0].x,
        pts[0].y,
        ann.color,
        Math.round(13 * scaleFactor)
      );
    }
  }

  // 4. SRS-Schwab Geometric Landmarks & Plumb Line Overlay (if any placed on this panel)
  const lm = panel.schwabLandmarks;
  const drawEndplate = (a?: Point2D, b?: Point2D, color = '#38bdf8', tag?: string) => {
    if (!a) return;
    const sa = imgToScreen(a);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sa.x, sa.y, 4 * scaleFactor, 0, Math.PI * 2);
    ctx.fill();
    if (b) {
      const sb = imgToScreen(b);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sb.x, sb.y, 4 * scaleFactor, 0, Math.PI * 2);
      ctx.fill();
      if (tag) drawPillText(ctx, tag, sb.x + 6 * scaleFactor, sb.y, color, Math.round(11 * scaleFactor));
    }
  };

  drawEndplate(lm.s1Post, lm.s1Ant, '#38bdf8', 'S1');
  drawEndplate(lm.l1SupPost, lm.l1SupAnt, '#4ade80', 'L1');
  drawEndplate(lm.t1SupPost, lm.t1SupAnt, '#a78bfa', 'T1');
  drawEndplate(lm.uivInfPost, lm.uivInfAnt, '#fb7185', 'UIV');
  drawEndplate(lm.uiv2SupPost, lm.uiv2SupAnt, '#f472b6', 'UIV+2');

  if (lm.femoralHead) {
    const sfh = imgToScreen(lm.femoralHead);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(sfh.x, sfh.y, 10 * scaleFactor, 0, Math.PI * 2);
    ctx.stroke();
    if (lm.s1Post && lm.s1Ant) {
      const sMid = imgToScreen({
        x: (lm.s1Post.x + lm.s1Ant.x) / 2,
        y: (lm.s1Post.y + lm.s1Ant.y) / 2,
      });
      ctx.setLineDash([5 * scaleFactor, 4 * scaleFactor]);
      ctx.beginPath();
      ctx.moveTo(sfh.x, sfh.y);
      ctx.lineTo(sMid.x, sMid.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (lm.c7Centroid) {
    const sc7 = imgToScreen(lm.c7Centroid);
    ctx.strokeStyle = '#fb923c';
    ctx.fillStyle = '#fb923c';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(sc7.x, sc7.y, 4.5 * scaleFactor, 0, Math.PI * 2);
    ctx.fill();

    // Vertical C7 Plumb Line
    const bottomY = lm.s1Post ? imgToScreen(lm.s1Post).y + 18 * scaleFactor : boxY + boxH - 24 * scaleFactor;
    ctx.setLineDash([6 * scaleFactor, 4 * scaleFactor]);
    ctx.beginPath();
    ctx.moveTo(sc7.x, sc7.y);
    ctx.lineTo(sc7.x, bottomY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (lm.s1Post) {
      const ss1 = imgToScreen(lm.s1Post);
      ctx.beginPath();
      ctx.moveTo(ss1.x, ss1.y);
      ctx.lineTo(sc7.x, ss1.y);
      ctx.stroke();
      const metrics = computeSchwabMetrics(lm, slice.pixelSpacing, panel.manualCalibrationMmPerPx);
      const svaText =
        metrics.svaMillimeters !== null
          ? `SVA: ${metrics.svaMillimeters} mm`
          : `SVA: ${metrics.svaPixels ?? 0} px [Uncalibrated]`;
      drawPillText(ctx, svaText, sc7.x + 8 * scaleFactor, ss1.y, '#fb923c', fontPx);
    }
  }

  // 5. Courtroom Exhibit Top Banner (if enabled or custom banner present)
  const activeBanner =
    panel.exhibitBanner ||
    (exhibit.enabled && study
      ? `${study.studyDescription} — ${study.studyDateFormatted}`
      : '');
  if (bannerHeight > 0 && activeBanner) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(boxX, boxY, boxW, bannerHeight);
    ctx.strokeStyle = '#1e3a5f';
    ctx.lineWidth = 1 * scaleFactor;
    ctx.beginPath();
    ctx.moveTo(boxX, boxY + bannerHeight);
    ctx.lineTo(boxX + boxW, boxY + bannerHeight);
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = `700 ${Math.round(13 * scaleFactor)}px "Inter", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(activeBanner.toUpperCase(), boxX + boxW / 2, boxY + bannerHeight / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // 6. RadiAnt DICOM Corner Overlays (with 1-Click PHI Scrubber compliance)
  if (showTextOverlay && study && series) {
    const pad = Math.round(10 * scaleFactor);
    const smallFont = Math.round(11.5 * scaleFactor);
    const lineH = Math.round(15 * scaleFactor);
    ctx.font = `500 ${smallFont}px "JetBrains Mono", "Consolas", monospace`;
    ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 3 * scaleFactor;

    const topY = viewY + pad + smallFont;
    // Top-Left: Patient & Study
    const tlLines = exhibit.scrubPhi
      ? [
          exhibit.caseCaption || 'REDACTED MEDICOLegal EXHIBIT',
          `Study Date: ${study.studyDateFormatted}`,
          `${series.modality} · ${series.seriesDescription}`,
        ]
      : [
          `${study.patientName} ${study.patientAge ? `(${study.patientAge} ${study.patientSex})` : ''}`.trim(),
          `ID: ${study.patientID}${study.patientBirthDate !== 'Undated Study' ? ` · DOB: ${study.patientBirthDate}` : ''}`,
          `${study.studyDateFormatted} · ${series.seriesDescription}`,
        ];

    tlLines.forEach((line, idx) => {
      ctx.fillText(line, boxX + pad, topY + idx * lineH);
    });

    // Top-Right: Institution (hidden when PHI scrubbed) + Orientation
    const trLines = exhibit.scrubPhi
      ? [`Plane: ${series.orientationPlane}`]
      : [study.institutionName || 'Local DICOM Archive', `Plane: ${series.orientationPlane}`];
    ctx.textAlign = 'right';
    trLines.forEach((line, idx) => {
      ctx.fillText(line, boxX + boxW - pad, topY + idx * lineH);
    });

    // Bottom-Left: Slice & Geometry
    ctx.textAlign = 'left';
    const botY = boxY + boxH - pad;
    ctx.fillText(
      `Im: ${panel.sliceIndex + 1}/${series.slices.length}${slice.sliceThickness ? ` · Thk: ${slice.sliceThickness}mm` : ''}`,
      boxX + pad,
      botY - lineH
    );
    ctx.fillText(
      hasCalibratedMm && calColMm
        ? `Calibrated (${calColMm.toFixed(2)} mm/px)`
        : slice.imagerPixelSpacing
          ? 'Detector Spacing [Uncalibrated X-Ray]'
          : 'Uncalibrated Pixel Space',
      boxX + pad,
      botY
    );

    // Bottom-Right: WW/WL & Zoom
    ctx.textAlign = 'right';
    ctx.fillText(
      `WL: ${Math.round(panel.windowCenter)} WW: ${Math.round(panel.windowWidth)}`,
      boxX + boxW - pad,
      botY - lineH
    );
    ctx.fillText(`Zoom: ${Math.round(panel.zoom * 100)}%`, boxX + boxW - pad, botY);
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
  }

  // Subtle panel border
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1.5 * scaleFactor;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.restore();
}

/**
 * Exports a 4K High-DPI Courtroom & Deposition Exhibit composite (PNG or JPEG)
 * across all active comparison panels or the maximized panel.
 */
export async function exportCourtExhibitImage(params: {
  format: 'png' | 'jpeg';
  gridCols: number;
  gridRows: number;
  panels: ViewportState[];
  studies: DicomStudy[];
  exhibit: ExhibitConfig;
  showTextOverlay: boolean;
}): Promise<{ filename: string; width: number; height: number }> {
  const { format, gridCols, gridRows, panels, studies, exhibit, showTextOverlay } = params;
  const visibleCount = gridCols * gridRows;
  const activePanels = panels.slice(0, visibleCount);

  // Build render bundles
  const seriesLookup = new Map<string, { study: DicomStudy; series: DicomSeries }>();
  for (const st of studies) {
    for (const ser of st.series) {
      seriesLookup.set(ser.seriesInstanceUID, { study: st, series: ser });
    }
  }

  const bundles: PanelRenderBundle[] = [];
  for (const p of activePanels) {
    const found = p.seriesInstanceUID ? seriesLookup.get(p.seriesInstanceUID) : undefined;
    const slice = found ? found.series.slices[p.sliceIndex] ?? null : null;
    const decoded = slice ? await decodeDicomSlice(slice) : null;
    bundles.push({
      panel: p,
      study: found?.study ?? null,
      series: found?.series ?? null,
      slice,
      decoded,
      scoutLines: [],
    });
  }

  // Populate cross-panel scout lines
  for (let i = 0; i < bundles.length; i++) {
    const target = bundles[i];
    if (!target.slice) continue;
    for (let j = 0; j < bundles.length; j++) {
      if (i === j) continue;
      const src = bundles[j];
      if (!src.slice || !src.series) continue;
      const seg = computeScoutIntersectionLine(src.slice, target.slice);
      if (seg) {
        target.scoutLines.push({
          p1: seg[0],
          p2: seg[1],
          label: `${src.series.seriesDescription} (#${src.panel.sliceIndex + 1})`,
        });
      }
    }
  }

  const outWidth = gridCols >= 2 ? 3200 : 2200;
  const headerBarH = exhibit.exhibitTitle || exhibit.caseCaption ? 92 : 0;
  const cellW = Math.floor(outWidth / gridCols);
  const cellH = Math.round(cellW * 0.88);
  const outHeight = headerBarH + cellH * gridRows;

  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#04060a';
  ctx.fillRect(0, 0, outWidth, outHeight);

  if (headerBarH > 0) {
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, outWidth, headerBarH);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, headerBarH - 1.5);
    ctx.lineTo(outWidth, headerBarH - 1.5);
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 30px "Inter", "Segoe UI", system-ui, sans-serif';
    ctx.fillText(
      exhibit.exhibitTitle || 'MEDICOLegal RADIOLOGY EXHIBIT',
      36,
      exhibit.caseCaption ? 42 : 56
    );
    if (exhibit.caseCaption) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '500 21px "Inter", "Segoe UI", system-ui, sans-serif';
      ctx.fillText(exhibit.caseCaption, 36, 74);
    }
  }

  const scaleFactor = cellW / 560;
  for (let idx = 0; idx < bundles.length; idx++) {
    const col = idx % gridCols;
    const row = Math.floor(idx / gridCols);
    renderPanelToContext(
      ctx,
      col * cellW,
      headerBarH + row * cellH,
      cellW,
      cellH,
      bundles[idx],
      exhibit,
      showTextOverlay,
      scaleFactor
    );
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const safeSlug = (exhibit.exhibitTitle || 'LexDICOM-Exhibit')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${safeSlug || 'LexDICOM-Exhibit'}-${stamp}.${ext}`;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, format === 'jpeg' ? 0.95 : undefined)
  );
  if (!blob) throw new Error('Canvas export failed to encode image blob');

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 3000);

  return { filename, width: outWidth, height: outHeight };
}
