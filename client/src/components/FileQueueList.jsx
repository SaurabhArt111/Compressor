import { FileImage, X } from 'lucide-react';
import { formatBytes } from '../utils/format';

export default function FileQueueList({ items, onRemove, disabled }) {
  return (
    <div className="queue-list">
      {items.map((item) => (
        <div className="queue-row" key={item.id}>
          <div className="file-icon"><FileImage size={16} strokeWidth={1.7} /></div>
          <div className="file-meta">
            <div className="file-name">{item.file.name}</div>
            {item.relativePath !== item.file.name && (
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
