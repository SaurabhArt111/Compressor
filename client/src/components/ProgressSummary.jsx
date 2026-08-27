import { formatDuration } from '../utils/format';

export default function ProgressSummary({ total, completed, cancelling, durationMs }) {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="progress-summary">
      <div className="progress-track">
        <div className={`progress-fill${cancelling ? ' cancelling' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="count">
        {cancelling ? 'Cancelling… ' : ''}{completed} / {total} files
      </span>
      <span className="elapsed" title="Batch compression time">{formatDuration(durationMs)}</span>
    </div>
  );
}
