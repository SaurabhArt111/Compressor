import { useRef, useState } from 'react';
import { UploadCloud, FolderInput, FileImage } from 'lucide-react';
import { collectFilesFromDataTransfer, collectFilesFromInput } from '../utils/fileTree';

export default function Dropzone({ onFilesAdded, disabled }) {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const dragCounter = useRef(0);

  const handleDrop = async (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    if (disabled) return;
    const items = await collectFilesFromDataTransfer(e.dataTransfer);
    if (items.length > 0) onFilesAdded(items);
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragCounter.current += 1;
    setDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) setDragging(false);
  };

  const handleInputChange = (e) => {
    const items = collectFilesFromInput(e.target.files);
    if (items.length > 0) onFilesAdded(items);
    e.target.value = ''; // allow re-selecting the same file/folder later
  };

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
    >
      <div className="dropzone-icon">
        <UploadCloud size={26} strokeWidth={1.7} />
      </div>
      <h2>Drag files, a folder, or a ZIP here</h2>
      <p>JPG, PNG, WebP, TIFF, GIF, BMP, AVIF, HEIC, PDF — or a ZIP full of any of these — one file, a folder, or a whole shoot at once. Files up to 300-500MB (and beyond) are fine.</p>
      <div className="dropzone-actions">
        <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={disabled}>
          <FileImage size={15} /> Select files
        </button>
        <button type="button" className="btn" onClick={() => folderInputRef.current?.click()} disabled={disabled}>
          <FolderInput size={15} /> Select folder
        </button>
      </div>
      <p className="dropzone-hint">A ZIP is unzipped automatically and every supported file inside it is queued for compression.</p>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.tif,.tiff,.heic,.heif,.avif,.pdf,.zip,application/pdf,application/zip"
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />
    </div>
  );
}
