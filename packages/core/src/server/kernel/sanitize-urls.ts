// Best-effort defang so an auto-linkifying consumer does not turn these schemes into live
// links; also matches the whitespace browsers ignore before the colon ("javascript :").
// Not an XSS boundary: content is otherwise stored verbatim, so consumers must render it
// as text, never as HTML.
const DANGEROUS_SCHEME = /\b(javascript|data|vbscript|file|blob)\s*:/gi;

export function sanitizeUrls(content: string): string {
  return content.replace(DANGEROUS_SCHEME, '$1 ');
}
