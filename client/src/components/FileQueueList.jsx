import { FileImage, FileText, FileArchive, X } from 'lucide-react';
import { formatBytes } from '../utils/format';
import { isPdfFile, isZipFile } from '../utils/fileTree';

function QueueIcon({ name }) {
  if (isZipFile(name)) return <FileArchive size={16} strokeWidth={1.7} />;
  if (isPdfFile(name)) return <FileText size={16} strokeWidth={1.7} />;
  return <FileImage size={16} strokeWidth={1.7} />;
}

export default function FileQueueList({ items, onRemove, disabled }) {
  return (
    <div className="queue-list">
      {items.map((item) => (
        <div className={`queue-row${isZipFile(item.file.name) ? ' zip-row' : ''}`} key={item.id}>
          <div className="file-icon"><QueueIcon name={item.file.name} /></div>
          <div className="file-meta">
            <div className="file-name">{item.file.name}</div>
            {isZipFile(item.file.name) ? (
              <div className="file-path">Will be unzipped automatically</div>
            ) : item.relativePath !== item.file.name && (
              <div className="file-path">{item.relativePath}</div>
            )}
          </div>
          <div className="file-size mono">{formatBytes(item.file.size)}</div>
          {!disabled && (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${item.file.name}`}
              onClick={() => onRemove(item.id)}
            >
              <X size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
