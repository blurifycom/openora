#!/usr/bin/env node
// Deterministic signal extractor over Claude Code transcripts. No LLM, no deps.
// Usage: node scan.mjs [--days 7] [--match '<this repo>|openora'] [--root ~/.claude/projects] [--top 25] [--save false]
import {
  createReadStream,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const positiveInt = (name, fallback) => {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got ${args[name]}`);
  }
  return value;
};
const days = positiveInt('days', 7);
const top = positiveInt('top', 25);
// The main checkout, also from a worktree: its name picks the transcripts, its .claude/reviews/ keeps the reports.
const mainCheckout = () => {
  try {
    return dirname(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    throw new Error('run inside a git checkout, or pass --match and --save false');
  }
};
const repoNames = args.match ? [] : [...new Set([basename(mainCheckout()), 'openora'])];
// Claude Code names a project dir after its path with every non-alphanumeric turned into '-',
// so match whole '-'-separated segments: a repo named "api" must not pick up "~/apix" (but "~/x/api/y" and "~/x-api-y" look the same).
const match = new RegExp(
  args.match ??
    `(?:^|-)(?:${repoNames.map((name) => name.replace(/[^a-zA-Z0-9]/g, '-')).join('|')})(?:-|$)`,
  'i',
);
const root = args.root ?? join(homedir(), '.claude/projects');
const since = Date.now() - days * 86_400_000;

// `\b` is ASCII-only in JS, so Polish words ending in a diacritic sit outside the `\b` groups.
const CORRECTION =
  /\b(instead|actually|nope|i told you|you should have|still (not|broken|failing)|nadal|wciaz)\b|wciąż|^(no\b|nie\b|stop\b|wrong|źle|zle\b|not that|don'?t\b|nie rób|nie rob|why did you|dlaczego|i said|mówiłem|mowilem|again\b|znowu|you forgot|zapomniałeś|zapomniales|revert|cofnij|that'?s not)/i;

// The digest is shared at the team sync: credentials, emails and home paths are masked.
const SECRET_NAME =
  /(["']?)([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w-]*)\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s",}]+)/gi;
// Capped: the name patterns backtrack quadratically on long word runs.
const redact = (text) =>
  String(text)
    .slice(0, 4000)
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '<private-key>',
    )
    .replace(/\/(?:Users|home)\/[^/\s'"]+\//g, '~/')
    .replace(/-(?:Users|home)-[^-\s]+-/g, '-~-')
    .replace(/:\/\/[^\s/:@]+:[^\s/?#]+@/g, '://<user>:<redacted>@')
    .replace(
      /\b(Authorization|PRIVATE-TOKEN|x-api-key)(["']?\s*[:=]\s*)(?:(?:Bearer|Basic|token)\s+)?[^\s"']+/gi,
      '$1$2<redacted>',
    )
    // A cookie header holds a whole `a=1; b=2` list, so it is masked to the closing quote or line end.
    .replace(/\b(Cookie|Set-Cookie)(["']?\s*[:=]\s*)[^"'\r\n]+/gi, '$1$2<redacted>')
    .replace(/\b(curl\s(?:.*?\s)?(?:-b|--cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/g, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/g, '$1 <redacted>')
    .replace(SECRET_NAME, '$1$2$1$3<redacted>')
    .replace(/(--password[= ]|docker login\s.*?-p\s+|curl\s.*?-u\s+[^:\s]+:)\S+/g, '$1<redacted>')
    .replace(
      /\b(glpat-|glptt-|ghp_|gho_|ghs_|github_pat_|npm_|sk-|sk_live_|rk_live_|whsec_|xox[bp]-)[\w-]+/g,
      '$1<redacted>',
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-key-id>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');

const counter = () => new Map();
// Redact before truncating, so a cut never splits a secret out of its pattern's reach.
const bump = (map, key, example, incident) => {
  const safeKey = redact(key);
  const entry = map.get(safeKey) ?? {
    n: 0,
    sessions: new Set(),
    example: redact(example.slice(0, 2000)).slice(0, 300),
  };
  entry.n += 1;
  entry.sessions.add(incident);
  map.set(safeKey, entry);
};

const toolErrors = counter();
const hookBlocks = counter();
const guardTotals = counter();
const commandFamilies = counter();
const failedCommandFamilies = counter();
const corrections = [];
const interrupts = counter();
const skills = counter();
const subagents = counter();
const fileReads = counter();
const sessionStats = [];

// Collapse volatile parts so identical failures group together.
// Redact first: placeholders below would break the secret patterns and leave token tails.
const normalize = (text) =>
  redact(text)
    .replace(/(?:\/(?:Users|home)\/|~\/)[^\s'"]+/g, '<path>')
    .replace(/\/(private\/)?tmp\/[^\s'"]+/g, '<tmp>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

// A file path relative to its checkout, so the same file in two worktrees is one row.
const WORKTREE =
  /^.*\/(?:\.t3\/worktrees\/[^/]+\/[^/]+|\.claude\/worktrees\/[^/]+|\.worktrees\/[^/]+)\//;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHECKOUT = repoNames.length
  ? new RegExp(`^.*?/(?:${repoNames.map(escapeRegExp).join('|')})/`)
  : /^$/;
const checkoutRelative = (path) =>
  WORKTREE.test(path)
    ? path.replace(WORKTREE, '')
    : path.replace(CHECKOUT, '').replace(/^\/(?:Users|home)\/[^/]+\//, '~/');

// First meaningful tokens of a shell command: "pnpm --filter api typecheck", "glab mr view".
const commandFamily = (command) => {
  const first = command
    .replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '')
    .split(/&&|\|\||;|\|/)[0]
    .trim();
  const tokens = first.split(/\s+/).filter((t) => !t.startsWith('$') && !t.includes('='));
  return tokens
    .slice(
      0,
      tokens[0] && /^(pnpm|npm|npx|glab|gh|git|docker|node|bun|turbo)$/.test(tokens[0]) ? 3 : 2,
    )
    .join(' ');
};

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join('\n')
      : '';

async function scanFile(file, project, isSubagent) {
  const session = basename(file, '.jsonl');
  // A subagent's events belong to the main session that spawned it: one incident, not six.
  const incident = isSubagent ? file.split('/').at(-3) : session;
  const pendingTools = new Map(); // tool_use_id -> { name, family }
  const countedMessages = new Set(); // every content block repeats its message's usage
  const stats = {
    project,
    session,
    isSubagent,
    turns: 0,
    toolCalls: 0,
    errors: 0,
    compactions: 0,
    costUSD: 0,
    tokens: 0,
    corrections: 0,
  };
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    const toolUses =
      entry.type === 'assistant' && Array.isArray(content)
        ? content.filter((block) => block.type === 'tool_use')
        : [];
    for (const block of toolUses) {
      const input = block.input ?? {};
      const family =
        block.name === 'Bash' && typeof input.command === 'string'
          ? commandFamily(input.command)
          : undefined;
      pendingTools.set(block.id, { name: block.name, family });
    }
    // Long sessions span weeks: count only what happened inside the window.
    if (entry.timestamp && Date.parse(entry.timestamp) < since) {
      continue;
    }
    const usage = entry.type === 'assistant' ? entry.message?.usage : undefined;
    if (usage && !countedMessages.has(entry.message.id)) {
      countedMessages.add(entry.message.id);
      stats.tokens +=
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.output_tokens ?? 0);
    }
    if (entry.type === 'cost-state') {
      stats.costUSD = Math.max(stats.costUSD, entry.totalCostUSD ?? 0);
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      stats.compactions += 1;
    }
    if (entry.type === 'attachment' && entry.attachment?.type === 'hook_blocking_error') {
      const message = String(
        entry.attachment.blockingError?.blockingError ??
          entry.attachment.content ??
          JSON.stringify(entry.attachment),
      );
      const hook = message.match(/hooks\/([\w-]+\.\w+)/)?.[1] ?? 'hook';
      const reason =
        message.match(/eslint\([^)]+\)|oss-[\w-]+|Typecheck failed for \S+|error TS\d+/)?.[0] ??
        normalize(message).slice(0, 80);
      bump(hookBlocks, `${hook} :: ${reason}`, message, incident);
      bump(guardTotals, `${entry.attachment.hookEvent ?? 'hook'} ${hook}`, '', incident);
    }
    for (const block of toolUses) {
      stats.toolCalls += 1;
      const input = block.input ?? {};
      const { family } = pendingTools.get(block.id);
      if (family) {
        bump(commandFamilies, family, input.command, incident);
      }
      if (block.name === 'Skill') {
        bump(skills, String(input.skill), '', incident);
      }
      if (block.name === 'Agent' || block.name === 'Task') {
        bump(subagents, String(input.subagent_type ?? 'general-purpose'), '', incident);
      }
      if (block.name === 'Read' && typeof input.file_path === 'string') {
        bump(fileReads, checkoutRelative(input.file_path), '', incident);
      }
    }
    if (entry.type === 'user' && !entry.isMeta) {
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
        for (const result of content) {
          if (result.type !== 'tool_result' || result.is_error !== true) {
            continue;
          }
          stats.errors += 1;
          const tool = pendingTools.get(result.tool_use_id) ?? { name: '?' };
          const text = textOf(result.content);
          const signature = normalize(text.replace(/^Exit code \d+\s*/, ''));
          bump(toolErrors, `${tool.name} :: ${signature}`, text, incident);
          if (text.startsWith('PreToolUse:')) {
            const guard =
              text.match(/hooks\/([\w.-]+)/)?.[1] ??
              `unnamed: ${normalize(text.replace(/^PreToolUse:\S+ hook error:\s*/, '')).slice(0, 50)}`;
            bump(guardTotals, `PreToolUse ${guard}`, '', incident);
          }
          // Hook blocks have their own table; here only commands that ran and failed.
          if (tool.family && !text.startsWith('PreToolUse:')) {
            bump(failedCommandFamilies, tool.family, text, incident);
          }
        }
      } else {
        const text = textOf(content).trim();
        // Compaction summaries, status-file restores and pasted skill bodies arrive as user turns.
        if (
          !text ||
          entry.isCompactSummary ||
          entry.isVisibleInTranscriptOnly ||
          /^(<|Caveat:|Task status from|Delegated task|\(Re-invocation)/.test(text)
        ) {
          continue;
        }
        if (text.startsWith('[Request interrupted')) {
          bump(interrupts, 'interrupt', '', incident);
          continue;
        }
        stats.turns += 1;
        if (!isSubagent && text.length < 600 && CORRECTION.test(text)) {
          stats.corrections += 1;
          corrections.push({
            project,
            session,
            at: entry.timestamp ?? '',
            text: redact(text).replace(/\s+/g, ' ').slice(0, 220),
          });
        }
      }
    }
  }
  sessionStats.push(stats);
}

const files = [];
for (const dir of readdirSync(root)) {
  const projectDir = join(root, dir);
  if (!match.test(dir) || !statSync(projectDir).isDirectory()) {
    continue;
  }
  for (const name of readdirSync(projectDir)) {
    const path = join(projectDir, name);
    if (name.endsWith('.jsonl')) {
      if (statSync(path).mtimeMs >= since) {
        files.push([path, dir, false]);
      }
      continue;
    }
    const subDir = join(path, 'subagents');
    if (!existsSync(subDir)) {
      continue;
    }
    for (const sub of readdirSync(subDir)) {
      const subPath = join(subDir, sub);
      if (sub.endsWith('.jsonl') && statSync(subPath).mtimeMs >= since) {
        files.push([subPath, dir, true]);
      }
    }
  }
}

for (const [file, project, isSubagent] of files) {
  await scanFile(file, project, isSubagent);
}

const ranked = (map, limit = top) =>
  [...map.entries()]
    .sort((a, b) => b[1].sessions.size - a[1].sessions.size || b[1].n - a[1].n)
    .slice(0, limit);
const table = (title, map, { withExample = true, limit } = {}) => {
  const rows = ranked(map, limit);
  if (!rows.length) {
    return `## ${title}\n\n(none)\n`;
  }
  const head = withExample
    ? '| n | sessions | key | example |\n|---|---|---|---|'
    : '| n | sessions | key |\n|---|---|---|';
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ↵ ');
  return `## ${title}\n\n${head}\n${rows
    .map(
      ([key, v]) =>
        `| ${v.n} | ${v.sessions.size} | ${cell(key)} |${withExample ? ` ${cell(v.example).slice(0, 200)} |` : ''}`,
    )
    .join('\n')}\n`;
};

const mains = sessionStats.filter((s) => !s.isSubagent && (s.toolCalls > 0 || s.turns > 0));
const sum = (list, key) => list.reduce((acc, s) => acc + s[key], 0);
const failureRate = new Map(
  [...failedCommandFamilies.entries()]
    .map(([family, v]) => [family, { ...v, total: commandFamilies.get(family)?.n ?? v.n }])
    .filter(([, v]) => v.n >= 3)
    .map(([family, v]) => [`${family} (${Math.round((100 * v.n) / v.total)}% of ${v.total})`, v]),
);

const mtok = (n) => `${(n / 1e6).toFixed(1)}M`;
const out = [
  `# Agent session digest: last ${days}d, /${match.source}/`,
  '',
  `Main sessions: ${mains.length}, subagent transcripts: ${sessionStats.length - mains.length}, tool calls: ${sum(sessionStats, 'toolCalls')}, tool errors: ${sum(sessionStats, 'errors')}, user corrections: ${corrections.length}, interrupts: ${interrupts.get('interrupt')?.n ?? 0}, compactions: ${sum(mains, 'compactions')}, tokens in window: ${mtok(sum(sessionStats, 'tokens'))}`,
  '',
  'Ranked by distinct main sessions (a subagent counts as its parent), then count. `<n>`/`<path>`/`<sha>` are normalized placeholders, `<redacted>`/`<email>`/`<jwt>` masked values.',
  '',
  table('Recurring tool errors', toolErrors, { limit: top * 2 }),
  table('Blocks per guard (totals: quote these, never add rows up yourself)', guardTotals, {
    withExample: false,
  }),
  table('Post-edit hook blocks by reason', hookBlocks),
  table('Shell command families that fail often (>=3 failures)', failureRate),
  table('Most-run shell command families (script/allowlist candidates)', commandFamilies),
  table('Most-read files (precompute / rule candidates)', fileReads, { withExample: false }),
  table('Skills invoked', skills, { withExample: false }),
  table('Subagents spawned', subagents, { withExample: false }),
  '## Possible user corrections (main sessions, regex-matched, verify each; newest last)',
  '',
  ...corrections
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-60)
    .map(
      (c) =>
        `- [${c.project.replace(/^-(?:Users|home)-[^-]+-/, '')} ${c.session.slice(0, 8)}] ${c.text}`,
    ),
  '',
  '## Costliest main sessions (by tokens in the window; $ is the whole session, window or not)',
  '',
  '| tokens | $ | turns | tool calls | errors | corrections | compactions | project | session |\n|---|---|---|---|---|---|---|---|---|',
  ...mains
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 15)
    .map(
      (s) =>
        `| ${mtok(s.tokens)} | ${s.costUSD.toFixed(1)} | ${s.turns} | ${s.toolCalls} | ${s.errors} | ${s.corrections} | ${s.compactions} | ${s.project.replace(/^-(?:Users|home)-[^-]+-/, '')} | ${s.session} |`,
    ),
  '',
];
// Transcripts carry control bytes (NUL in tool output) that make the digest read as binary.
// eslint-disable-next-line no-control-regex
const digest = out.join('\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
process.stdout.write(digest);

// Saved in the main checkout's gitignored .claude/reviews/: a worktree is gone by next week.
if (args.save !== 'false') {
  const dir = join(mainCheckout(), '.claude/reviews');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-retro-digest-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(file, digest);
  process.stderr.write(`\nsaved ${file}\nreports dir: ${dir}\n`);
}
