import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FolderOpen, Folder, ChevronRight, ChevronDown, File as FileIcon,
  FileImage, FileText, Trash2, RefreshCcw, HardDrive, Loader2, Lock,
} from 'lucide-react';
import { fetchFileTree, deleteFilePath, clearAllFiles } from '../utils/api';
import { formatBytes, formatDate } from '../utils/format';
import { isPdfFile } from '../utils/fileTree';

function NodeIcon({ node, expanded }) {
  if (node.type === 'dir') {
    return expanded ? <FolderOpen size={16} strokeWidth={1.7} /> : <Folder size={16} strokeWidth={1.7} />;
  }
  if (isPdfFile(node.name)) return <FileText size={15} strokeWidth={1.7} />;
  if (/\.(jpe?g|png|webp|tiff?|gif|bmp|avif|heic|heif)$/i.test(node.name)) return <FileImage size={15} strokeWidth={1.7} />;
  return <FileIcon size={15} strokeWidth={1.7} />;
}

function TreeNode({ node, depth, expandedPaths, onToggle, onDelete, deletingPath }) {
  const expanded = node.type === 'dir' && expandedPaths.has(node.path);
  const isDeleting = deletingPath === node.path;
  const locked = node.type === 'dir' && node.active;

  return (
    <div className="tree-node">
      <div className={`tree-row${locked ? ' locked' : ''}`} style={{ paddingLeft: 10 + depth * 18 }}>
        <button
          type="button"
          className="tree-row-main"
          onClick={() => node.type === 'dir' && onToggle(node.path)}
          disabled={node.type !== 'dir'}
        >
          {node.type === 'dir' ? (
            <span className="tree-caret" aria-hidden="true">
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : <span className="tree-caret" aria-hidden="true" />}
          <span className="tree-icon"><NodeIcon node={node} expanded={expanded} /></span>
          <span className="tree-name">{node.name}</span>
          {locked && <span className="badge badge-neutral tree-badge"><Lock size={10} /> processing</span>}
        </button>
        <span className="tree-meta">
          {node.type === 'dir' && <span className="tree-count">{node.fileCount} file{node.fileCount === 1 ? '' : 's'}</span>}
          <span className="tree-size mono">{formatBytes(node.size)}</span>
          <span className="tree-date">{formatDate(node.mtime)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete ${node.name}`}
            title={locked ? 'This job is still processing' : `Delete ${node.name}`}
            disabled={locked || isDeleting}
            onClick={() => onDelete(node)}
          >
            {isDeleting ? <Loader2 size={14} className="loader" /> : <Trash2 size={14} />}
          </button>
        </span>
      </div>
      {node.type === 'dir' && expanded && node.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          onDelete={onDelete}
          deletingPath={deletingPath}
        />
      ))}
    </div>
  );
}

export default function FileManagerView() {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [deletingPath, setDeletingPath] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    fetchFileTree()
      .then((data) => setTree(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = (path) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handleDelete = async (node) => {
    const label = node.type === 'dir' ? `the folder "${node.name}" and everything in it` : `"${node.name}"`;
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setDeletingPath(node.path);
    setError('');
    setNotice('');
    try {
      await deleteFilePath(node.path);
      setNotice(`Deleted ${node.name}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingPath(null);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Delete every uploaded and compressed file on the server? Jobs still processing will be skipped. This can\'t be undone.')) return;
    setClearing(true);
    setError('');
    setNotice('');
    try {
      const result = await clearAllFiles();
      setNotice(result.skipped?.length > 0
        ? `Cleared everything except ${result.skipped.length} job${result.skipped.length === 1 ? '' : 's'} still processing.`
        : 'Cleared all uploaded files.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClearing(false);
    }
  };

  const children = tree?.children || [];
  const hasFiles = children.length > 0;

  const totalLabel = useMemo(() => {
    if (!tree) return '';
    return `${tree.totalFiles} file${tree.totalFiles === 1 ? '' : 's'} · ${formatBytes(tree.totalSize)}`;
  }, [tree]);

  return (
    <div>
      <div className="section-header">
        <h3>Uploaded files</h3>
        <span className="meta">{loading ? 'Loading…' : totalLabel}</span>
      </div>

      {error && (
        <div className="banner banner-danger" style={{ marginBottom: 12 }}>{error}</div>
      )}
      {notice && !error && (
        <div className="banner banner-success" style={{ marginBottom: 12 }}>{notice}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          <RefreshCcw size={13} /> Refresh
        </button>
        {/* <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearAll} disabled={clearing || !hasFiles}>
          <Trash2 size={13} /> Clear all
        </button> */}
      </div>

      {loading && !tree && (
        <div className="panel" style={{ padding: 16 }}>
          <div className="skeleton-lines">
            <span className="skeleton skeleton-line skeleton-line-wide" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line skeleton-line-short" />
          </div>
        </div>
      )}

      {!loading && !hasFiles && !error && (
        <div className="empty-note">
          <div className="icon-wrap"><HardDrive size={22} strokeWidth={1.6} /></div>
          <p>No files on the server yet. Anything you upload to compress will show up here.</p>
        </div>
      )}

      {hasFiles && (
        <div className="panel tree-panel" style={{ padding: '6px 0' }}>
          {children.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expandedPaths={expandedPaths}
              onToggle={handleToggle}
              onDelete={handleDelete}
              deletingPath={deletingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}
