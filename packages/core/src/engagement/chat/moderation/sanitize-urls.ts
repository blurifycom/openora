// Best-effort defang of dangerous URL schemes so a consumer that auto-linkifies
// plain text won't turn them into live links (ABC-45 AC7). The class matches the
// whitespace browsers ignore before the colon (eg "javascript :", "data\t:") as
// well as the bare scheme.
//
// This is NOT a complete XSS boundary - it cannot be. Chat content is untrusted
// user input and is stored/returned verbatim apart from this defang, so a
// consumer that injects `content` as raw HTML (innerHTML/dangerouslySetInnerHTML)
// is still exploitable regardless of this pass (eg a literal `<script>`). The
// safety contract lives on the consumer: render `content` as TEXT or HTML-escape
// it. Documented on ChatMessageSchema.content.
const DANGEROUS_SCHEME = /\b(javascript|data|vbscript|file|blob)\s*:/gi;

/** Best-effort: splits dangerous URL schemes so they can't be auto-linkified. Not an XSS boundary - see ChatMessageSchema.content. */
export function sanitizeUrls(content: string): string {
  return content.replace(DANGEROUS_SCHEME, '$1 ');
}
