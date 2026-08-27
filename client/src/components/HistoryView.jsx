import { useEffect, useState } from 'react';
import { History as HistoryIcon, Trash2 } from 'lucide-react';
import { fetchHistory, clearHistory, removeHistoryRecord, downloadZipUrl } from '../utils/api';
import { formatBytes, formatDate, formatPercent } from '../utils/format';

export default function HistoryView() {
  const [records, setRecords] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    fetchHistory().then(setRecords).catch((err) => setError(err.message));
  };

  useEffect(() => { load(); }, []);

  const handleClear = async () => {
    if (!window.confirm('Clear all processing history? This does not delete any downloaded files.')) return;
    await clearHistory();
    load();
  };

  const handleRemove = async (jobId) => {
    if (!window.confirm('Remove this batch from processing history?')) return;
    try {
      await removeHistoryRecord(jobId);
      setRecords((previous) => previous.filter((record) => record.jobId !== jobId));
    } catch (err) {
      setError(err.message);
    }
  };

  if (error) return <div className="banner banner-danger">{error}</div>;
  if (records === null) return <p style={{ color: 'var(--text-tertiary)' }}>Loading history…</p>;

  if (records.length === 0) {
    return (
      <div className="empty-note">
        <div className="icon-wrap"><HistoryIcon size={22} strokeWidth={1.6} /></div>
        <p>No jobs yet. Compressed batches will show up here.</p>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 16px 0' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear}>
          <Trash2 size={13} /> Clear history
        </button>
      </div>
      <table className="history-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Files</th>
            <th>Original</th>
            <th>Compressed</th>
            <th>Reduction</th>
            <th>Target</th>
            <th>Format</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.jobId}-${r.finishedAt}`}>
              <td>{formatDate(r.finishedAt)}</td>
              <td className="num">
                {r.successCount}/{r.fileCount}
                {r.errorCount > 0 && <span style={{ color: 'var(--danger)' }}> ({r.errorCount} failed)</span>}
                {r.cancelled && <span style={{ color: 'var(--warn)' }}> (cancelled)</span>}
              </td>
              <td className="num">{formatBytes(r.totalOriginalSize)}</td>
              <td className="num">{formatBytes(r.totalCompressedSize)}</td>
              <td className="num">{formatPercent(r.averageReductionPercent)}</td>
              <td className="num">{r.settings?.targetMB} MB</td>
              <td>{r.settings?.format}</td>
              <td>
                <div className="history-actions">
                  {r.successCount > 0 && (
                    <a className="btn btn-ghost btn-sm" href={downloadZipUrl(r.jobId)} download>ZIP</a>
                  )}
                  <button type="button" className="icon-btn" onClick={() => handleRemove(r.jobId)} aria-label={`Remove ${r.jobId} from history`} title="Remove from history">
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
