import { Minus, Plus, Zap, Square } from 'lucide-react';

const FORMAT_OPTIONS = [
  { value: 'auto', label: 'Auto (recommended)' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' },
  { value: 'png', label: 'PNG' },
];

export default function ControlBar({
  settings, updateSettings, isProcessing, canCompress, onCompress, onCancel,
}) {
  const setPreset = (preset) => updateSettings({ targetPreset: preset });
  const setMaxWidthPreset = (preset) => updateSettings({ maxWidthPreset: preset });

  return (
    <div className="control-bar">
      <div className="control-group">
        <span className="control-label">Target size</span>
        <div className="segmented" role="group" aria-label="Target size preset">
          <button type="button" className={settings.targetPreset === '10' ? 'active' : ''} onClick={() => setPreset('10')} disabled={isProcessing}>10 MB</button>
          <button type="button" className={settings.targetPreset === '12' ? 'active' : ''} onClick={() => setPreset('12')} disabled={isProcessing}>12 MB</button>
          <button type="button" className={settings.targetPreset === 'custom' ? 'active' : ''} onClick={() => setPreset('custom')} disabled={isProcessing}>Custom</button>
        </div>
      </div>

      {settings.targetPreset === 'custom' && (
        <div className="control-group">
          <span className="control-label">Custom target</span>
          <div className="custom-size-input">
            <input
              type="number"
              min="0.1"
              step="0.5"
              value={settings.customTargetMB}
              disabled={isProcessing}
              onChange={(e) => updateSettings({ customTargetMB: e.target.value })}
            />
            <span>MB</span>
          </div>
        </div>
      )}

      <div className="control-group">
        <span className="control-label">Maximum width</span>
        <div className="segmented" role="group" aria-label="Maximum width preset">
          <button type="button" className={settings.maxWidthPreset === 'original' ? 'active' : ''} onClick={() => setMaxWidthPreset('original')} disabled={isProcessing}>Original</button>
          <button type="button" className={settings.maxWidthPreset === '3000' ? 'active' : ''} onClick={() => setMaxWidthPreset('3000')} disabled={isProcessing}>3000 px</button>
          <button type="button" className={settings.maxWidthPreset === '4000' ? 'active' : ''} onClick={() => setMaxWidthPreset('4000')} disabled={isProcessing}>4000 px</button>
          <button type="button" className={settings.maxWidthPreset === '6000' ? 'active' : ''} onClick={() => setMaxWidthPreset('6000')} disabled={isProcessing}>6000 px</button>
          <button type="button" className={settings.maxWidthPreset === 'custom' ? 'active' : ''} onClick={() => setMaxWidthPreset('custom')} disabled={isProcessing}>Custom</button>
        </div>
      </div>

      {settings.maxWidthPreset === 'custom' && (
        <div className="control-group">
          <span className="control-label">Custom width</span>
          <div className="custom-size-input">
            <input
              type="number"
              min="1"
              step="10"
              value={settings.customMaxWidth}
              disabled={isProcessing}
              onChange={(e) => updateSettings({ customMaxWidth: e.target.value })}
            />
            <span>px</span>
          </div>
        </div>
      )}

      <div className="control-group">
        <span className="control-label">Output format</span>
        <select
          className="select-input"
          value={settings.format}
          disabled={isProcessing}
          onChange={(e) => updateSettings({ format: e.target.value })}
        >
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="control-group">
        <span className="control-label">Concurrency</span>
        <div className="stepper">
          <button
            type="button"
            aria-label="Decrease concurrency"
            disabled={isProcessing || settings.concurrency <= 1}
            onClick={() => updateSettings({ concurrency: Math.max(1, settings.concurrency - 1) })}
          >
            <Minus size={13} />
          </button>
          <span className="stepper-value mono">{settings.concurrency}</span>
          <button
            type="button"
            aria-label="Increase concurrency"
            disabled={isProcessing || settings.concurrency >= 6}
            onClick={() => updateSettings({ concurrency: Math.min(6, settings.concurrency + 1) })}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div className="control-spacer" />

      <div className="control-actions">
        {isProcessing ? (
          <button type="button" className="btn btn-danger" onClick={onCancel}>
            <Square size={14} /> Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onCompress} disabled={!canCompress}>
            <Zap size={15} /> Compress all
          </button>
        )}
      </div>
    </div>
  );
}
