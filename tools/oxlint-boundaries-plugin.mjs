// Architectural boundary enforcement for oxlint (replaces eslint-plugin-boundaries).
// Loaded via jsPlugins in .oxlintrc.json. API is ESLint v9-compatible.
//
// Why a hand-written plugin and not eslint-plugin-boundaries:
//   oxlint CAN load eslint-plugin-boundaries as a jsPlugin (settings are honored),
//   so the "no oxlint equivalent" concern is moot. But boundaries enforces nothing
//   unless every @oss/* import resolves to a file - which means a native import
//   resolver (unrs-resolver) plus a maintained lint-only tsconfig mapping all ~24
//   @oss/* packages to src (pnpm otherwise resolves them to dist and misclassifies
//   elements). This plugin matches specifier strings directly: zero deps, zero
//   resolution, fast. We deliberately keep it. See ADR-0015.
//
// Rules mirror the enforced classes in AGENTS.md > Dependency rules:
//   no-cross-module-import     - modules must not import another module's code (schema subpath ok)
//   no-module-internal-import  - no module may be imported via a non-public subpath (root + /schema only)
//   no-platform-to-module      - platform/* (except api-runtime + testing) must not import modules or UI
//   no-contracts-to-runtime    - contracts/* may import only other contracts and zod
//   no-deep-dist-import        - never @oss/*/dist/** deep paths

function filename(context) {
  return (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
}

function inPath(file, segment) {
  return file.includes('/' + segment + '/') || file.includes('/' + segment);
}

// @oss/modules/<group>/<name>  ->  2 extra segments (bare cross-module, blocked)
// @oss/modules/<group>/<name>/schema ->  3+ extra segments (subpath, allowed)
function isBareModuleImport(spec) {
  if (!spec.startsWith('@oss/modules/')) return false;
  const tail = spec.slice('@oss/modules/'.length);
  return tail.split('/').filter(Boolean).length === 2;
}

const noCrossModuleImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!inPath(file, 'packages/modules')) return;
        if (!isBareModuleImport(node.source.value)) return;
        context.report({
          node,
          message:
            "Modules must not import another module's code. " +
            'Use events (@Inject(EVENT_BUS)) or the schema subpath ' +
            '(@oss/modules/<group>/<name>/schema). See AGENTS.md > Dependency rules.',
        });
      },
    };
  },
};

// A module's public API is its root entry (@oss/modules/<group>/<name>) plus the
// read-only schema subpath (@oss/modules/<group>/<name>/schema). Any deeper path
// reaches into a module's internals (service/, router/, schemas/, ui/, ...) and is
// forbidden from anywhere - the bare cross-module case is handled by
// no-cross-module-import; this rule closes the "barrel" gap for subpath imports.
function isDisallowedModuleSubpath(spec) {
  if (!spec.startsWith('@oss/modules/')) return false;
  const tail = spec.slice('@oss/modules/'.length).split('/').filter(Boolean);
  if (tail.length <= 2) return false; // bare <group>/<name> -> no-cross-module-import
  if (tail.length === 3 && tail[2] === 'schema') return false; // public schema subpath
  return true;
}

const noModuleInternalImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!isDisallowedModuleSubpath(node.source.value)) return;
        context.report({
          node,
          message:
            'Import a module only through its public entry ' +
            '(@oss/modules/<group>/<name>) or its schema subpath ' +
            '(@oss/modules/<group>/<name>/schema). Reaching into a module ' +
            "(service/, router/, ui/, ...) is forbidden. See AGENTS.md > Dependency rules.",
        });
      },
    };
  },
};

// A cross-module read via the sanctioned `/schema` subpath is ALLOWED (money stays
// transactional, reporting reads are pragmatic) - but it couples the two modules at
// the data layer, so neither can move to its own database without first replacing
// the read. This rule is a WARNING (not an error): it surfaces every such coupling
// as an extraction-readiness checklist, without blocking. Prefer a command port
// (eg WALLET_COMMANDS) for writes or an event-fed read model for reporting. ADR-0017.
function importingModule(file) {
  const m = file.match(/packages\/modules\/([a-z-]+)\/([a-z0-9-]+)\//);
  return m ? `${m[1]}/${m[2]}` : null;
}

function crossModuleSchemaTarget(spec) {
  if (!spec.startsWith('@oss/modules/')) return null;
  const tail = spec.slice('@oss/modules/'.length).split('/').filter(Boolean);
  if (tail.length === 3 && tail[2] === 'schema') return `${tail[0]}/${tail[1]}`;
  return null;
}

const noCrossModuleSchemaRead = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const self = importingModule(filename(context));
        if (!self) return;
        const target = crossModuleSchemaTarget(node.source.value);
        if (!target || target === self) return;
        context.report({
          node,
          message:
            `Cross-module table read (${node.source.value}). Sanctioned, but it ` +
            'couples the two modules at the data layer and blocks extracting either ' +
            'to its own database. Prefer a command port (eg WALLET_COMMANDS) or an ' +
            'event-fed read model before extraction. See ADR-0017.',
        });
      },
    };
  },
};

const noPlatformToModule = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!inPath(file, 'packages/platform')) return;
        // api-runtime is the composition root - it may import everything.
        // testing is the *test* composition root: it boots the full app and
        // seeds, so it likewise needs module schemas (it is devDependency-only).
        if (inPath(file, 'packages/platform/api-runtime')) return;
        if (inPath(file, 'packages/platform/testing')) return;
        const spec = node.source.value;
        if (spec === '@oss/modules' || spec.startsWith('@oss/modules/') || spec.startsWith('@oss/ui-')) {
          context.report({
            node,
            message:
              'platform/* must not import feature modules or UI. ' +
              'Import only other @oss/platform/* or @oss/contracts/*. See AGENTS.md > Dependency rules.',
          });
        }
      },
    };
  },
};

const blocked_by_contracts = [
  '@oss/modules', '@oss/core', '@oss/db', '@oss/auth',
  '@oss/plugin-host', '@oss/api-runtime', '@oss/sdk-core', '@oss/react-pages',
];

const noContractsToRuntime = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!inPath(file, 'packages/contracts')) return;
        const spec = node.source.value;
        const blocked =
          blocked_by_contracts.some((b) => spec === b || spec.startsWith(b + '/')) ||
          spec.startsWith('@oss/ui-');
        if (blocked) {
          context.report({
            node,
            message:
              'contracts/* may import only other contracts and zod. See AGENTS.md > Dependency rules.',
          });
        }
      },
    };
  },
};

const noDeepDistImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (/^@oss\/[^/]+\/dist\/|^@oss\/.+\/dist\//.test(spec)) {
          context.report({
            node,
            message:
              'Never import a deep dist/ path. Use the package entry instead ' +
              '(e.g. @oss/modules/player/wallet/schema).',
          });
        }
      },
    };
  },
};

// Layer DAG for the SDK packages (ADR-0013):
//   @oss/react-pages -> @oss/react-blocks -> @oss/react-hooks
// react-hooks is the leaf - it must not import @oss/react-blocks or @oss/react-pages.
// react-blocks may import react-hooks - not react-pages.
const noSdkLayerInversion = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        const spec = node.source.value;
        if (inPath(file, 'packages/sdks/react-hooks')) {
          if (
            spec === '@oss/react-blocks' ||
            spec.startsWith('@oss/react-blocks/') ||
            spec === '@oss/react-pages' ||
            spec.startsWith('@oss/react-pages/')
          ) {
            context.report({
              node,
              message:
                'react-hooks must not import react-blocks or react-pages. ' +
                'Layer DAG: react-pages -> react-blocks -> react-hooks. See ADR-0013.',
            });
          }
        } else if (inPath(file, 'packages/sdks/react-blocks')) {
          if (spec === '@oss/react-pages' || spec.startsWith('@oss/react-pages/')) {
            context.report({
              node,
              message:
                'react-blocks must not import react-pages. ' +
                'Layer DAG: react-pages -> react-blocks -> react-hooks. See ADR-0013.',
            });
          }
        }
      },
    };
  },
};

// An overlay extension under apps/api/src/extensions/<name>/ may import any
// @oss/* package but never a sibling extension. Cross-extension communication
// goes through the event bus.
const noCrossExtensionImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        const m = file.match(/apps\/api\/src\/extensions\/([^/]+)\//);
        if (!m) return;
        const ownExt = m[1];
        const spec = node.source.value;
        // Only relative imports can cross-reach into another extension folder.
        if (!spec.startsWith('.')) return;
        // Resolve specifier path segments and look for "../<other-ext>/"
        const segments = spec.split('/').filter(Boolean);
        // Walk past leading "..": stop once we hit a non-".." segment.
        let i = 0;
        while (i < segments.length && segments[i] === '..') i++;
        if (i === 0) return;
        // The segment right after the leading ".." should be the target folder
        // if we crossed the extensions/<name> boundary. If that target equals a
        // sibling extension name, flag it.
        const target = segments[i];
        if (!target) return;
        if (target !== ownExt && target !== 'extensions' && target.length > 0) {
          // Heuristic: anything reaching outside the current extension folder
          // is suspicious; only allow imports that traverse OUT of the
          // extensions/ tree entirely (i.e. land in apps/api/src/ or beyond).
          // We treat "../<sibling>" (one ".." then a name that is NOT 'extensions')
          // as the cross-extension case.
          if (i === 1) {
            context.report({
              node,
              message:
                'An overlay extension must not import another extension. ' +
                'Cross-extension communication goes through the event bus. ' +
                'See apps/api/src/extensions/AGENTS.md.',
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'oss-boundaries' },
  rules: {
    'no-cross-module-import': noCrossModuleImport,
    'no-cross-module-schema-read': noCrossModuleSchemaRead,
    'no-module-internal-import': noModuleInternalImport,
    'no-platform-to-module': noPlatformToModule,
    'no-contracts-to-runtime': noContractsToRuntime,
    'no-deep-dist-import': noDeepDistImport,
    'no-sdk-layer-inversion': noSdkLayerInversion,
    'no-cross-extension-import': noCrossExtensionImport,
  },
};
