/**
 * Wraps a value in Unicode directional isolates (FSI … PDI) for interpolation into a translated
 * sentence (P2-04): an email address or other left-to-right value inside a Persian sentence keeps
 * its own direction and does not reorder the surrounding words (Unicode Bidirectional Algorithm,
 * W3C "Inline markup and bidirectional text"). Screen readers ignore the marks.
 */
export function isolateBidi(value: string): string {
  return `\u2068${value}\u2069`;
}
