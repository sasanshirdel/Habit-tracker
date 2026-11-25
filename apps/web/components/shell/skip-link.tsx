/**
 * "Skip to main content" (P1-11, WCAG 2.4.1): the first focusable element of every app page,
 * visually hidden until it receives keyboard focus, then shown at the inline start.
 */
export function SkipLink({ targetId, label }: { targetId: string; label: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-elevated focus:px-4 focus:py-2 focus:text-text-primary focus:shadow-lg"
    >
      {label}
    </a>
  );
}
