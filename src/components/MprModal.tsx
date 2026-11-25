import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DicomSeries } from '../types/dicom';
import { buildMprVolume, extractMprPlane, MprPlane, MprVolume } from '../engine/mprEngine';

interface MprModalProps {
  series: DicomSeries | null;
  onClose: () => void;
}

export const MprModal: React.FC<MprModalProps> = ({ series, onClose }) => {
  const [volume, setVolume] = useState<MprVolume | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<string>('Building 3D volume…');
  const [error, setError] = useState<string | null>(null);

  const [crossX, setCrossX] = useState(0);
  const [crossY, setCrossY] = useState(0);
  const [crossZ, setCrossZ] = useState(0);
  const [wc, setWc] = useState(400);
  const [ww, setWw] = useState(900);

  const axialRef = useRef<HTMLCanvasElement | null>(null);
  const sagRef = useRef<HTMLCanvasElement | null>(null);
  const corRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!series) return;
    let cancelled = false;
    setVolume(null);
    setError(null);

    (async () => {
      try {
        const vol = await buildMprVolume(series, (loaded, total) => {
          if (!cancelled) setLoadingProgress(`Reconstructing volume (${loaded}/${total} slices)…`);
        });
        if (cancelled) return;
        setVolume(vol);
        setCrossX(Math.floor(vol.dimX / 2));
        setCrossY(Math.floor(vol.dimY / 2));
        setCrossZ(Math.floor(vol.dimZ / 2));
        setWc(vol.defaultWc);
        setWw(vol.defaultWw);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to build MPR volume');
        }
      } finally {
        if (!cancelled) setLoadingProgress('');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [series]);

  useEffect(() => {
    if (!volume) return;

    const drawPane = (
      canvas: HTMLCanvasElement | null,
      plane: MprPlane,
      sliceIdx: number,
      chColFrac: number,
      chRowFrac: number,
      title: string
    ) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, W, H);

      const rendered = extractMprPlane(volume, plane, sliceIdx, wc, ww);
      const off = document.createElement('canvas');
      off.width = rendered.width;
      off.height = rendered.height;
      off.getContext('2d')!.putImageData(rendered.imageData, 0, 0);

      const physW = rendered.width * rendered.pixelAspectRatio;
      const physH = rendered.height;
      const scale = Math.min(W / physW, H / physH) * 0.9;
      const drawW = physW * scale;
      const drawH = physH * scale;
      const ox = (W - drawW) / 2;
      const oy = (H - drawH) / 2;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, ox, oy, drawW, drawH);

      // Synchronized orthogonal crosshairs
      const cx = ox + chColFrac * drawW;
      const cy = oy + chRowFrac * drawH;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, oy);
      ctx.lineTo(cx, oy + drawH);
      ctx.moveTo(ox, cy);
      ctx.lineTo(ox + drawW, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 13px "Inter", sans-serif';
      ctx.fillText(title, 12, 22);
    };

    drawPane(
      axialRef.current,
      'AXIAL',
      crossZ,
      crossX / Math.max(1, volume.dimX - 1),
      crossY / Math.max(1, volume.dimY - 1),
      `Native Plane (${crossZ + 1}/${volume.dimZ})`
    );
    drawPane(
      sagRef.current,
      'SAGITTAL',
      crossX,
      crossY / Math.max(1, volume.dimY - 1),
      1 - crossZ / Math.max(1, volume.dimZ - 1),
      `Orthogonal Reformat A (${crossX + 1}/${volume.dimX})`
    );
    drawPane(
      corRef.current,
      'CORONAL',
      crossY,
      crossX / Math.max(1, volume.dimX - 1),
      1 - crossZ / Math.max(1, volume.dimZ - 1),
      `Orthogonal Reformat B (${crossY + 1}/${volume.dimY})`
    );
  }, [volume, crossX, crossY, crossZ, wc, ww]);

  if (!series) return null;

  return (
    <div className="mpr-backdrop" role="dialog" aria-modal="true" aria-label="2D Orthogonal MPR">
      <div className="mpr-modal">
        <div className="mpr-header">
          <div>
            <strong>2D Orthogonal MPR Reconstruction</strong> — {series.seriesDescription} ({series.slices.length} slices)
          </div>
          <div className="mpr-controls">
            <label>
              WL:
              <input
                type="range"
                min={volume ? Math.round(volume.minVal) : -1000}
                max={volume ? Math.round(volume.maxVal) : 2000}
                value={wc}
                onChange={(e) => setWc(Number(e.target.value))}
              />
            </label>
            <label>
              WW:
              <input
                type="range"
                min={10}
                max={volume ? Math.max(100, Math.round((volume.maxVal - volume.minVal) * 1.5)) : 3000}
                value={ww}
                onChange={(e) => setWw(Number(e.target.value))}
              />
            </label>
            <button type="button" className="rail-icon-btn" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        {loadingProgress && <div className="mpr-status">{loadingProgress}</div>}
        {error && <div className="mpr-status error">{error}</div>}

        {volume && (
          <div className="mpr-grid">
            <div className="mpr-cell">
              <canvas
                ref={axialRef}
                width={480}
                height={420}
                onWheel={(e) => {
                  e.preventDefault();
                  setCrossZ((z) => Math.max(0, Math.min(volume.dimZ - 1, z + (e.deltaY > 0 ? 1 : -1))));
                }}
              />
              <input
                type="range"
                min={0}
                max={volume.dimZ - 1}
                value={crossZ}
                onChange={(e) => setCrossZ(Number(e.target.value))}
              />
            </div>

            <div className="mpr-cell">
              <canvas
                ref={sagRef}
                width={480}
                height={420}
                onWheel={(e) => {
                  e.preventDefault();
                  setCrossX((x) => Math.max(0, Math.min(volume.dimX - 1, x + (e.deltaY > 0 ? 1 : -1))));
                }}
              />
              <input
                type="range"
                min={0}
                max={volume.dimX - 1}
                value={crossX}
                onChange={(e) => setCrossX(Number(e.target.value))}
              />
            </div>

            <div className="mpr-cell">
              <canvas
                ref={corRef}
                width={480}
                height={420}
                onWheel={(e) => {
                  e.preventDefault();
                  setCrossY((y) => Math.max(0, Math.min(volume.dimY - 1, y + (e.deltaY > 0 ? 1 : -1))));
                }}
              />
              <input
                type="range"
                min={0}
                max={volume.dimY - 1}
                value={crossY}
                onChange={(e) => setCrossY(Number(e.target.value))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
