import { Archive } from 'lucide-react';
import ResultCard from './ResultCard';
import { downloadZipUrl } from '../utils/api';

export default function ResultsGrid({ jobId, files, showZipAction, onRetryFile }) {
  const doneCount = files.filter((f) => f.status === 'done').length;
  const failedCount = files.filter((f) => f.status === 'error').length;
  const processingCount = files.filter((f) => f.status === 'processing').length;
  const cancelledCount = files.filter((f) => f.status === 'cancelled').length;

  return (
    <>
      <div className="section-header">
        <h3>Results</h3>
        <div className="result-summary-badges" aria-label="Compression summary">
          <span className="summary-pill success">{doneCount} success</span>
          <span className="summary-pill danger">{failedCount} failed</span>
          {processingCount > 0 && <span className="summary-pill neutral">{processingCount} processing</span>}
          {cancelledCount > 0 && <span className="summary-pill neutral">{cancelledCount} cancelled</span>}
        </div>
        {showZipAction && doneCount > 0 && (
          <a className="btn btn-primary btn-sm" href={downloadZipUrl(jobId)} download>
            <Archive size={14} /> Download all as ZIP ({doneCount})
          </a>
        )}
      </div>
      <div className="results-grid">
        {files.map((file) => (
          <ResultCard key={file.id} jobId={jobId} file={file} onRetry={() => onRetryFile?.(file.id)} />
        ))}
      </div>
    </>
  );
}
