const TICKS = Array.from({ length: 12 }, (_, i) => i * 30);

/** A combination-lock dial. The knob turns when the drive unlocks. */
export default function LockDial({ unlocked, className = "h-12 w-12" }: { unlocked: boolean; className?: string }) {
  const color = unlocked ? "var(--ink)" : "var(--brass)";
  return (
    <svg viewBox="0 0 48 48" className={`shrink-0 ${className}`} aria-hidden="true">
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

/** The app's mark: the same dial, small. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className="shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M12 12l4.4-4.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

const RING = Array.from({ length: 100 }, (_, i) => i);

/** A dial's face as a backdrop: a hundred fine ticks, cropped by whatever holds it. */
export function DialFace({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 400" className={className} fill="none" stroke="var(--ink)" aria-hidden="true">
      <circle cx="200" cy="200" r="199" opacity="0.14" strokeWidth="0.5" />
      <circle cx="200" cy="200" r="158" opacity="0.1" strokeWidth="0.5" />
      {RING.map((i) => (
        <line
          key={i}
          x1="200"
          y1="8"
          x2="200"
          y2={i % 10 === 0 ? 26 : i % 5 === 0 ? 20 : 16}
          strokeWidth="0.75"
          opacity={i % 10 === 0 ? 0.4 : 0.18}
          transform={`rotate(${i * 3.6} 200 200)`}
        />
      ))}
    </svg>
  );
}
