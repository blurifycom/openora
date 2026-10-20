import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

const MCP_COMMAND = 'node';
const MCP_ARGS = ['node_modules/@openora/mcp/dist/main.js'];
const SKIPPED_BASENAMES = new Set();

export type ParsedArgs = {
  target: string;
  name?: string;
  telemetry: boolean;
};

const USAGE = 'Usage: npm create @openora <target-dir> [--name <name>] [--no-telemetry]';

function readFlag(args: string[], index: number): { value: string | undefined; next: number } {
  const arg = args[index] ?? '';
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    return { value: arg.slice(eq + 1), next: index };
  }
  return { value: args[index + 1], next: index + 1 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let target: string | undefined;
  let name: string | undefined;
  let telemetry = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--name' || arg.startsWith('--name=')) {
      const flag = readFlag(args, i);
      name = flag.value;
      i = flag.next;
    } else if (arg === '--no-telemetry') {
      telemetry = false;
    } else if (!arg.startsWith('-') && !target) {
      target = arg;
    }
  }
  if (!target) {
    throw new Error(`missing target directory.\n  ${USAGE}`);
  }
  return name === undefined ? { target, telemetry } : { target, name, telemetry };
}

function isSet(flag: string | undefined): boolean {
  return flag !== undefined && ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
}

// Mirrors `isTelemetryEnabled` in core's server/runtime/telemetry.ts; change both together.
export function isTelemetryEnabled(telemetry: boolean, env: NodeJS.ProcessEnv): boolean {
  return (
    telemetry &&
    !isSet(env['OPENORA_TELEMETRY_DISABLED']) &&
    !isSet(env['DO_NOT_TRACK']) &&
    env['CI'] === undefined &&
    env['NODE_ENV'] !== 'test'
  );
}

export function sanitizeName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/^-+|-+$/g, '') || 'igaming-app'
  );
}

export function posix(path: string): string {
  return path.split(sep).join('/');
}

export function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

export function undotSegment(segment: string): string {
  return segment.startsWith('__dot__') ? `.${segment.slice('__dot__'.length)}` : segment;
}

export function outputPath(templateRel: string): string {
  const mapped = templateRel.split(sep).map(undotSegment).join(sep);
  return mapped.endsWith('.tpl') ? mapped.slice(0, -'.tpl'.length) : mapped;
}

export function emitTree(srcRoot: string, vars: Record<string, string>, targetDir: string): void {
  for (const file of walk(srcRoot)) {
    if (SKIPPED_BASENAMES.has(basename(file))) {
      continue;
    }

    const outRel = outputPath(relative(srcRoot, file));

    const raw = readFileSync(file, 'utf8');
    const content = file.endsWith('.tpl') ? substitute(raw, vars) : raw;

    const outPath = join(targetDir, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
    console.log(`  + ${posix(outRel)}`);
  }
}

// Operator coordinates the agent files reference. A fresh scaffold gets placeholders;
// the consumer fills them in once in .rulesync/sync.json and `pnpm sync:agents`
// re-renders every template-owned file from them.
export function buildVars(name: string, coreVersion: string): Record<string, string> {
  return {
    name,
    coreVersion,
    mcpCommand: MCP_COMMAND,
    mcpArgsJson: JSON.stringify(MCP_ARGS),
    scope: `@${name}`,
    trackerKey: 'KEY',
    jiraSite: '<your-site>.atlassian.net',
    jiraCloudId: '<your-jira-cloud-id>',
    wikiSpace: '<your-wiki-space>',
    teamChannel: '#<your-team-channel>',
    gitRemotePath: '<group>/<repo>',
    ossDir: '../openora',
    // Only meaningful once the consumer links a local platform checkout; until then the
    // guard-core hook simply never matches.
    ossFromRoot: '../openora',
    mrTarget: 'dev',
  };
}
