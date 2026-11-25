import React from 'react';
import { Calendar, FolderPlus, Trash2 } from 'lucide-react';
import { DicomSeries, DicomStudy } from '../types/dicom';

interface SeriesRailProps {
  studies: DicomStudy[];
  activeSeriesUID: string | null;
  scrubPhi: boolean;
  onSelectSeries: (study: DicomStudy, series: DicomSeries) => void;
  onAutoCompareTimepoints: () => void;
  onClearAllStudies: () => void;
  onOpenFolder: () => void;
}

export const SeriesRail: React.FC<SeriesRailProps> = ({
  studies,
  activeSeriesUID,
  scrubPhi,
  onSelectSeries,
  onAutoCompareTimepoints,
  onClearAllStudies,
  onOpenFolder,
}) => {
  const totalSeries = studies.reduce((acc, s) => acc + s.series.length, 0);
  const totalSlices = studies.reduce(
    (acc, st) => acc + st.series.reduce((sa, ser) => sa + ser.slices.length, 0),
    0
  );

  return (
    <aside className="series-rail" aria-label="Chronological Study & Series Rail">
      <div className="rail-header">
        <div>
          <div className="rail-title">STUDIES ({studies.length})</div>
          <div className="rail-subtitle">
            {totalSeries} series · {totalSlices} slices
          </div>
        </div>
        <div className="rail-actions">
          {studies.length >= 2 && (
            <button
              type="button"
              className="rail-mini-btn accent"
              onClick={onAutoCompareTimepoints}
              title="Automatically hang earliest vs. latest timepoint side-by-side in 1x2 comparison"
            >
              Compare Dates
            </button>
          )}
          {studies.length > 0 && (
            <button
              type="button"
              className="rail-icon-btn"
              onClick={onClearAllStudies}
              title="Close all loaded studies & release slice cache"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {studies.length === 0 ? (
        <div className="rail-empty">
          <FolderPlus size={26} className="muted-icon" />
          <p>Drop any unsorted legal DICOM folder here or click Open Folder.</p>
          <button type="button" className="rail-mini-btn accent" onClick={onOpenFolder}>
            Choose Folder…
          </button>
        </div>
      ) : (
        <div className="rail-scroll">
          {studies.map((study, sIdx) => (
            <div key={study.studyInstanceUID} className="study-block">
              <div className="study-header">
                <div className="study-patient">
                  {scrubPhi ? 'REDACTED PATIENT' : study.patientName}
                </div>
                <div className="study-date-row">
                  <Calendar size={12} />
                  <span className="study-date">{study.studyDateFormatted}</span>
                  <span className="timepoint-tag">T{sIdx + 1}</span>
                </div>
                <div className="study-desc" title={study.studyDescription}>
                  {study.studyDescription}
                </div>
              </div>

              <div className="series-list">
                {study.series.map((series) => {
                  const isSelected = series.seriesInstanceUID === activeSeriesUID;
                  return (
                    <div
                      key={series.seriesInstanceUID}
                      className={`series-card ${isSelected ? 'selected' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          'application/x-lexdicom-series',
                          JSON.stringify({
                            studyInstanceUID: study.studyInstanceUID,
                            seriesInstanceUID: series.seriesInstanceUID,
                          })
                        );
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => onSelectSeries(study, series)}
                      title={`Click to load into active panel, or drag into any viewport panel (${series.seriesDescription})`}
                    >
                      <div className="series-thumb-box">
                        {series.thumbnailDataUrl ? (
                          <img
                            src={series.thumbnailDataUrl}
                            alt={series.seriesDescription}
                            className="series-thumb-img"
                          />
                        ) : (
                          <div className="series-thumb-placeholder">{series.modality}</div>
                        )}
                        <span className="slice-count-badge">{series.slices.length}</span>
                        <span className="plane-badge">{series.orientationPlane.slice(0, 3)}</span>
                      </div>

                      <div className="series-meta">
                        <div className="series-name">{series.seriesDescription}</div>
                        <div className="series-sub">
                          <span>{series.modality}</span>
                          <span>#{series.seriesNumber}</span>
                          {series.isMprCapable && <span className="mpr-pill">MPR</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
};
