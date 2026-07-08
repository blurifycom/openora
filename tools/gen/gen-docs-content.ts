#!/usr/bin/env node
/**
 * Generates the Fumadocs content tree for apps/docs from the repo-root `docs/`
 * Markdown - the SINGLE SOURCE OF TRUTH (same pattern as docs/catalog.json).
 *
 * For every included docs/**.md it:
 *   - injects `title`/`description` frontmatter from the leading `# H1`,
 *   - strips that duplicate H1 (Fumadocs renders the title itself),
 *   - strips packaging/superseded/status meta-note callouts (noise for newcomers),
 *   - rewrites links to pages we don't generate into GitHub URLs (so they don't 404),
 *   - mirrors the directory layout under apps/docs/content/docs (preserves internal links),
 *   - emits meta.json nav ordering; introduction.md becomes the /docs landing page,
 *   - copies docs/openapi.json next to the app for the API reference.
 *
 * The ADR section is CURATED: only the key, still-current decisions are shipped (see KEY_ADRS).
 *
 * Files stay `.md` (not `.mdx`) so raw `<`/`{` in prose are literal, not parsed as
 * JSX/expressions; ```mermaid fences still render via the remarkMdxMermaid plugin.
 *
 * VENDOR-NEUTRALITY GUARD: throws if any brand token survives into the generated output.
 *
 * Pure node fs - no package imports - so it runs from the repo root via tsx. The OpenAPI
 * reference is generated separately by apps/docs/scripts/generate-openapi.ts.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const docsDir = join(repoRoot, 'docs');
const appDir = join(repoRoot, 'apps', 'docs');
const outDir = join(appDir, 'content', 'docs');

const gitBlob = 'https://github.com/blurifycom/oss/blob/dev';
const gitTree = 'https://github.com/blurifycom/oss/tree/dev';
// Downstream operators add their own brand names here to keep them out of generated public docs.
const forbiddenBrands: string[] = [];

// The key, still-current decisions a newcomer should read. Other ADRs stay in the repo
// (and links to them resolve to GitHub) but are not shipped as site pages.
const KEY_ADRS = new Set([
  '0002', // definePlugin + overlay pattern
  '0009', // Hono + oRPC for the API
  '0010', // event-driven broker + microservices
  '0014', // job queue + realtime transport seams
  '0015', // boundary lint
  '0021', // everything is an add-on
  '0023', // headless platform, frontend in consumer
  '0025', // single core package with module subpaths
  '0026', // single-tenant
]);

const metaNoteRe = /^>\s*\*\*(packaging note|superseded|current state)/i;

type Doc = { rel: string; title: string; description?: string; body: string };

function listMarkdown(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdown(full, base);
    return entry.name.endsWith('.md') ? [relative(base, full)] : [];
  });
}

const toPosix = (rel: string): string => rel.split(/[\\/]/).join('/');

function isIncluded(rel: string): boolean {
  const adr = toPosix(rel).match(/^adr\/(\d{4})-/);
  return adr ? KEY_ADRS.has(adr[1]!) : true;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function deriveDescription(lines: string[]): string | undefined {
  const skip = (l: string) => {
    const t = l.trim();
    return (
      t === '' ||
      /^[#>|]/.test(t) ||
      /^[-*+]\s/.test(t) ||
      t.startsWith('```') ||
      t.startsWith('![')
    );
  };
  const first = lines.find((l) => !skip(l));
  if (!first) return undefined;
  const text = first
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Drops blockquote callouts that are packaging/superseded/status meta-notes. */
function stripMetaNotes(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.startsWith('>')) {
      out.push(line);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] ?? '').startsWith('>')) j += 1;
    if (metaNoteRe.test(line)) {
      if (j < lines.length && (lines[j] ?? '').trim() === '') j += 1; // swallow the trailing blank
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out.join('\n');
}

/** Rewrites relative links to pages we don't generate (excluded ADRs, repo files) to GitHub. */
function rewriteLinks(rel: string, body: string, kept: Set<string>): string {
  return body.replace(/\]\(([^)]+)\)/g, (match, target: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return match;
    const [path = '', anchor = ''] = target.split('#');
    if (!path) return match;
    const isDir = path.endsWith('/');
    const repoRel = posix.normalize(posix.join('docs', posix.dirname(toPosix(rel)), path));
    if (repoRel.startsWith('..')) return match;
    if (!isDir && kept.has(repoRel)) return match;
    const suffix = anchor ? `#${anchor}` : '';
    return `](${isDir ? gitTree : gitBlob}/${repoRel.replace(/\/$/, '')}${suffix})`;
  });
}

function toDoc(rel: string, kept: Set<string>): Doc {
  const raw = readFileSync(join(docsDir, rel), 'utf8');
  const lines = raw.split('\n');
  const h1Index = lines.findIndex((l) => /^#\s+/.test(l));
  const h1Line = h1Index >= 0 ? lines[h1Index] : undefined;
  const title = h1Line ? h1Line.replace(/^#\s+/, '').trim() : rel;
  const rest = h1Index >= 0 ? lines.slice(h1Index + 1) : lines;
  const description = deriveDescription(rest);
  const body = rewriteLinks(rel, stripMetaNotes(rest.join('\n').replace(/^\n+/, '')), kept);
  return { rel, title, description, body };
}

function render(doc: Doc): string {
  const fm = [`title: ${yamlString(doc.title)}`];
  if (doc.description) fm.push(`description: ${yamlString(doc.description)}`);
  return `---\n${fm.join('\n')}\n---\n\n${doc.body}`;
}

function assertVendorNeutral(): void {
  const offenders: string[] = [];
  for (const rel of listMarkdown(outDir)) {
    readFileSync(join(outDir, rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const hit = forbiddenBrands.find((b) => line.toLowerCase().includes(b));
        if (hit) offenders.push(`content/docs/${rel}:${i + 1} contains "${hit}"`);
      });
  }
  if (offenders.length > 0) {
    throw new Error(
      `Vendor brand leaked into generated docs (scrub the source in docs/):\n  ${offenders.join('\n  ')}`,
    );
  }
}

function writeMeta(dir: string, meta: object): void {
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

function main(): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const kept = listMarkdown(docsDir).filter(isIncluded);
  const keptSet = new Set(kept.map((r) => `docs/${toPosix(r)}`));

  for (const rel of kept) {
    const dest = join(outDir, rel === 'introduction.md' ? 'index.md' : rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, render(toDoc(rel, keptSet)));
  }

  writeMeta(outDir, {
    pages: [
      'index',
      '---Get started---',
      'quickstart',
      'core-concepts',
      '---Guides---',
      'downstream-consumer',
      'mcp-setup',
      'agent-quickstart',
      'agentic-workflow',
      '---Reference---',
      'architecture',
      'system-design',
      'glossary',
      'adapters',
      'adr',
      'api',
    ],
  });

  if (existsSync(join(outDir, 'adapters'))) {
    writeMeta(join(outDir, 'adapters'), { title: 'Adapters', pages: ['...'] });
  }

  const adrDir = join(outDir, 'adr');
  if (existsSync(adrDir)) {
    const adrPages = readdirSync(adrDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    writeMeta(adrDir, { title: 'ADRs', pages: adrPages });
  }

  const openapiSrc = join(docsDir, 'openapi.json');
  if (existsSync(openapiSrc)) {
    cpSync(openapiSrc, join(appDir, 'openapi.json'));
  } else {
    console.warn('[gen-docs-content] docs/openapi.json missing - run `pnpm codegen` first.');
  }

  assertVendorNeutral();
  console.log(`[gen-docs-content] generated ${listMarkdown(outDir).length} pages`);
}

main();
