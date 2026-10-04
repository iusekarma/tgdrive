const TICKS = Array.from({ length: 12 }, (_, i) => i * 30);

/** A combination-lock dial. The knob turns when the drive unlocks. */
export default function LockDial({ unlocked }: { unlocked: boolean }) {
  const color = unlocked ? "var(--teal)" : "var(--brass)";
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12 shrink-0" aria-hidden="true">
      <circle cx="24" cy="24" r="22.5" fill="var(--surface)" stroke="var(--line)" strokeWidth="1" />
      {TICKS.map((deg) => (
        <line
          key={deg}
          x1="24"
          y1="4"
          x2="24"
          y2={deg % 90 === 0 ? 8 : 6.5}
          stroke="var(--muted)"
          strokeWidth="1.2"
          strokeLinecap="round"
          transform={`rotate(${deg} 24 24)`}
        />
      ))}
      <g className="dial-knob" style={{ transform: `rotate(${unlocked ? 135 : 0}deg)` }}>
        <circle cx="24" cy="24" r="12.5" fill="var(--paper)" stroke={color} strokeWidth="2" />
        <line x1="24" y1="24" x2="24" y2="13.5" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="24" cy="24" r="2.2" fill={color} />
      </g>
    </svg>
  );
}
