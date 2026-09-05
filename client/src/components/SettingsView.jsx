import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { fetchServerConfig } from '../utils/api';

function Toggle({ on, onChange, label }) {
  return (
    <div className="toggle-row">
      <div>
        <div className="settings-field-label">{label}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`toggle${on ? ' on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

export default function SettingsView() {
  const { settings, updateSettings, resetSettings } = useSettings();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [maxServerConcurrency, setMaxServerConcurrency] = useState(6);
  const [maxWidthBounds, setMaxWidthBounds] = useState({ min: 16, max: 20000 });

  useEffect(() => {
    fetchServerConfig()
      .then((cfg) => {
        if (cfg.maxServerConcurrency) setMaxServerConcurrency(cfg.maxServerConcurrency);
        if (cfg.maxWidthMinPx && cfg.maxWidthMaxPx) setMaxWidthBounds({ min: cfg.maxWidthMinPx, max: cfg.maxWidthMaxPx });
      })
      .catch(() => {}); // keep the fallback bounds if the server can't be reached
  }, []);

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="panel">
        <div className="panel-title">Defaults for new jobs</div>

        <div className="settings-field">
          <span className="settings-field-label">Default target size</span>
          <div className="segmented" style={{ width: 'fit-content' }}>
            <button type="button" className={settings.targetPreset === '10' ? 'active' : ''} onClick={() => updateSettings({ targetPreset: '10' })}>10 MB</button>
            <button type="button" className={settings.targetPreset === '12' ? 'active' : ''} onClick={() => updateSettings({ targetPreset: '12' })}>12 MB</button>
            <button type="button" className={settings.targetPreset === 'custom' ? 'active' : ''} onClick={() => updateSettings({ targetPreset: 'custom' })}>Custom</button>
          </div>
          {settings.targetPreset === 'custom' && (
            <div className="custom-size-input" style={{ width: 'fit-content', marginTop: 4 }}>
              <input
                type="number"
                min="0.1"
                step="0.5"
                value={settings.customTargetMB}
                onChange={(e) => updateSettings({ customTargetMB: e.target.value })}
              />
              <span>MB</span>
            </div>
          )}
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Default maximum width</span>
          <div className="segmented" style={{ width: 'fit-content' }}>
            <button type="button" className={settings.maxWidthPreset === 'original' ? 'active' : ''} onClick={() => updateSettings({ maxWidthPreset: 'original' })}>Original</button>
            <button type="button" className={settings.maxWidthPreset === '3000' ? 'active' : ''} onClick={() => updateSettings({ maxWidthPreset: '3000' })}>3000 px</button>
            <button type="button" className={settings.maxWidthPreset === '4000' ? 'active' : ''} onClick={() => updateSettings({ maxWidthPreset: '4000' })}>4000 px</button>
            <button type="button" className={settings.maxWidthPreset === '6000' ? 'active' : ''} onClick={() => updateSettings({ maxWidthPreset: '6000' })}>6000 px</button>
            <button type="button" className={settings.maxWidthPreset === 'custom' ? 'active' : ''} onClick={() => updateSettings({ maxWidthPreset: 'custom' })}>Custom</button>
          </div>
          {settings.maxWidthPreset === 'custom' && (
            <div className="custom-size-input" style={{ width: 'fit-content', marginTop: 4 }}>
              <input
                type="number"
                min={maxWidthBounds.min}
                max={maxWidthBounds.max}
                step="10"
                value={settings.customMaxWidth}
                onChange={(e) => updateSettings({ customMaxWidth: e.target.value })}
              />
              <span>px</span>
            </div>
          )}
          <span className="settings-field-hint">
            Resizes images down to this maximum width before compressing (aspect ratio preserved, images are never
            upscaled). &quot;Original&quot; leaves dimensions untouched, exactly like this compressor always has.
          </span>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Default output format</span>
          <select
            className="select-input"
            style={{ width: 'fit-content' }}
            value={settings.format}
            onChange={(e) => updateSettings({ format: e.target.value })}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="avif">AVIF</option>
            <option value="png">PNG</option>
          </select>
          <span className="settings-field-hint">
            Auto picks WebP or AVIF for photos and WebP for images that need transparency, favoring AVIF only on
            smaller images where its much slower encoder is still fast enough for a responsive compression search.
          </span>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">Default concurrency</span>
          <div className="range-row" style={{ maxWidth: 280 }}>
            <input
              type="range"
              min="1"
              max={maxServerConcurrency}
              value={Math.min(settings.concurrency, maxServerConcurrency)}
              onChange={(e) => updateSettings({ concurrency: Number(e.target.value) })}
            />
            <span className="range-value mono">{Math.min(settings.concurrency, maxServerConcurrency)}</span>
          </div>
          <span className="settings-field-hint">
            How many files are compressed in parallel. This server allows up to {maxServerConcurrency} at once
            (set via <code>MAX_SERVER_CONCURRENCY</code>). Higher is faster on a batch of many small files, but each
            very large file (300MB+) already uses significant memory on its own, so if you're processing several
            huge files together, a lower value avoids competing for RAM and swapping, which is slower overall than
            just queuing them.
          </span>
        </div>

        <Toggle
          label="Auto-download ZIP when a batch finishes"
          on={settings.autoDownloadZip}
          onChange={(v) => updateSettings({ autoDownloadZip: v })}
        />
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">Advanced: quality search bounds</div>
        <div className="settings-field">
          <span className="settings-field-label">Minimum quality (floor)</span>
          <div className="range-row" style={{ maxWidth: 280 }}>
            <input
              type="range"
              min="1"
              max="80"
              value={settings.qualityFloor}
              onChange={(e) => updateSettings({ qualityFloor: Number(e.target.value) })}
            />
            <span className="range-value mono">{settings.qualityFloor}</span>
          </div>
          <span className="settings-field-hint">
            The engine won't drop quality below this while searching for the target size — it will reduce resolution
            instead. Lower it to allow more aggressive compression at the cost of visible quality loss.
          </span>
        </div>
        <div className="settings-field">
          <span className="settings-field-label">Maximum quality (ceiling)</span>
          <div className="range-row" style={{ maxWidth: 280 }}>
            <input
              type="range"
              min={settings.qualityFloor + 1}
              max="100"
              value={settings.qualityCeiling}
              onChange={(e) => updateSettings({ qualityCeiling: Number(e.target.value) })}
            />
            <span className="range-value mono">{settings.qualityCeiling}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        {confirmingReset ? (
          <div className="banner banner-warn">
            Reset all settings to their defaults?
            <button type="button" className="btn btn-sm" onClick={() => setConfirmingReset(false)}>Cancel</button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => { resetSettings(); setConfirmingReset(false); }}
            >
              Reset
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingReset(true)}>
            <RotateCcw size={13} /> Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}
