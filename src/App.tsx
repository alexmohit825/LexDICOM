import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Shield, Sparkles } from 'lucide-react';
import {
  DicomSeries,
  DicomStudy,
  ExhibitConfig,
  GridLayout,
  MouseButtonBindings,
  SchwabStepKey,
  ToolMode,
  ViewportState,
} from './types/dicom';
import {
  CandidateFileEntry,
  collectFromDataTransfer,
  collectFromDirectoryHandle,
  collectFromFileList,
  indexDicomEntries,
  ScanProgress,
} from './engine/folderScanner';
import {
  clearDecodeCache,
  evictSeriesFromCache,
  generateSeriesThumbnail,
  getCacheStats,
} from './engine/dicomDecoder';
import { computeScoutIntersectionLine, findSynchronizedSliceIndex } from './engine/scoutGeometry';
import { exportCourtExhibitImage } from './engine/exhibitExporter';
import { buildSampleLegalCaseEntries } from './engine/sampleCaseGenerator';
import { TopToolbar } from './components/TopToolbar';
import { SeriesRail } from './components/SeriesRail';
import { ViewportPanel } from './components/ViewportPanel';
import { SrsSchwabDrawer } from './components/SrsSchwabDrawer';
import { MprModal } from './components/MprModal';

const MAX_PANELS = 6;

function createEmptyPanel(panelIndex: number): ViewportState {
  return {
    panelIndex,
    studyInstanceUID: null,
    seriesInstanceUID: null,
    sliceIndex: 0,
    windowCenter: -99999,
    windowWidth: -99999,
    zoom: 1,
    panX: 0,
    panY: 0,
    invert: false,
    exhibitBanner: '',
    annotations: [],
    schwabLandmarks: {},
  };
}

const SCHWAB_SEQUENCE: SchwabStepKey[] = [
  'femoralHead',
  's1Post',
  's1Ant',
  'l1SupPost',
  'l1SupAnt',
  't1SupPost',
  't1SupAnt',
  'c7Centroid',
];

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const App: React.FC = () => {
  const [studies, setStudies] = useState<DicomStudy[]>([]);
  const [panels, setPanels] = useState<ViewportState[]>(() =>
    Array.from({ length: MAX_PANELS }, (_, i) => createEmptyPanel(i))
  );
  const [activePanelIdx, setActivePanelIdx] = useState(0);
  const [maximizedPanelIdx, setMaximizedPanelIdx] = useState<number | null>(null);
  const [gridLayout, setGridLayout] = useState<GridLayout>('1x2');

  const [bindings, setBindings] = useState<MouseButtonBindings>({
    left: 'windowLevel',
    middle: 'pan',
    right: 'zoom',
    wheel: 'stackScroll',
  });

  const [syncEnabled, setSyncEnabled] = useState(true);
  const [showTextOverlay, setShowTextOverlay] = useState(true);
  const [cinePlaying, setCinePlaying] = useState(false);

  const [exhibit, setExhibit] = useState<ExhibitConfig>({
    enabled: false,
    scrubPhi: false,
    caseCaption: '',
    exhibitTitle: '',
    annotationColor: '#facc15',
    activeSpineTag: 'L4-L5',
    showScoutLines: true,
  });

  // On-Demand SRS-Schwab Drawer (strictly hidden by default!)
  const [schwabOpen, setSchwabOpen] = useState(false);
  const [activeSchwabStep, setActiveSchwabStep] = useState<SchwabStepKey | null>(null);

  // 2D Orthogonal MPR Modal
  const [mprSeries, setMprSeries] = useState<DicomSeries | null>(null);

  // Folder scanning & telemetry state
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [statusMessage, setStatusMessage] = useState(
    'Ready — 100% Local Execution (Zero Patient Data Leaves This PC)'
  );
  const [hoverTelemetry, setHoverTelemetry] = useState('');
  const [dragOverlayActive, setDragOverlayActive] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);

  const gridDims = useMemo(() => {
    if (gridLayout === '1x1') return { cols: 1, rows: 1, count: 1 };
    if (gridLayout === '1x2') return { cols: 2, rows: 1, count: 2 };
    if (gridLayout === '2x2') return { cols: 2, rows: 2, count: 4 };
    return { cols: 3, rows: 2, count: 6 };
  }, [gridLayout]);

  const seriesLookup = useMemo(() => {
    const map = new Map<string, { study: DicomStudy; series: DicomSeries }>();
    for (const st of studies) {
      for (const ser of st.series) {
        map.set(ser.seriesInstanceUID, { study: st, series: ser });
      }
    }
    return map;
  }, [studies]);

  // Capture PWA Install prompt for 1-click Taskbar/Desktop installation across PCs
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const populateThumbnailsInBackground = useCallback((loadedStudies: DicomStudy[]) => {
    (async () => {
      for (const st of loadedStudies) {
        for (const ser of st.series) {
          if (ser.thumbnailDataUrl || ser.slices.length === 0) continue;
          const midSlice = ser.slices[Math.floor(ser.slices.length / 2)];
          try {
            const dataUrl = await generateSeriesThumbnail(midSlice);
            setStudies((prev) =>
              prev.map((pst) =>
                pst.studyInstanceUID !== st.studyInstanceUID
                  ? pst
                  : {
                      ...pst,
                      series: pst.series.map((pser) =>
                        pser.seriesInstanceUID === ser.seriesInstanceUID
                          ? { ...pser, thumbnailDataUrl: dataUrl }
                          : pser
                      ),
                    }
              )
            );
          } catch {
            // Non-fatal thumbnail skip
          }
        }
      }
    })();
  }, []);

  const ingestCandidates = useCallback(
    async (candidates: CandidateFileEntry[]) => {
      if (candidates.length === 0) return;
      setIsScanning(true);
      setScanProgress({
        scannedFiles: 0,
        totalCandidateFiles: candidates.length,
        validDicomSlices: 0,
        skippedJunkFiles: 0,
        currentPath: '',
      });

      try {
        const merged = await indexDicomEntries(candidates, studies, (p) => setScanProgress(p));
        setStudies(merged);
        populateThumbnailsInBackground(merged);

        const totalSlices = merged.reduce(
          (acc, st) => acc + st.series.reduce((sa, ser) => sa + ser.slices.length, 0),
          0
        );
        setStatusMessage(
          `Indexed ${merged.length} chronological stud${merged.length === 1 ? 'y' : 'ies'} (${totalSlices} DICOM slices)`
        );

        // Auto-hang initial series intelligently into empty panels
        if (merged.length >= 2 && merged[0].series[0] && merged[1].series[0]) {
          setGridLayout('1x2');
          setPanels((prev) => {
            const next = [...prev];
            const s0 = merged[0].series[0];
            const s1 = merged[1].series[0];
            next[0] = {
              ...createEmptyPanel(0),
              studyInstanceUID: merged[0].studyInstanceUID,
              seriesInstanceUID: s0.seriesInstanceUID,
              sliceIndex: Math.floor(s0.slices.length / 2),
              windowCenter: s0.slices[0].windowCenter,
              windowWidth: s0.slices[0].windowWidth,
              exhibitBanner: `PRE-INCIDENT — ${merged[0].studyDateFormatted}`,
            };
            next[1] = {
              ...createEmptyPanel(1),
              studyInstanceUID: merged[1].studyInstanceUID,
              seriesInstanceUID: s1.seriesInstanceUID,
              sliceIndex: Math.floor(s1.slices.length / 2),
              windowCenter: s1.slices[0].windowCenter,
              windowWidth: s1.slices[0].windowWidth,
              exhibitBanner: `POST-INCIDENT — ${merged[1].studyDateFormatted}`,
            };
            return next;
          });
        } else if (merged.length === 1 && merged[0].series.length > 0) {
          const st = merged[0];
          if (st.series.length >= 2) {
            setGridLayout('1x2');
            setPanels((prev) => {
              const next = [...prev];
              next[0] = {
                ...createEmptyPanel(0),
                studyInstanceUID: st.studyInstanceUID,
                seriesInstanceUID: st.series[0].seriesInstanceUID,
                sliceIndex: Math.floor(st.series[0].slices.length / 2),
                windowCenter: st.series[0].slices[0].windowCenter,
                windowWidth: st.series[0].slices[0].windowWidth,
              };
              next[1] = {
                ...createEmptyPanel(1),
                studyInstanceUID: st.studyInstanceUID,
                seriesInstanceUID: st.series[1].seriesInstanceUID,
                sliceIndex: Math.floor(st.series[1].slices.length / 2),
                windowCenter: st.series[1].slices[0].windowCenter,
                windowWidth: st.series[1].slices[0].windowWidth,
              };
              return next;
            });
          } else {
            setGridLayout('1x1');
            const s0 = st.series[0];
            setPanels((prev) => {
              const next = [...prev];
              next[0] = {
                ...createEmptyPanel(0),
                studyInstanceUID: st.studyInstanceUID,
                seriesInstanceUID: s0.seriesInstanceUID,
                sliceIndex: Math.floor(s0.slices.length / 2),
                windowCenter: s0.slices[0].windowCenter,
                windowWidth: s0.slices[0].windowWidth,
              };
              return next;
            });
          }
        }
      } catch (err: unknown) {
        setStatusMessage(
          `Folder scan error: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      } finally {
        setIsScanning(false);
        setScanProgress(null);
      }
    },
    [populateThumbnailsInBackground, studies]
  );

  const handleOpenFolder = useCallback(async () => {
    const winWithPicker = window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    };
    if (typeof winWithPicker.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await winWithPicker.showDirectoryPicker();
        setIsScanning(true);
        setStatusMessage(`Scanning folder "${dirHandle.name}" recursively…`);
        const entries = await collectFromDirectoryHandle(dirHandle);
        await ingestCandidates(entries);
        return;
      } catch (err: unknown) {
        setIsScanning(false);
        if ((err as { name?: string })?.name === 'AbortError') return;
      }
    }
    folderInputRef.current?.click();
  }, [ingestCandidates]);

  const hangSeriesInPanel = useCallback(
    (panelIndex: number, studyUID: string, seriesUID: string) => {
      const found = seriesLookup.get(seriesUID);
      if (!found || found.series.slices.length === 0) return;
      const mid = Math.floor(found.series.slices.length / 2);
      setPanels((prev) =>
        prev.map((p, idx) =>
          idx === panelIndex
            ? {
                ...createEmptyPanel(idx),
                studyInstanceUID: studyUID,
                seriesInstanceUID: seriesUID,
                sliceIndex: mid,
                windowCenter: found.series.slices[mid].windowCenter,
                windowWidth: found.series.slices[mid].windowWidth,
              }
            : p
        )
      );
      setActivePanelIdx(panelIndex);
    },
    [seriesLookup]
  );

  const stepPanelSlice = useCallback(
    (panelIndex: number, delta: number) => {
      setPanels((prev) => {
        const srcPanel = prev[panelIndex];
        if (!srcPanel?.seriesInstanceUID) return prev;
        const srcFound = seriesLookup.get(srcPanel.seriesInstanceUID);
        if (!srcFound || srcFound.series.slices.length <= 1) return prev;

        const nextSliceIdx = Math.max(
          0,
          Math.min(srcFound.series.slices.length - 1, srcPanel.sliceIndex + delta)
        );
        if (nextSliceIdx === srcPanel.sliceIndex) return prev;

        return prev.map((p, idx) => {
          if (idx === panelIndex) {
            return { ...p, sliceIndex: nextSliceIdx };
          }
          if (syncEnabled && idx < gridDims.count && p.seriesInstanceUID) {
            const tgtFound = seriesLookup.get(p.seriesInstanceUID);
            if (tgtFound) {
              const synced = findSynchronizedSliceIndex(
                srcFound.series,
                nextSliceIdx,
                tgtFound.series
              );
              if (synced !== null) {
                return { ...p, sliceIndex: synced };
              }
            }
          }
          return p;
        });
      });
    },
    [gridDims.count, seriesLookup, syncEnabled]
  );

  // Cine Playback Timer
  useEffect(() => {
    if (!cinePlaying) return;
    const timer = window.setInterval(() => {
      setPanels((prev) => {
        const active = prev[activePanelIdx];
        if (!active?.seriesInstanceUID) return prev;
        const found = seriesLookup.get(active.seriesInstanceUID);
        if (!found || found.series.slices.length <= 1) return prev;
        const nextIdx = (active.sliceIndex + 1) % found.series.slices.length;
        return prev.map((p, i) => (i === activePanelIdx ? { ...p, sliceIndex: nextIdx } : p));
      });
    }, 95);
    return () => window.clearInterval(timer);
  }, [activePanelIdx, cinePlaying, seriesLookup]);

  // RadiAnt Keyboard Shortcuts (including Tab maximize cycling!)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (maximizedPanelIdx !== null) {
          const next = (maximizedPanelIdx + 1) % gridDims.count;
          setMaximizedPanelIdx(next);
          setActivePanelIdx(next);
        } else {
          setMaximizedPanelIdx(activePanelIdx);
        }
        return;
      }

      const k = e.key.toLowerCase();
      if (k === 'b') setBindings((b) => ({ ...b, left: 'stackScroll' }));
      else if (k === 'w') setBindings((b) => ({ ...b, left: 'windowLevel' }));
      else if (k === 'p') setBindings((b) => ({ ...b, left: 'pan' }));
      else if (k === 'z') setBindings((b) => ({ ...b, left: 'zoom' }));
      else if (k === 'l') setBindings((b) => ({ ...b, left: 'length' }));
      else if (k === 'c') setBindings((b) => ({ ...b, left: 'cobb' }));
      else if (k === 'a') setShowTextOverlay((v) => !v);
      else if (k === 'i') {
        setPanels((prev) =>
          prev.map((p, idx) => (idx === activePanelIdx ? { ...p, invert: !p.invert } : p))
        );
      } else if (k === 'r') {
        setPanels((prev) =>
          prev.map((p, idx) =>
            idx === activePanelIdx
              ? { ...p, zoom: 1, panX: 0, panY: 0, invert: false, windowCenter: -99999, windowWidth: -99999 }
              : p
          )
        );
      } else if (e.key === ' ') {
        e.preventDefault();
        setCinePlaying((v) => !v);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        stepPanelSlice(activePanelIdx, 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        stepPanelSlice(activePanelIdx, -1);
      } else if (e.key === 'Escape' && maximizedPanelIdx !== null) {
        setMaximizedPanelIdx(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePanelIdx, gridDims.count, maximizedPanelIdx, stepPanelSlice]);

  const activePanel = panels[activePanelIdx] ?? panels[0];
  const activeFound = activePanel?.seriesInstanceUID
    ? seriesLookup.get(activePanel.seriesInstanceUID)
    : undefined;
  const activeSlice = activeFound
    ? activeFound.series.slices[activePanel.sliceIndex] ?? null
    : null;

  const visiblePanels =
    maximizedPanelIdx !== null
      ? [panels[maximizedPanelIdx]]
      : panels.slice(0, gridDims.count);

  const cacheInfo = getCacheStats();

  return (
    <div
      className="workstation-shell"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-lexdicom-series')) {
          e.preventDefault();
          setDragOverlayActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOverlayActive(false);
      }}
      onDrop={async (e) => {
        setDragOverlayActive(false);
        if (e.dataTransfer.types.includes('application/x-lexdicom-series')) return;
        e.preventDefault();
        const candidates = await collectFromDataTransfer(e.dataTransfer.items);
        await ingestCandidates(candidates);
      }}
    >
      {/* Hidden Folder & File Fallback Inputs */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error standard Chromium directory attribute
        webkitdirectory=""
        style={{ display: 'none' }}
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await ingestCandidates(collectFromFileList(e.target.files));
          }
          e.target.value = '';
        }}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await ingestCandidates(collectFromFileList(e.target.files));
          }
          e.target.value = '';
        }}
      />

      <TopToolbar
        bindings={bindings}
        onBindTool={(tool: ToolMode, mouseButton: 0 | 1 | 2) => {
          setActiveSchwabStep(null);
          setBindings((prev) => ({
            ...prev,
            [mouseButton === 1 ? 'middle' : mouseButton === 2 ? 'right' : 'left']: tool,
          }));
        }}
        gridLayout={gridLayout}
        onChangeGridLayout={(g) => {
          setMaximizedPanelIdx(null);
          setGridLayout(g);
        }}
        syncEnabled={syncEnabled}
        onToggleSync={() => setSyncEnabled((v) => !v)}
        showTextOverlay={showTextOverlay}
        onToggleTextOverlay={() => setShowTextOverlay((v) => !v)}
        cinePlaying={cinePlaying}
        onToggleCine={() => setCinePlaying((v) => !v)}
        onOpenFolder={handleOpenFolder}
        onOpenFiles={() => filesInputRef.current?.click()}
        onLoadSampleCase={() => ingestCandidates(buildSampleLegalCaseEntries())}
        onApplyPreset={(wc, ww) => {
          setPanels((prev) =>
            prev.map((p, idx) =>
              idx === activePanelIdx ? { ...p, windowCenter: wc, windowWidth: ww } : p
            )
          );
        }}
        onToggleInvert={() => {
          setPanels((prev) =>
            prev.map((p, idx) => (idx === activePanelIdx ? { ...p, invert: !p.invert } : p))
          );
        }}
        onResetViewport={() => {
          setPanels((prev) =>
            prev.map((p, idx) =>
              idx === activePanelIdx
                ? {
                    ...p,
                    zoom: 1,
                    panX: 0,
                    panY: 0,
                    invert: false,
                    windowCenter: -99999,
                    windowWidth: -99999,
                  }
                : p
            )
          );
        }}
        onOpenMpr={() => {
          if (activeFound?.series.isMprCapable) {
            setMprSeries(activeFound.series);
          }
        }}
        canOpenMpr={Boolean(activeFound?.series.isMprCapable)}
        exhibit={exhibit}
        onChangeExhibit={(patch) => setExhibit((prev) => ({ ...prev, ...patch }))}
        onExportExhibit={async (format) => {
          try {
            setStatusMessage('Rendering High-DPI 4K Courtroom Exhibit…');
            const exported = await exportCourtExhibitImage({
              format,
              gridCols: maximizedPanelIdx !== null ? 1 : gridDims.cols,
              gridRows: maximizedPanelIdx !== null ? 1 : gridDims.rows,
              panels: maximizedPanelIdx !== null ? [panels[maximizedPanelIdx]] : panels,
              studies,
              exhibit,
              showTextOverlay,
            });
            setStatusMessage(
              `Exported ${exported.filename} (${exported.width}×${exported.height} px)`
            );
          } catch (err: unknown) {
            setStatusMessage(
              `Export error: ${err instanceof Error ? err.message : 'Failed to export'}`
            );
          }
        }}
        schwabOpen={schwabOpen}
        onToggleSchwab={() => {
          setSchwabOpen((v) => {
            if (v) setActiveSchwabStep(null);
            return !v;
          });
        }}
        installPromptAvailable={Boolean(deferredInstallPrompt)}
        onInstallPwa={async () => {
          if (!deferredInstallPrompt) return;
          await deferredInstallPrompt.prompt();
          setDeferredInstallPrompt(null);
        }}
      />

      <main className="workspace-body">
        <SeriesRail
          studies={studies}
          activeSeriesUID={activePanel?.seriesInstanceUID ?? null}
          scrubPhi={exhibit.scrubPhi}
          onSelectSeries={(st, ser) =>
            hangSeriesInPanel(activePanelIdx, st.studyInstanceUID, ser.seriesInstanceUID)
          }
          onAutoCompareTimepoints={() => {
            if (studies.length < 2) return;
            const first = studies[0];
            const firstSeries = first.series[0];
            if (!firstSeries) return;
            // Match same modality & orientation plane across latest comparable study (e.g. MR SAG 2022 vs MR SAG 2024)
            let targetStudy = studies[studies.length - 1];
            let targetSeries = targetStudy.series[0];
            for (let i = studies.length - 1; i >= 1; i--) {
              const candidate = studies[i].series.find(
                (s) =>
                  s.modality === firstSeries.modality &&
                  s.orientationPlane === firstSeries.orientationPlane
              );
              if (candidate) {
                targetStudy = studies[i];
                targetSeries = candidate;
                break;
              }
            }
            if (!targetSeries) return;
            setMaximizedPanelIdx(null);
            setGridLayout('1x2');
            hangSeriesInPanel(0, first.studyInstanceUID, firstSeries.seriesInstanceUID);
            hangSeriesInPanel(1, targetStudy.studyInstanceUID, targetSeries.seriesInstanceUID);
          }}
          onClearAllStudies={() => {
            clearDecodeCache();
            setStudies([]);
            setPanels(Array.from({ length: MAX_PANELS }, (_, i) => createEmptyPanel(i)));
            setStatusMessage('Cleared all studies and released memory.');
          }}
          onOpenFolder={handleOpenFolder}
        />

        {/* Central RadiAnt Multi-Panel Viewport Grid */}
        <section
          className={`viewport-grid layout-${maximizedPanelIdx !== null ? '1x1' : gridLayout}`}
          aria-label="Diagnostic Viewport Grid"
        >
          {studies.length === 0 ? (
            <div className="welcome-hero">
              <div className="hero-card">
                <div className="hero-badge">
                  <Shield size={14} /> 100% Offline Local-First · Zero Cloud Uploads
                </div>
                <h1>LexDICOM Medicolegal Workstation</h1>
                <p>
                  Point to any unsorted legal-firm DICOM folder or hospital CD dump. LexDICOM
                  recursively crawls subfolders, sniffs extensionless DICOM headers, decodes lossless
                  hospital codecs, sorts studies chronologically, and exports courtroom-ready exhibits.
                </p>
                <div className="hero-actions">
                  <button type="button" className="hero-btn primary" onClick={handleOpenFolder}>
                    <FolderOpen size={18} />
                    <span>Open Unsorted DICOM Folder</span>
                  </button>
                  <button
                    type="button"
                    className="hero-btn secondary"
                    onClick={() => ingestCandidates(buildSampleLegalCaseEntries())}
                  >
                    <Sparkles size={18} />
                    <span>Load Sample Legal Case (2022 vs. 2024 MRI + Spine X-Ray)</span>
                  </button>
                </div>
                <div className="hero-shortcuts">
                  <span><strong>Left/Middle/Right-Click</strong> toolbar tools to customize mouse buttons</span>
                  <span>·</span>
                  <span><strong>Tab</strong> cycles maximized panels</span>
                  <span>·</span>
                  <span><strong>Exhibit Mode</strong> scrubs PHI & exports 4K plates</span>
                </div>
              </div>
            </div>
          ) : (
            visiblePanels.map((p) => {
              const found = p.seriesInstanceUID ? seriesLookup.get(p.seriesInstanceUID) : undefined;
              const sl = found ? found.series.slices[p.sliceIndex] ?? null : null;

              // Compute 3D Sagittal <-> Axial Scout Reference Lines from all other visible panels
              const scoutLines: { p1: { x: number; y: number }; p2: { x: number; y: number }; label: string }[] = [];
              if (sl && exhibit.showScoutLines) {
                for (const other of panels.slice(0, gridDims.count)) {
                  if (other.panelIndex === p.panelIndex || !other.seriesInstanceUID) continue;
                  const otherFound = seriesLookup.get(other.seriesInstanceUID);
                  const otherSlice = otherFound?.series.slices[other.sliceIndex];
                  if (!otherFound || !otherSlice) continue;
                  const seg = computeScoutIntersectionLine(otherSlice, sl);
                  if (seg) {
                    scoutLines.push({
                      p1: seg[0],
                      p2: seg[1],
                      label: `${otherFound.series.seriesDescription} (#${other.sliceIndex + 1})`,
                    });
                  }
                }
              }

              return (
                <ViewportPanel
                  key={p.panelIndex}
                  panel={p}
                  isActive={p.panelIndex === activePanelIdx}
                  isMaximized={maximizedPanelIdx === p.panelIndex}
                  study={found?.study ?? null}
                  series={found?.series ?? null}
                  slice={sl}
                  scoutLines={scoutLines}
                  bindings={bindings}
                  exhibit={exhibit}
                  showTextOverlay={showTextOverlay}
                  activeSchwabStep={p.panelIndex === activePanelIdx ? activeSchwabStep : null}
                  onActivatePanel={() => setActivePanelIdx(p.panelIndex)}
                  onUpdatePanel={(patch) => {
                    setPanels((prev) =>
                      prev.map((item, idx) =>
                        idx === p.panelIndex ? { ...item, ...patch } : item
                      )
                    );
                  }}
                  onStepSlice={(delta) => stepPanelSlice(p.panelIndex, delta)}
                  onToggleMaximize={() => {
                    setActivePanelIdx(p.panelIndex);
                    setMaximizedPanelIdx((cur) => (cur === p.panelIndex ? null : p.panelIndex));
                  }}
                  onCloseOrClearPanel={(clearAnnotationsOnly) => {
                    if (clearAnnotationsOnly) {
                      setPanels((prev) =>
                        prev.map((item, idx) =>
                          idx === p.panelIndex
                            ? { ...item, annotations: [], schwabLandmarks: {} }
                            : item
                        )
                      );
                    } else {
                      if (p.seriesInstanceUID) {
                        evictSeriesFromCache(p.seriesInstanceUID);
                      }
                      setPanels((prev) =>
                        prev.map((item, idx) =>
                          idx === p.panelIndex ? createEmptyPanel(idx) : item
                        )
                      );
                    }
                  }}
                  onDropSeries={(studyUID, seriesUID) =>
                    hangSeriesInPanel(p.panelIndex, studyUID, seriesUID)
                  }
                  onAdvanceSchwabStep={(placedKey) => {
                    const idx = SCHWAB_SEQUENCE.indexOf(placedKey);
                    if (idx >= 0 && idx + 1 < SCHWAB_SEQUENCE.length) {
                      setActiveSchwabStep(SCHWAB_SEQUENCE[idx + 1]);
                    } else {
                      setActiveSchwabStep(null);
                    }
                  }}
                  onHoverPixelValue={setHoverTelemetry}
                />
              );
            })
          )}
        </section>

        {/* On-Demand SRS-Schwab Spinopelvic Drawer (Zero Screen Clutter Unless Toggled) */}
        <SrsSchwabDrawer
          open={schwabOpen}
          onClose={() => {
            setSchwabOpen(false);
            setActiveSchwabStep(null);
          }}
          landmarks={activePanel?.schwabLandmarks ?? {}}
          activeStep={activeSchwabStep}
          onSelectStep={setActiveSchwabStep}
          onClearLandmarks={() => {
            setPanels((prev) =>
              prev.map((p, idx) => (idx === activePanelIdx ? { ...p, schwabLandmarks: {} } : p))
            );
          }}
          activeSlice={activeSlice}
          manualCalibrationMmPerPx={activePanel?.manualCalibrationMmPerPx}
          onActivateCalibrationTool={(tool) => setBindings((b) => ({ ...b, left: tool }))}
          onClearManualCalibration={() => {
            setPanels((prev) =>
              prev.map((p, idx) =>
                idx === activePanelIdx ? { ...p, manualCalibrationMmPerPx: undefined } : p
              )
            );
          }}
        />
      </main>

      {/* Bottom Compact RadiAnt Status Bar */}
      <footer className="status-bar">
        <div className="status-left">
          <span className="status-dot" />
          <span>{statusMessage}</span>
        </div>
        <div className="status-right">
          {hoverTelemetry && <span className="telemetry-chip">{hoverTelemetry}</span>}
          <span className="telemetry-chip">
            Mouse: L={bindings.left} · M={bindings.middle} · R={bindings.right}
          </span>
          <span className="telemetry-chip">
            Cache: {cacheInfo.cachedSlices} slices ({cacheInfo.usedMegabytes} / 256 MB)
          </span>
          <span>© 2026 A. Alex Mohit</span>
        </div>
      </footer>

      {/* Folder Ingestion Progress Modal */}
      {isScanning && scanProgress && (
        <div className="scan-overlay">
          <div className="scan-modal">
            <h3>Scanning Legal DICOM Directory…</h3>
            <p>
              Checked {scanProgress.scannedFiles} / {scanProgress.totalCandidateFiles} files ·{' '}
              <strong>{scanProgress.validDicomSlices} valid DICOM slices</strong> (skipped{' '}
              {scanProgress.skippedJunkFiles} non-DICOM files)
            </p>
            <div className="scan-bar-bg">
              <div
                className="scan-bar-fill"
                style={{
                  width: `${Math.round(
                    (scanProgress.scannedFiles / Math.max(1, scanProgress.totalCandidateFiles)) * 100
                  )}%`,
                }}
              />
            </div>
            <div className="scan-path">{scanProgress.currentPath}</div>
          </div>
        </div>
      )}

      {dragOverlayActive && (
        <div className="drop-zone-overlay">
          <div className="drop-card">
            <FolderOpen size={36} />
            <h2>Drop Unsorted DICOM Folder or Files Anywhere</h2>
            <p>Automatic recursive binary sniffing & chronological sorting</p>
          </div>
        </div>
      )}

      <MprModal series={mprSeries} onClose={() => setMprSeries(null)} />
    </div>
  );
};
