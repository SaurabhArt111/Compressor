import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, X, RefreshCcw } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Dropzone from './components/Dropzone';
import FileQueueList from './components/FileQueueList';
import ControlBar from './components/ControlBar';
import ProgressSummary from './components/ProgressSummary';
import ResultsGrid from './components/ResultsGrid';
import HistoryView from './components/HistoryView';
import SettingsView from './components/SettingsView';
import { useSettings } from './context/SettingsContext';
import { useJobSocket } from './hooks/useSocket';
import { uploadFiles, startCompression, cancelJob, downloadZipUrl, fetchJob } from './utils/api';
import { formatBytes } from './utils/format';

let idCounter = 0;
const nextId = () => `f${Date.now()}_${idCounter++}`;
const ACTIVE_JOB_KEY = 'image-compressor-active-job';

export default function App() {
  const [view, setView] = useState('compress');
  const [queuedItems, setQueuedItems] = useState([]);
  const [job, setJob] = useState(null); // { id, files: [...] }
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const zipAnchorRef = useRef(null);

  const { settings, updateSettings, targetMB } = useSettings();

  const isProcessing = job?.status === 'processing';
  const hasFinishedJob = job && (job.status === 'done' || job.status === 'cancelled');

  useEffect(() => {
    const savedJobId = window.localStorage.getItem(ACTIVE_JOB_KEY);
    if (!savedJobId) return undefined;
    let active = true;
    fetchJob(savedJobId)
      .then((savedJob) => {
        if (active) setJob(savedJob);
      })
      .catch(() => window.localStorage.removeItem(ACTIVE_JOB_KEY));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!job?.startedAt || job.status !== 'processing') return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.startedAt, job?.status]);

  useEffect(() => {
    if (job?.id) window.localStorage.setItem(ACTIVE_JOB_KEY, job.id);
  }, [job?.id]);

  useEffect(() => {
    const warnBeforeLeaving = (event) => {
      if (!uploading && !isProcessing) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [uploading, isProcessing]);

  const handleFilesAdded = (items) => {
    setError('');
    setQueuedItems((prev) => [...prev, ...items.map((it) => ({ ...it, id: nextId() }))]);
  };

  const handleRemove = (id) => {
    setQueuedItems((prev) => prev.filter((it) => it.id !== id));
  };

  const handleStartNewBatch = () => {
    setJob(null);
    window.localStorage.removeItem(ACTIVE_JOB_KEY);
    setQueuedItems([]);
    setError('');
    setCancelling(false);
  };

  const handleCompress = async () => {
    if (queuedItems.length === 0) return;
    setError('');
    setUploading(true);
    setUploadProgress(0);
    try {
      const uploaded = await uploadFiles(queuedItems, setUploadProgress);
      window.localStorage.setItem(ACTIVE_JOB_KEY, uploaded.id);
      setJob(uploaded);
      setQueuedItems([]);
      setUploading(false);

      await startCompression(uploaded.id, {
        targetMB,
        format: settings.format,
        concurrency: settings.concurrency,
        qualityFloor: settings.qualityFloor,
        qualityCeiling: settings.qualityCeiling,
      });
      setJob((prev) => (prev && prev.id === uploaded.id ? { ...prev, status: 'processing' } : prev));
    } catch (err) {
      setUploading(false);
      setError(err.message || 'Something went wrong while starting compression.');
    }
  };

  const handleCancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await cancelJob(job.id);
    } catch (err) {
      setError(err.message);
      setCancelling(false);
    }
  };

  const updateFile = (fileId, patch) => {
    setJob((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        files: prev.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)),
      };
    });
  };

  useJobSocket(job?.id, {
    file_start: ({ fileId }) => updateFile(fileId, { status: 'processing', progress: { percent: 1, stage: 'starting' } }),
    file_progress: ({ fileId, percent, stage }) => updateFile(fileId, { progress: { percent, stage } }),
    file_done: ({ fileId, file: updated }) => updateFile(fileId, updated),
    file_error: ({ fileId, error: errMsg }) => updateFile(fileId, { status: 'error', error: errMsg }),
    file_cancelled: ({ fileId }) => updateFile(fileId, { status: 'cancelled' }),
    job_done: (summary) => {
      setCancelling(false);
      setJob((prev) => (prev && prev.id === summary.jobId
        ? {
          ...prev,
          status: summary.cancelled ? 'cancelled' : 'done',
          startedAt: summary.startedAt ?? prev.startedAt,
          finishedAt: summary.finishedAt,
          durationMs: summary.durationMs,
        }
        : prev));
      if (settings.autoDownloadZip && summary.successCount > 0 && !summary.cancelled) {
        zipAnchorRef.current?.click();
      }
    },
    job_cancelling: () => setCancelling(true),
  });

  const totalQueuedBytes = useMemo(
    () => queuedItems.reduce((sum, it) => sum + it.file.size, 0),
    [queuedItems],
  );

  const completedCount = job?.files.filter((f) => ['done', 'error', 'cancelled'].includes(f.status)).length || 0;

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} />
      <div className="main-area">
        <div className="topbar">
          <div>
            <h1>Compressor</h1>
            <div className="subtitle">Batch-shrink large images to a target file size, without leaving your machine.</div>
          </div>
          <span className="privacy-chip"><ShieldCheck size={13} /> Processed locally — never uploaded to the cloud</span>
        </div>

        <div className="view-container">
          {error && (
            <div className="banner banner-danger">
              {error}
              <button type="button" className="icon-btn" onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}

          {view === 'compress' && (
            <>
              {!job && (
                <>
                  <Dropzone onFilesAdded={handleFilesAdded} disabled={uploading} />

                  {queuedItems.length > 0 && (
                    <>
                      <div className="section-header">
                        <h3>Queued images</h3>
                        <span className="meta">{queuedItems.length} files · {formatBytes(totalQueuedBytes)}</span>
                      </div>
                      <FileQueueList items={queuedItems} onRemove={handleRemove} disabled={uploading} />

                      <ControlBar
                        settings={settings}
                        updateSettings={updateSettings}
                        isProcessing={uploading}
                        canCompress={queuedItems.length > 0 && !uploading}
                        onCompress={handleCompress}
                        onCancel={() => {}}
                      />

                      {uploading && (
                        <div className="progress-summary">
                          <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${Math.round(uploadProgress * 100)}%` }} />
                          </div>
                          <span className="count">Uploading… {Math.round(uploadProgress * 100)}%</span>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {job && (
                <>
                  <ControlBar
                    settings={settings}
                    updateSettings={updateSettings}
                    isProcessing={isProcessing}
                    canCompress={false}
                    onCompress={() => {}}
                    onCancel={handleCancel}
                  />

                  <ProgressSummary
                    total={job.files.length}
                    completed={completedCount}
                    cancelling={cancelling}
                    durationMs={job.durationMs ?? (job.startedAt ? clock - job.startedAt : 0)}
                  />

                  <ResultsGrid jobId={job.id} files={job.files} showZipAction={hasFinishedJob} />

                  {/* Hidden anchor used for the "auto-download ZIP" setting */}
                  <a ref={zipAnchorRef} href={downloadZipUrl(job.id)} download style={{ display: 'none' }} aria-hidden="true">zip</a>

                  {hasFinishedJob && (
                    <div style={{ marginTop: 22 }}>
                      <button type="button" className="btn" onClick={handleStartNewBatch}>
                        <RefreshCcw size={14} /> Start a new batch
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {view === 'history' && <HistoryView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>
    </div>
  );
}
