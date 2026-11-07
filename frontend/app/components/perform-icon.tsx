/**
 * Performer mode's icon (an iPad with a music note), the same drawing as the Score Editor's toolbar and activity bar
 * use (OTS_Web components/shell/icons/performIcon.ts), sized to sit with the header's link glyphs.
 */
export default function PerformIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-testid="perform-icon"
    >
      <rect x="4" y="2" width="16" height="20" rx="2.5" />
      <path d="M11 18.5h2" />
      <circle cx="10" cy="12.5" r="2" />
      <path d="M12 12.5V5.5c1.8.4 3.2 1.5 3.2 3.4" />
    </svg>
  );
}
