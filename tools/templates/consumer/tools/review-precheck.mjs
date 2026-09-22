#!/usr/bin/env node
// Deterministic facts for the `review` skill, computed before any reviewer agent spends tokens:
// which changed files are worth an agent's attention, mechanical convention hits on the lines
// this change added, and whether security- or compliance-sensitive code is touched at all.
//
//   pnpm review:precheck --base origin/dev [--head <ref>] [--since <sha>]
//
// Diff-scoped on purpose: it reads only lines the change added, so existing code never floods
// the output. It informs and never fails - the review verdict is the gate. Per-repo settings
// live under `reviewPrecheck` in .rulesync/sync.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { posix } from 'node:path';
// oxlint-disable no-console

const MAX_LINES_PER_CHECK = 25;
const MAX_HITS_PER_DOMAIN = 20;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const die = (message) => {
  console.error(`review:precheck - ${message}`);
  process.exit(1);
};

const args = (() => {
  const argv = process.argv.slice(2);
  const read = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const base = read('--base');
  if (!base) {
    die('usage: review:precheck --base <ref> [--head <ref>] [--since <sha>]');
  }
  return { base, head: read('--head') ?? 'HEAD', since: read('--since') };
})();

const git = (...gitArgs) =>
  execFileSync('git', gitArgs, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const gitOk = (...gitArgs) => spawnSync('git', gitArgs, { stdio: 'ignore' }).status === 0;

// Read from the trusted base revision, never the head branch: a PR that widened its own
// extraSkipGlobs to skip review of its own changes must not be able to trust itself.
const config = (() => {
  const path = '.rulesync/sync.json';
  if (!gitOk('cat-file', '-e', `${args.base}:${path}`)) {
    return {};
  }
  try {
    return JSON.parse(git('show', `${args.base}:${path}`)).reviewPrecheck ?? {};
  } catch (err) {
    return die(`${path} is not valid JSON at ${args.base}: ${err.message}`);
  }
})();

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')}$`,
  );

const SKIP_RULES = [
  { reason: 'lockfile', re: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/ },
  { reason: 'locale data (see i18n checks)', re: /(^|\/)locales\/.*\.json$/ },
  { reason: 'test', re: /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/ },
  {
    reason: 'generated',
    re: /(^|\/)drizzle\/migrations\/meta\/|(^|\/)next-env\.d\.ts$|routeTree\.gen\.ts$/,
  },
  ...(config.extraSkipGlobs ?? []).map((glob) => ({ reason: 'skip glob', re: globToRegExp(glob) })),
];
const skipReason = (path) => SKIP_RULES.find(({ re }) => re.test(path))?.reason;
const under = (paths, file) =>
  (paths ?? []).some((root) => file === root || file.startsWith(`${root.replace(/\/$/, '')}/`));

// ---- scope ---------------------------------------------------------------------------------

const range = `${args.base}...${args.head}`;
if (
  !gitOk('rev-parse', '--verify', '--quiet', args.base) ||
  !gitOk('rev-parse', '--verify', '--quiet', args.head)
) {
  die(`cannot resolve ${args.base} or ${args.head} - fetch them first`);
}

const numstat = new Map(
  git('diff', '--numstat', '--no-renames', range)
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [added, deleted, path] = row.split('\t');
      return [path, { added: Number(added) || 0, deleted: Number(deleted) || 0 }];
    }),
);

const notes = [];
let mode = 'full';
let scoped = [...numstat.keys()];
if (args.since) {
  if (gitOk('merge-base', '--is-ancestor', args.since, args.head)) {
    const changedSince = new Set(
      git('diff', '--name-only', '--no-renames', args.since, args.head).split('\n').filter(Boolean),
    );
    scoped = scoped.filter((path) => changedSince.has(path));
    mode = 'incremental';
  } else {
    notes.push(`NOTE: --since ${args.since} is not an ancestor of ${args.head} - full review`);
  }
}

const reviewable = scoped.filter((path) => !skipReason(path));
const skipped = scoped.filter((path) => skipReason(path));

// ---- added and removed lines ---------------------------------------------------------------

const parseDiff = (paths) => {
  const added = [];
  const removed = new Map();
  if (paths.length === 0) {
    return { added, removed };
  }
  let file;
  let line = 0;
  for (const row of git('diff', '-U0', '--no-renames', range, '--', ...paths).split('\n')) {
    if (row.startsWith('+++ ')) {
      file = row === '+++ /dev/null' ? undefined : row.slice(6);
    } else if (row.startsWith('@@')) {
      line = Number(row.match(/\+(\d+)/)?.[1] ?? 0);
    } else if (file && row.startsWith('+')) {
      added.push({ file, line, text: row.slice(1) });
      line += 1;
    } else if (file && row.startsWith('-') && !row.startsWith('--- ')) {
      removed.set(file, [...(removed.get(file) ?? []), row.slice(1).trim()]);
    }
  }
  return { added, removed };
};

const { added, removed } = parseDiff(reviewable.filter((path) => CODE_FILE.test(path)));

// ---- mechanical checks ---------------------------------------------------------------------

const findings = new Map();
const report = (check, severity, location, detail) =>
  findings.set(check, [
    ...(findings.get(check) ?? []),
    `[${severity}] ${location} - ${check} - ${detail}`,
  ]);

const CAST = /\bas\s+(?!const\b)[A-Za-z_$][\w.$]*(?:<[^>]*>)?(?:\[\])?/;
const LIMIT_LITERAL = /\b(limit|pageSize|perPage|take)\s*:\s*\d+\b/;
const LIMIT_CONSTANT = /\b[A-Z][A-Z0-9_]*(LIMIT|PAGE_SIZE|PER_PAGE|MAX_ROWS)\s*=\s*\d+/;
const HAND_MEMO = /\b(useMemo|useCallback|React\.memo|memo)\s*\(/;
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1).)*)\1/g;
const CLASS_TOKEN = /^[a-z0-9:!\[\]\-/.%#_]+$/;
const NON_CLASS_ATTRIBUTE = /\b(?!class(?:Name)?\b)[\w-]+=\{?\s*$/;
const bannedClassRules = config.bannedClasses ?? [];

for (const { file, line, text } of added) {
  const location = `${file}:${line}`;
  const isReexport =
    /^\s*(import|export)\b/.test(text) ||
    /\*\s+as\s+\w/.test(text) ||
    /^\s*\w+\s+as\s+\w+,?\s*$/.test(text);
  if (!isReexport && CAST.test(text)) {
    report('type-cast', 'WARN', location, `\`${text.match(CAST)[0]}\``);
  }
  const widened = text.trim().replace(/Partial<(Record<.*>)>/, '$1');
  if (widened !== text.trim() && (removed.get(file) ?? []).includes(widened)) {
    report(
      'type-cast',
      'WARN',
      location,
      '`Record` widened to `Partial<Record>` - exhaustiveness check lost',
    );
  }
  const limit = text.match(LIMIT_LITERAL) ?? text.match(LIMIT_CONSTANT);
  if (limit) {
    report(
      'hardcoded-limit',
      'INFO',
      location,
      `\`${limit[0]}\` - rows past it must stay reachable`,
    );
  }
  if (under(config.reactCompilerPaths, file) && HAND_MEMO.test(text)) {
    report(
      'hand-memo',
      'WARN',
      location,
      `\`${text.match(HAND_MEMO)[0]}\` under the React Compiler`,
    );
  }
  const bannedTokens = bannedClassRules
    .filter(({ paths }) => under(paths, file))
    .flatMap(({ tokens }) => tokens);
  if (bannedTokens.length > 0) {
    const looksLikeClasses = /class(Name)?\b/.test(text);
    for (const match of text.matchAll(STRING_LITERAL)) {
      const tokens = match[2].trim().split(/\s+/);
      const boundToOtherAttribute = NON_CLASS_ATTRIBUTE.test(text.slice(0, match.index));
      const classShaped = tokens.every((token) => CLASS_TOKEN.test(token));
      if (boundToOtherAttribute || !classShaped || (!looksLikeClasses && tokens.length < 2)) {
        continue;
      }
      const hits = tokens.filter((token) =>
        bannedTokens.some((banned) => token === banned || token.startsWith(`${banned}-`)),
      );
      if (hits.length > 0) {
        report('banned-class', 'WARN', location, `\`${[...new Set(hits)].join(' ')}\``);
      }
    }
  }
}
if (!config.reactCompilerPaths) {
  report('hand-memo', 'INFO', '-', 'not configured (reviewPrecheck.reactCompilerPaths)');
}
if (bannedClassRules.length === 0) {
  report('banned-class', 'INFO', '-', 'not configured (reviewPrecheck.bannedClasses)');
}

// ---- i18n ----------------------------------------------------------------------------------

const DEFAULT_LOCALE = config.defaultLocale ?? 'en';
const LOCALE_FILE = /^(?:(.+)-)?([a-z]{2}(?:-[A-Z]{2})?)\.json$/;

const flattenKeys = (value, prefix = '') =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) =>
        flattenKeys(child, prefix ? `${prefix}.${key}` : key),
      )
    : [prefix];
const keysAt = (ref, path) => {
  try {
    return new Set(flattenKeys(JSON.parse(git('show', `${ref}:${path}`))));
  } catch {
    return new Set();
  }
};
const localeFilesIn = (dir) =>
  git('ls-tree', '--name-only', `${args.head}:${dir}`)
    .split('\n')
    .filter((name) => LOCALE_FILE.test(name));
const treeExists = (dir) => gitOk('cat-file', '-e', `${args.head}:${dir}`);

const touchedLocaleDirs = new Set(
  scoped.map((path) => path.match(/^(.*\/locales)\/[^/]+\.json$/)?.[1]).filter(Boolean),
);
const mergeBase = git('merge-base', args.base, args.head).trim();
for (const dir of touchedLocaleDirs) {
  if (!treeExists(dir)) {
    continue;
  }
  const groups = new Map();
  for (const name of localeFilesIn(dir)) {
    const [, prefix = ''] = name.match(LOCALE_FILE);
    groups.set(prefix, [...(groups.get(prefix) ?? []), `${dir}/${name}`]);
  }
  for (const files of groups.values()) {
    if (files.length < 2) {
      continue;
    }
    const headKeys = files.map((path) => ({ path, keys: keysAt(args.head, path) }));
    const baseKeys = files.map((path) => ({ path, keys: keysAt(mergeBase, path) }));
    const baseUnion = new Set(baseKeys.flatMap(({ keys }) => [...keys]));
    const headUnion = new Set(headKeys.flatMap(({ keys }) => [...keys]));
    const newKeys = new Set(
      headKeys.flatMap(({ keys }) => [...keys]).filter((key) => !baseUnion.has(key)),
    );
    const shown = (keys) => {
      const list = [...keys];
      return `${list.slice(0, 5).join(', ')}${list.length > 5 ? ` (+${list.length - 5} more)` : ''}`;
    };
    for (const { path, keys } of headKeys) {
      const addedElsewhere = [...newKeys].filter((key) => !keys.has(key));
      if (addedElsewhere.length > 0) {
        report(
          'i18n-parity',
          'WARN',
          `${path}:1`,
          `missing ${addedElsewhere.length} key(s) a sibling locale added: ${shown(addedElsewhere)}`,
        );
      }
      // Dropped from this locale alone: still present in base and in a sibling at head, so a
      // sibling-only removal never floods the union but still breaks per-file parity.
      const priorKeys = baseKeys.find((entry) => entry.path === path)?.keys ?? new Set();
      const droppedHere = [...priorKeys].filter((key) => !keys.has(key) && headUnion.has(key));
      if (droppedHere.length > 0) {
        report(
          'i18n-parity',
          'WARN',
          `${path}:1`,
          `dropped ${droppedHere.length} key(s) a sibling locale still has: ${shown(droppedHere)}`,
        );
      }
    }
  }
}

const defaultKeysCache = new Map();
const defaultLocaleKeysFor = (file) => {
  let dir = posix.dirname(file);
  while (dir && dir !== '.') {
    const localesDir = `${dir}/locales`;
    if (defaultKeysCache.has(localesDir)) {
      return defaultKeysCache.get(localesDir);
    }
    if (treeExists(localesDir)) {
      const keys = new Set(
        localeFilesIn(localesDir)
          .filter((name) => name.match(LOCALE_FILE)[2] === DEFAULT_LOCALE)
          .flatMap((name) => [...keysAt(args.head, `${localesDir}/${name}`)]),
      );
      defaultKeysCache.set(localesDir, keys);
      return keys;
    }
    dir = posix.dirname(dir);
  }
  return undefined;
};
const T_CALL = /\bt\(\s*['"]([\w.-]+)['"]/g;
for (const { file, line, text } of added) {
  for (const [, rawKey] of text.matchAll(T_CALL)) {
    const keys = defaultLocaleKeysFor(file);
    const key = rawKey.includes(':') ? rawKey.split(':').at(-1) : rawKey;
    const known =
      keys && ['', '_one', '_other', '_zero'].some((suffix) => keys.has(`${key}${suffix}`));
    if (keys && !known) {
      report(
        'i18n-missing-key',
        'INFO',
        `${file}:${line}`,
        `\`${key}\` not in the nearest ${DEFAULT_LOCALE} locale file (another namespace?)`,
      );
    }
  }
}

// ---- domains -------------------------------------------------------------------------------

const DOMAIN_PATTERNS = {
  security: [
    'auth',
    'session',
    'guard',
    'permission',
    'process\\.env',
    'import\\.meta\\.env',
    'secret',
    '\\btoken\\b',
    'webhook',
    'signature',
    'adapter',
    '\\bfetch\\(',
    'dangerouslySetInnerHTML',
    '\\b(href|src)=\\{',
    'password',
    'cookie',
    'cors',
  ],
  compliance: [
    'wallet',
    'ledger',
    'balance',
    'deposit',
    'withdraw',
    '\\bkyc\\b',
    'age.?verif',
    'date.?of.?birth',
    '\\bgeo',
    'jurisdiction',
    'self.?exclu',
    'cool.?(off|ing)',
    '\\brg\\b',
    'responsible.?gambl',
    '(deposit|loss|wager|session|time).?limit',
    'wager',
    'bonus',
    'audit',
    '\\baml\\b',
  ],
};
for (const [domain, defaults] of Object.entries(DOMAIN_PATTERNS)) {
  const patterns = [...defaults, ...(config.domainPatterns?.[domain] ?? [])].map(
    (source) => new RegExp(source, 'i'),
  );
  const hits = [
    ...reviewable.flatMap((path) => {
      const pattern = patterns.find((re) => re.test(path));
      return pattern ? [`${path} - path matches /${pattern.source}/`] : [];
    }),
    ...added.flatMap(({ file, line, text }) => {
      const pattern = patterns.find((re) => re.test(text));
      return pattern ? [`${file}:${line} - /${pattern.source}/`] : [];
    }),
    // A removed line can delete a guard or a limit check as easily as an added line can
    // introduce one - a path with no added domain keyword can still lose one.
    ...[...removed.entries()].flatMap(([file, texts]) =>
      texts.flatMap((text) => {
        const pattern = patterns.find((re) => re.test(text));
        return pattern ? [`${file} - /${pattern.source}/ (removed)`] : [];
      }),
    ),
  ];
  findings.set(`domain:${domain}`, [
    `DOMAIN: ${domain} hits ${hits.length}`,
    ...hits.slice(0, MAX_HITS_PER_DOMAIN).map((hit) => `DOMAIN-HIT: ${domain} ${hit}`),
    ...(hits.length > MAX_HITS_PER_DOMAIN
      ? [`DOMAIN-HIT: ${domain} +${hits.length - MAX_HITS_PER_DOMAIN} more`]
      : []),
  ]);
}

// ---- output --------------------------------------------------------------------------------

const lines = (path) => numstat.get(path);
const totals = scoped.reduce(
  (sum, path) => ({
    added: sum.added + lines(path).added,
    deleted: sum.deleted + lines(path).deleted,
  }),
  { added: 0, deleted: 0 },
);
const reviewableChanged = reviewable.reduce(
  (sum, path) => sum + lines(path).added + lines(path).deleted,
  0,
);

console.log(
  `SCOPE: files ${scoped.length} lines +${totals.added}/-${totals.deleted} reviewable ${reviewable.length} (${reviewableChanged} changed lines) skipped ${skipped.length} mode ${mode}`,
);
notes.forEach((note) => console.log(note));
reviewable.forEach((path) =>
  console.log(`REVIEWABLE: ${path} +${lines(path).added}/-${lines(path).deleted}`),
);
skipped.forEach((path) => console.log(`SKIPPED: ${path} - ${skipReason(path)}`));
for (const [check, rows] of findings) {
  if (check.startsWith('domain:')) {
    rows.forEach((row) => console.log(row));
    continue;
  }
  rows.slice(0, MAX_LINES_PER_CHECK).forEach((row) => console.log(`PRECHECK: ${row}`));
  if (rows.length > MAX_LINES_PER_CHECK) {
    console.log(`PRECHECK: [INFO] - ${check} - +${rows.length - MAX_LINES_PER_CHECK} more`);
  }
}
