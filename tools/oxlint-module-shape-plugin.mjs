// Deterministic module-structure + naming lint enforcement for oxlint (jsPlugins).
// Loaded via jsPlugins in .oxlintrc.json, same house pattern as oxlint-boundaries-plugin.mjs
// (string/path checks, no AST gymnastics, no import resolution). Scope: packages/core/src/**
// only, skipping the engine zones (contracts/server/react/scripts) - those are checked by
// tools/verify-module-shape.ts instead. See AGENTS.md > Where does X go? / db-conventions.
//
// Rules:
//   module-file-placement - every .ts file inside a folded domain must live in one of the
//     canonical layer dirs (schema, schemas, contract, service, router, adapters, react,
//     drizzle, __tests__, seed, moderation, shared) or be a sanctioned root file (index.ts,
//     plugin.ts, migrate.ts, drizzle.config.ts, or a surveyed root feature file such as
//     wallet's admin-reporting.ts). Stops new strays; does not force a mass move of the
//     current tree.
//   layer-file-naming - files directly in service/ end .service.ts (plus a short surveyed
//     allowlist of pre-existing exceptions); files in __tests__/ end .test.ts.
//   no-inline-pg-enum - pgEnum('name', [...]) with an inline array literal is an error;
//     values must come from a named tuple (see packages/core/src/wallet/schema/index.ts).

const ENGINE_ZONES = new Set(['contracts', 'server', 'react', 'scripts']);
// common/ and testing/ are cross-cutting utility dirs, not folded domains (no index.ts at
// their root, not checked by verify-module-shape.ts either) - out of scope here too.
const EXCLUDED_TOP_DIRS = new Set(['common', 'testing']);

const LAYER_DIRS = new Set([
  'schema',
  'schemas',
  'contract',
  'service',
  'router',
  'adapters',
  'react',
  'drizzle',
  '__tests__',
  'seed',
  'moderation',
  'shared',
]);

const ROOT_ALLOWED_FILES = new Set([
  'index.ts',
  'plugin.ts',
  'migrate.ts',
  'drizzle.config.ts',
  'contracts.ts',
  'server.ts',
  'react.ts',
  'admin-reporting.ts',
  'admin-user-directory.ts',
  'sealed.ts',
  'assert.ts',
]);

const SERVICE_FILE_ALLOWLIST = new Set(['ports.ts', 're-kyc-trigger.ts', 'kyc-status-writer.ts']);

function filename(context) {
  return (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
}

// Path relative to packages/core/src/, split into segments, or null if outside that tree.
function coreSrcSegments(file) {
  const m = file.match(/packages\/core\/src\/(.+)$/);
  return m ? m[1].split('/') : null;
}

const moduleFilePlacement = {
  create(context) {
    return {
      Program(node) {
        const segments = coreSrcSegments(filename(context));
        if (!segments || segments.length < 2) return;
        const [domain, ...rest] = segments;
        if (ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) return;

        if (rest.length === 1) {
          if (!ROOT_ALLOWED_FILES.has(rest[0])) {
            context.report({
              node,
              message:
                `${rest[0]} sits at the packages/core/src/${domain} root but isn't a ` +
                'sanctioned root file (index.ts, plugin.ts, migrate.ts, drizzle.config.ts, ' +
                'contracts.ts, server.ts, react.ts, or a surveyed feature file). Move it into ' +
                'a canonical layer dir (schema/, schemas/, contract/, service/, router/, ' +
                'adapters/, react/, drizzle/, __tests__/, seed/).',
            });
          }
          return;
        }

        if (LAYER_DIRS.has(rest[0])) return;

        if (rest.length === 2) {
          if (!ROOT_ALLOWED_FILES.has(rest[1])) {
            context.report({
              node,
              message:
                `${rest[1]} sits at the packages/core/src/${domain}/${rest[0]} module root but ` +
                "isn't a sanctioned root file. Move it into a canonical layer dir (schema/, " +
                'schemas/, contract/, service/, router/, adapters/, react/, drizzle/, __tests__/).',
            });
          }
          return;
        }

        if (LAYER_DIRS.has(rest[1])) return;

        context.report({
          node,
          message:
            `packages/core/src/${domain}/${rest[0]}/${rest[1]} is not a canonical layer dir ` +
            '(schema, schemas, contract, service, router, adapters, react, drizzle, __tests__, ' +
            'seed) and not a sanctioned root file. Place new files inside a canonical layer.',
        });
      },
    };
  },
};

const layerFileNaming = {
  create(context) {
    return {
      Program(node) {
        const segments = coreSrcSegments(filename(context));
        if (!segments || segments.length < 2) return;
        const [domain, ...rest] = segments;
        if (ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) return;

        const layerIdx = LAYER_DIRS.has(rest[0])
          ? 0
          : rest.length >= 2 && LAYER_DIRS.has(rest[1])
            ? 1
            : -1;
        if (layerIdx === -1) return;
        const layer = rest[layerIdx];
        // Only enforce naming on files directly inside the layer dir, not nested subfolders
        // (adapters/mock/*, seed/data/* stay free-form - the layer dirs with a naming rule
        // are service/ and __tests__/, neither of which has nested subfolders today).
        if (rest.length !== layerIdx + 2) return;
        const base = rest[layerIdx + 1];

        if (
          layer === 'service' &&
          !base.endsWith('.service.ts') &&
          !SERVICE_FILE_ALLOWLIST.has(base)
        ) {
          context.report({
            node,
            message: `${base} is in service/ but doesn't end .service.ts - rename it (eg wallet.service.ts).`,
          });
        }
        if (layer === '__tests__' && !base.endsWith('.test.ts')) {
          context.report({
            node,
            message: `${base} is in __tests__/ but doesn't end .test.ts - rename it (Vitest co-located tests).`,
          });
        }
      },
    };
  },
};

function isPgEnumCall(node) {
  return node.callee?.type === 'Identifier' && node.callee.name === 'pgEnum';
}

const noInlinePgEnum = {
  create(context) {
    return {
      CallExpression(node) {
        if (!isPgEnumCall(node)) return;
        const valuesArg = node.arguments[1];
        if (valuesArg?.type === 'ArrayExpression') {
          context.report({
            node,
            message:
              'derive pgEnum values from the canonical contract tuple - see wallet schema ' +
              '(packages/core/src/wallet/schema/index.ts) - not an inline array literal.',
          });
        }
      },
    };
  },
};

export default {
  meta: { name: 'oss-module-shape' },
  rules: {
    'module-file-placement': moduleFilePlacement,
    'layer-file-naming': layerFileNaming,
    'no-inline-pg-enum': noInlinePgEnum,
  },
};
