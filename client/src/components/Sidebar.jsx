import { Aperture, ImagePlus, History, SlidersHorizontal } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'compress', label: 'Compress', icon: ImagePlus },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
];

export default function Sidebar({ view, onChange }) {
  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail-mark" aria-hidden="true">
        <Aperture size={22} strokeWidth={1.8} />
      </div>
      <div className="rail-nav">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`rail-btn${view === id ? ' active' : ''}`}
            onClick={() => onChange(id)}
            aria-current={view === id ? 'page' : undefined}
          >
            <Icon size={19} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-footer">Runs<br />locally</div>
    </nav>
  );
}
