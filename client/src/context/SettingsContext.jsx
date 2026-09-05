import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'image-compressor:settings';

export const DEFAULT_SETTINGS = {
  targetPreset: '10', // '10' | '12' | 'custom'
  customTargetMB: 15,
  maxWidthPreset: 'original', // 'original' | '3000' | '4000' | '6000' | 'custom'
  customMaxWidth: 3000,
  format: 'auto', // auto | jpeg | webp | avif | png
  concurrency: 3,
  qualityFloor: 35,
  qualityCeiling: 100,
  autoDownloadZip: false,
};

function loadInitial() {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(loadInitial);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // localStorage unavailable (e.g. private browsing) - settings just won't persist
    }
  }, [settings]);

  const updateSettings = (patch) => setSettings((prev) => ({ ...prev, ...patch }));
  const resetSettings = () => setSettings(DEFAULT_SETTINGS);

  const targetMB = useMemo(() => {
    if (settings.targetPreset === '10') return 10;
    if (settings.targetPreset === '12') return 12;
    const custom = Number(settings.customTargetMB);
    return Number.isFinite(custom) && custom > 0 ? custom : 10;
  }, [settings.targetPreset, settings.customTargetMB]);

  // Resolves to `null` for "Original" (no dimension cap - the existing
  // compressor's behavior, byte-for-byte), or a positive pixel width.
  const maxWidthPx = useMemo(() => {
    if (settings.maxWidthPreset === 'original') return null;
    if (settings.maxWidthPreset === '3000') return 3000;
    if (settings.maxWidthPreset === '4000') return 4000;
    if (settings.maxWidthPreset === '6000') return 6000;
    const custom = Number(settings.customMaxWidth);
    return Number.isFinite(custom) && custom > 0 ? custom : null;
  }, [settings.maxWidthPreset, settings.customMaxWidth]);

  const value = { settings, updateSettings, resetSettings, targetMB, maxWidthPx };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
