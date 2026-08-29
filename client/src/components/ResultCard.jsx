import { Download, CheckCircle2, AlertTriangle, XCircle, Ban, ImageOff, LoaderCircle, FileText } from 'lucide-react';
import CompareSlider from './CompareSlider';
import QualityDial from './QualityDial';
import { formatBytes, formatPercent, formatResolution } from '../utils/format';
import { downloadFileUrl, thumbnailUrl } from '../utils/api';

function StatusBadge({ file }) {
  if (file.status === 'error') return <span className="badge badge-danger"><XCircle size={12} /> Failed</span>;
  if (file.status === 'cancelled') return <span className="badge badge-neutral"><Ban size={12} /> Cancelled</span>;
  if (file.status !== 'done') return null;
  if (file.result?.unchanged) return <span className="badge badge-neutral">Already optimal</span>;
  if (file.result?.targetReached) return <span className="badge badge-success"><CheckCircle2 size={12} /> Target reached</span>;
  return <span className="badge badge-warn"><AlertTriangle size={12} /> Target not reached</span>;
}

export default function ResultCard({ jobId, file }) {
  const { result } = file;
  const processingStage = file.progress?.stage || 'Working...';
  const isPdf = file.kind === 'pdf' || result?.format === 'pdf';

  return (
    <div className="result-card">
      <div className="result-preview">
        {file.status === 'done' && isPdf ? (
          <div className="pdf-preview">
            <FileText size={36} strokeWidth={1.3} />
            <span className="pdf-preview-label">
              {result?.pageCount ? `${result.pageCount} page${result.pageCount === 1 ? '' : 's'}` : 'PDF document'}
            </span>
          </div>
        ) : file.status === 'done' ? (
          <CompareSlider
            beforeSrc={thumbnailUrl(jobId, file.id, 'original')}
            afterSrc={thumbnailUrl(jobId, file.id, 'compressed')}
          />
        ) : file.status === 'error' ? (
          <div className="placeholder"><ImageOff size={28} strokeWidth={1.5} /></div>
        ) : (
          <div className="processing-preview" aria-label={`${processingStage} for ${file.originalName}`}>
            <div className="skeleton skeleton-preview" />
            <div className="processing-indicator">
              <LoaderCircle className="loader" size={24} />
              <span>{processingStage}</span>
            </div>
          </div>
        )}
      </div>

      <div className="result-body">
        <div className="result-title">
          <div style={{ minWidth: 0 }}>
            <div className="name">{file.originalName}</div>
            {file.relativePath !== file.originalName && <div className="path">{file.relativePath}</div>}
          </div>
          <StatusBadge file={file} />
        </div>

        {file.status === 'processing' && (
          <div className="processing-details">
            <div className="processing-stage">
              <LoaderCircle className="loader" size={14} />
              <span>{processingStage}</span>
            </div>
            <div className="mini-progress">
              <div className="mini-progress-fill" style={{ width: `${file.progress?.percent || 0}%` }} />
            </div>
            <div className="skeleton-lines" aria-hidden="true">
              <span className="skeleton skeleton-line skeleton-line-wide" />
              <span className="skeleton skeleton-line skeleton-line-short" />
            </div>
          </div>
        )}

        {file.status === 'error' && (
          <div className="result-error">{file.error || 'Compression failed.'}</div>
        )}

        {file.status === 'done' && result && (
          <>
            <div className="result-stats">
              <div className="stat-block">
                <span className="stat-label">Original</span>
                <span className="stat-value">{formatBytes(result.originalSize)}</span>
              </div>
              <div className="stat-block">
                <span className="stat-label">Compressed</span>
                <span className="stat-value accent">{formatBytes(result.compressedSize)}</span>
              </div>
              {isPdf ? (
                <>
                  <div className="stat-block">
                    <span className="stat-label">Pages</span>
                    <span className="stat-value">{result.pageCount ?? '—'}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">Images compressed</span>
                    <span className="stat-value">{result.imagesFound ? `${result.imagesCompressed}/${result.imagesFound}` : 'none found'}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="stat-block">
                    <span className="stat-label">Resolution</span>
                    <span className="stat-value">
                      {result.scale < 1
                        ? `${formatResolution(result.width, result.height)} (was ${formatResolution(result.originalWidth, result.originalHeight)})`
                        : formatResolution(result.width, result.height)}
                    </span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">Format</span>
                    <span className="stat-value">{result.format?.toUpperCase()}</span>
                  </div>
                </>
              )}
            </div>

            <div className="result-dial-row">
              <QualityDial quality={result.quality} targetReached={result.targetReached} />
              <div className="dial-caption">
                <div className="reduction">{formatPercent(result.reductionPercent)}</div>
                <div className="reduction-label">size reduction</div>
              </div>
            </div>

            <div className="result-actions">
              <a className="btn btn-sm" href={downloadFileUrl(jobId, file.id)} download>
                <Download size={13} /> Download
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
