/**
 * Joins a PR's evidence into one walkthrough video: a 1 s title card before every clip or still,
 * all fitted to one 1440x900 canvas, then prints the chapter list for the PR description.
 *
 * Usage: node .claude/skills/ui-verify/join-video.mjs <manifest.json> <out-walkthrough.mp4>
 * The manifest is an ordered array of `{ "title": "AC1: deposit shows the bonus", "clip": "a.webm" }`
 * or `{ "title": "Matrix: mobile, dark", "image": "a.png" }`; a still stays on screen for 2 s.
 * Needs ffmpeg and ffprobe on PATH, and Playwright: the repo's own, else the one bundled with the
 * global playwright-cli.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIDTH = 1440;
const HEIGHT = 900;
const BACKGROUND = '#0b0d12';
const TITLE_SECONDS = 1;
const STILL_SECONDS = 2;
const FIT = [
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`,
  `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND}`,
  'fps=25',
  'format=yuv420p',
].join(',');

const loadPlaywright = () => {
  try {
    return createRequire(join(process.cwd(), 'noop.js'))('playwright');
  } catch {
    try {
      const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
      return createRequire(join(globalRoot, '@playwright/cli/noop.js'))('playwright');
    } catch {
      process.stderr.write('needs playwright in this repo or @playwright/cli installed globally\n');
      process.exit(2);
    }
  }
};

const [manifestPath, outPath] = process.argv.slice(2);
if (!manifestPath || !outPath?.endsWith('.mp4')) {
  process.stderr.write('usage: node join-video.mjs <manifest.json> <out-walkthrough.mp4>\n');
  process.exit(2);
}
const manifestDir = resolve(manifestPath, '..');
const entries = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(entries) || entries.length === 0) {
  process.stderr.write('the manifest must be a non-empty array of entries\n');
  process.exit(2);
}
const badEntry = entries.findIndex(
  (entry) =>
    typeof entry?.title !== 'string' ||
    typeof (entry.clip ?? entry.image) !== 'string' ||
    !(entry.clip ?? entry.image),
);
if (badEntry >= 0) {
  process.stderr.write(`manifest entry ${badEntry} needs a "title" and a "clip" or "image"\n`);
  process.exit(2);
}
const { chromium } = loadPlaywright();

const ffmpeg = (...args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const encode = (input, out, seconds) =>
  ffmpeg(
    ...(seconds ? ['-loop', '1', '-t', String(seconds)] : []),
    '-i',
    input,
    '-vf',
    FIT,
    '-an',
    '-c:v',
    'libx264',
    '-crf',
    '28',
    '-preset',
    'veryfast',
    out,
  );
const durationOf = (path) =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      {
        encoding: 'utf8',
      },
    ),
  );
const timestamp = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

const browser = await chromium.launch();
const work = mkdtempSync(join(tmpdir(), 'mr-video-'));
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const segments = [];
  for (const [index, entry] of entries.entries()) {
    const card = join(work, `${index}-title.png`);
    await page.setContent(
      `<body style="margin:0;height:100vh;display:grid;place-items:center;background:${BACKGROUND};` +
        `color:#fff;font:600 56px system-ui,sans-serif;text-align:center;padding:0 80px">` +
        `${escapeHtml(entry.title)}</body>`,
    );
    await page.screenshot({ path: card });
    const title = join(work, `${index}-a.mp4`);
    const body = join(work, `${index}-b.mp4`);
    encode(card, title, TITLE_SECONDS);
    encode(resolve(manifestDir, entry.clip ?? entry.image), body, entry.clip ? 0 : STILL_SECONDS);
    segments.push({ title: entry.title, files: [title, body] });
  }

  const list = join(work, 'list.txt');
  writeFileSync(
    list,
    segments
      .flatMap(({ files }) => files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`))
      .join(''),
  );
  ffmpeg(
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  );

  let start = 0;
  for (const { title, files } of segments) {
    process.stdout.write(`- ${timestamp(start)} ${title}\n`);
    start += files.reduce((sum, file) => sum + durationOf(file), 0);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  await browser.close().catch(() => {});
}
