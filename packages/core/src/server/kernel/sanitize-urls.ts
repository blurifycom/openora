const DANGEROUS_SCHEME = /\b(javascript|data|vbscript|file|blob)\s*:/gi;

export function sanitizeUrls(content: string): string {
  return content.replace(DANGEROUS_SCHEME, '$1 ');
}
