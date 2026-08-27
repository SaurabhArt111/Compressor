import { Archive } from 'lucide-react';
import ResultCard from './ResultCard';
import { downloadZipUrl } from '../utils/api';

export default function ResultsGrid({ jobId, files, showZipAction }) {
  const doneCount = files.filter((f) => f.status === 'done').length;

  return (
    <>
      <div className="section-header">
        <h3>Results</h3>
        {showZipAction && doneCount > 0 && (
          <a className="btn btn-primary btn-sm" href={downloadZipUrl(jobId)} download>
            <Archive size={14} /> Download all as ZIP ({doneCount})
          </a>
        )}
      </div>
      <div className="results-grid">
        {files.map((file) => (
          <ResultCard key={file.id} jobId={jobId} file={file} />
        ))}
      </div>
    </>
  );
}
