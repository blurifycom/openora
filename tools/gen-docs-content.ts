#!/usr/bin/env node
/**
 * Generates the Fumadocs content tree for apps/docs from the repo-root `docs/`
 * Markdown - the SINGLE SOURCE OF TRUTH (same pattern as docs/catalog.json).
 *
 * For every docs/**.md it:
 *   - injects `title`/`description` frontmatter from the leading `# H1`,
 *   - strips that duplicate H1 (Fumadocs renders the title itself),
 *   - rewrites links that escape docs/ into GitHub blob URLs (so they don't 404),
 *   - mirrors the directory layout under apps/docs/content/docs (preserves internal links),
 *   - emits meta.json nav ordering and a /docs landing page,
 *   - copies docs/openapi.json next to the app for the API reference.
 *
 * Files stay `.md` (not `.mdx`) so raw `<`/`{` in prose are literal, not parsed as
 * JSX/expressions; ```mermaid fences still render via the remarkMdxMermaid plugin.
 *
 * VENDOR-NEUTRALITY GUARD: throws if any brand token survives into the generated
 * output - the published OSS site must never name a downstream consumer.
 *
 * Pure node fs - no package imports - so it runs from the repo root via tsx.
 * The OpenAPI reference is generated separately by apps/docs/scripts/generate-openapi.ts
 * (it needs the fumadocs-openapi dependency, resolved from the app's node_modules).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(repoRoot, 'docs');
const appDir = join(repoRoot, 'apps', 'docs');
const outDir = join(appDir, 'content', 'docs');

const gitBlob = 'https://github.com/blurifycom/oss/blob/dev';
const forbiddenBrands = ['consumer', 'examplebrand'];

type Doc = { rel: string; title: string; description?: string; body: string };

function listMarkdown(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listMarkdown(full, base);
    return name.endsWith('.md') ? [relative(base, full)] : [];
  });
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function deriveDescription(lines: string[]): string | undefined {
  const skip = (l: string) =>
    l.trim() === '' ||
    /^[#>|]/.test(l.trim()) ||
    /^[-*+]\s/.test(l.trim()) ||
    l.trim().startsWith('```') ||
    l.trim().startsWith('![');
  const first = lines.find((l) => !skip(l));
  if (!first) return undefined;
  const text = first
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Rewrites relative links that resolve outside docs/ into absolute GitHub URLs. */
function rewriteEscapingLinks(rel: string, body: string): string {
  return body.replace(/\]\(([^)]+)\)/g, (match, target: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return match;
    const [path, anchor = ''] = target.split('#');
    if (!path) return match;
    const repoRel = posix.normalize(posix.join('docs', posix.dirname(rel), path));
    if (repoRel.startsWith('..') || repoRel.startsWith('docs/') || repoRel === 'docs') return match;
    const suffix = anchor ? `#${anchor}` : '';
    return `](${gitBlob}/${repoRel}${suffix})`;
  });
}

function toDoc(rel: string): Doc {
  const raw = readFileSync(join(docsDir, rel), 'utf8');
  const lines = raw.split('\n');
  const h1Index = lines.findIndex((l) => /^#\s+/.test(l));
  const title = h1Index >= 0 ? lines[h1Index]!.replace(/^#\s+/, '').trim() : rel;
  const rest = h1Index >= 0 ? lines.slice(h1Index + 1) : lines;
  const description = deriveDescription(rest);
  const body = rewriteEscapingLinks(rel, rest.join('\n').replace(/^\n+/, ''));
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

const indexPage = `---
title: "OSS iGaming Platform"
description: "Open-source, headless, plugin-based, AI-native igaming platform."
---

Open-source, headless, plugin-based, AI-native igaming platform. The default backend
surface is fully featured (auth, wallet, lobby, chat, bonus, compliance, backoffice, CMS,
aggregator); the frontend lives in your own consumer repo.

## Start here

<Cards>
  <Card title="Architecture" href="/docs/architecture" />
  <Card title="System design" href="/docs/system-design" />
  <Card title="Glossary" href="/docs/glossary" />
  <Card title="Agent quickstart" href="/docs/agent-quickstart" />
  <Card title="Consuming the platform" href="/docs/downstream-consumer" />
  <Card title="API reference" href="/docs/api" />
</Cards>
`;

function writeMeta(dir: string, meta: object): void {
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

function main(): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const rel of listMarkdown(docsDir)) {
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, render(toDoc(rel)));
  }

  writeFileSync(join(outDir, 'index.md'), indexPage);

  writeMeta(outDir, {
    pages: [
      'index',
      '---Overview---',
      'architecture',
      'system-design',
      'glossary',
      '---Guides---',
      'agent-quickstart',
      'downstream-consumer',
      'mcp-setup',
      'agent-benchmark',
      '---Reference---',
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
