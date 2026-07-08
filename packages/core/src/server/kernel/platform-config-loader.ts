import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  definePlatformConfig,
  defaultPlatformConfig,
  type PlatformConfig,
  type PlatformConfigInput,
} from '@openora/core/contracts';

/**
 * Load + validate a PlatformConfig from a file at boot. Used by `createApp` to
 * seed the `PLATFORM_CONFIG` Container token, and by consumers' frontends to
 * seed the slot evaluation context.
 *
 * Supported file shapes:
 * - `.json`  - parsed with JSON.parse
 * - `.yaml` / `.yml` - parsed with a tiny KV reader (no nested structures
 *   beyond what PlatformConfig actually needs). For richer YAML, parse it
 *   yourself with `yaml`/`js-yaml` and call `definePlatformConfig(obj)`.
 *
 * If `path` is omitted or the file does not exist, returns `defaultPlatformConfig`.
 *
 * On parse / schema failure, throws an Error with the offending paths.
 */
export function loadPlatformConfig(path?: string): PlatformConfig {
  if (!path) return defaultPlatformConfig;
  const abs = resolve(path);
  if (!existsSync(abs)) return defaultPlatformConfig;

  const raw = readFileSync(abs, 'utf8');
  const ext = abs.split('.').pop()?.toLowerCase();

  let parsed: unknown;
  if (ext === 'json') {
    parsed = JSON.parse(raw);
  } else if (ext === 'yaml' || ext === 'yml') {
    parsed = parseTrivialYaml(raw);
  } else {
    throw new Error(
      `[platform-config] unsupported extension ".${ext}" for ${abs}. ` +
        `Use .json, .yaml, or .yml.`,
    );
  }

  return definePlatformConfig(parsed as PlatformConfigInput);
}

/**
 * Resolve the platform config path from env, defaulting to
 * `./platform-config.{yaml,json}` in cwd. Returns undefined if nothing is found.
 */
export function resolvePlatformConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PLATFORM_CONFIG_PATH) return env.PLATFORM_CONFIG_PATH;
  for (const candidate of ['platform-config.yaml', 'platform-config.yml', 'platform-config.json']) {
    const abs = resolve(candidate);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

function parseTrivialYaml(input: string): unknown {
  type Node = {
    indent: number;
    key?: string;
    value?: string;
    isListItem?: boolean;
    children: Node[];
  };
  const root: Node = { indent: -1, children: [] };
  const stack: Node[] = [root];
  const lines = input.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();

    while (stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!;

    if (body.startsWith('- ')) {
      const inner = body.slice(2).trim();
      const item: Node = { indent, isListItem: true, children: [] };
      const colon = inner.indexOf(':');
      if (colon !== -1) {
        item.children.push({
          indent: indent + 2,
          key: inner.slice(0, colon).trim(),
          value: inner.slice(colon + 1).trim() || undefined,
          children: [],
        });
      } else {
        item.value = inner;
      }
      parent.children.push(item);
      stack.push(item);
    } else {
      const colon = body.indexOf(':');
      if (colon === -1) continue;
      const key = body.slice(0, colon).trim();
      const value = body.slice(colon + 1).trim();
      const node: Node = { indent, key, value: value || undefined, children: [] };
      parent.children.push(node);
      stack.push(node);
    }
  }

  function build(node: Node): unknown {
    if (node.children.length === 0) {
      return parseScalar(node.value);
    }
    if (node.children.every((c) => c.isListItem)) {
      return node.children.map((c) => {
        if (c.children.length > 0) {
          const obj: Record<string, unknown> = {};
          for (const kv of c.children) {
            if (kv.key !== undefined) obj[kv.key] = build(kv);
          }
          return obj;
        }
        return parseScalar(c.value);
      });
    }
    const obj: Record<string, unknown> = {};
    for (const c of node.children) {
      if (c.key !== undefined) obj[c.key] = build(c);
    }
    return obj;
  }

  function parseScalar(v: string | undefined): unknown {
    if (v === undefined || v === '') return undefined;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return Number.parseFloat(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  return build(root);
}
