/**
 * The app's signature element: a small arc gauge styled after a darkroom
 * light meter / densitometer needle, used everywhere a quality score is
 * shown. Color follows target-reached state so it doubles as a status
 * indicator, not just decoration.
 */
export default function QualityDial({ quality, targetReached, size = 56 }) {
  const radius = (size - 8) / 2;
  const circumference = Math.PI * radius; // half circle (arc gauge)
  const clamped = quality === null || quality === undefined ? null : Math.max(0, Math.min(100, quality));
  const fraction = clamped === null ? 0 : clamped / 100;
  const dashOffset = circumference * (1 - fraction);
  const color = targetReached === false ? 'var(--warn)' : 'var(--accent)';
  const center = size / 2;

  return (
    <svg
      className="quality-dial"
      width={size}
      height={size / 2 + 6}
      viewBox={`0 0 ${size} ${size / 2 + 6}`}
      role="img"
      aria-label={clamped === null ? 'Original quality, unchanged' : `Compression quality ${clamped} out of 100`}
    >
      <path
        d={`M 4 ${center} A ${radius} ${radius} 0 0 1 ${size - 4} ${center}`}
        fill="none"
        stroke="var(--surface-2)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d={`M 4 ${center} A ${radius} ${radius} 0 0 1 ${size - 4} ${center}`}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={clamped === null ? 0 : dashOffset}
      />
      <text x={center} y={center + 2} textAnchor="middle" className="dial-value" fill="var(--text-primary)">
        {clamped === null ? '—' : clamped}
      </text>
    </svg>
  );
}
