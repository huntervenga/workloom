/** Workloom mark: two warp threads over three weft threads. Decorative. */
export function Logomark({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="8" fill="#6366f1" />
      <path d="M9 11h14M9 16h14M9 21h14" stroke="#fff" strokeOpacity="0.45" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M12.5 8v16M19.5 8v16" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
