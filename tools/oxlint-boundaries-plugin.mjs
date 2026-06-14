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
//   no-cross-addon             - an add-on must not import another add-on's code (schema subpath ok)
//   no-addon-internal-import   - no add-on may be imported via a non-public subpath (root + /schema only)
//   no-core-to-addon           - core (platform/contracts/sdks, except the two composition roots) must not import add-ons
//   no-contracts-to-runtime    - contracts/* may import only other contracts and zod
//   no-deep-dist-import        - never @oss/*/dist/** deep paths

function filename(context) {
  return (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
}

function inPath(file, segment) {
  return file.includes('/' + segment + '/') || file.includes('/' + segment);
}

// The core OSS build must never reach into an add-on (optional, extract-later)
// package. Anything under packages/{platform,contracts,sdks}/ importing an
// `@oss-addons/*` specifier is forbidden - only the composition roots under apps/*
// (and add-on packages themselves) may. The two in-tree composition roots
// packages/platform/(api-runtime|testing)/ are exempt: their seed + tenant-resolver
// code reads add-on /schema subpaths. This string-level twin gives per-edit
// feedback; the whole-graph `no-core-to-addon` rule catches transitive/dynamic
// edges. See ADR-0020.
function isCoreFile(file) {
  // The composition roots are NOT core for this rule - they wire add-ons in.
  if (inPath(file, 'packages/platform/api-runtime')) return false;
  if (inPath(file, 'packages/platform/testing')) return false;
  return (
    inPath(file, 'packages/platform') ||
    inPath(file, 'packages/contracts') ||
    inPath(file, 'packages/sdks')
  );
}

function isAddonSpecifier(spec) {
  return spec === '@oss-addons' || spec.startsWith('@oss-addons/');
}

const noCoreToAddon = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!isCoreFile(filename(context))) return;
        if (!isAddonSpecifier(node.source.value)) return;
        context.report({
          node,
          message:
            'The core OSS build must not import an add-on package (@oss-addons/*). ' +
            'The only exceptions are the two composition roots under ' +
            'packages/platform/(api-runtime|testing)/; elsewhere add-on is wired only by the ' +
            'composition roots under apps/* (extensions.config.ts + the createApp contract merge). ' +
            'This keeps add-on packages extractable. See ADR-0020.',
        });
      },
    };
  },
};

// An add-on package under packages/addons/<name>/ may import core (@oss/*) but
// never a sibling add-on package. The sole sanctioned cross-add-on coupling is a
// read-only `@oss-addons/<name>/schema` subpath import; reaching the bare root
// (@oss-addons/<name>) or any other internal subpath of a sibling is forbidden, so
// each add-on package stays independently optional/extractable.
function importingAddon(file) {
  const m = file.match(/packages\/addons\/([a-z0-9-]+)\//);
  return m ? m[1] : null;
}

// @oss-addons/<name>            -> bare root import of a sibling = blocked
// @oss-addons/<name>/schema     -> sanctioned read-only subpath = allowed
// @oss-addons/<name>/<other>    -> reaching into internals = blocked
function addonImportTarget(spec) {
  if (!spec.startsWith('@oss-addons/')) return null;
  const tail = spec.slice('@oss-addons/'.length).split('/').filter(Boolean);
  if (tail.length === 0) return null;
  const name = tail[0];
  const isSchemaSubpath = tail.length === 2 && tail[1] === 'schema';
  return { name, isSchemaSubpath, segments: tail.length };
}

const noCrossAddon = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const self = importingAddon(filename(context));
        if (!self) return;
        const target = addonImportTarget(node.source.value);
        if (!target || target.name === self) return;
        // The read-only /schema subpath of a sibling add-on is the one sanctioned
        // cross-add-on coupling (money stays transactional; reporting reads are
        // pragmatic). Allowed, but it couples the two packages at the data layer.
        if (target.isSchemaSubpath) return;
        context.report({
          node,
          message:
            `An add-on package must not import another add-on package (${node.source.value}). ` +
            'Import a sibling only through its read-only /schema subpath ' +
            '(@oss-addons/<name>/schema); communicate otherwise via events or a command port. ' +
            'See ADR-0020.',
        });
      },
    };
  },
};

const blocked_by_contracts = [
  '@oss-addons',
  '@oss/core',
  '@oss/db',
  '@oss/auth',
  '@oss/plugin-host',
  '@oss/api-runtime',
];

const noContractsToRuntime = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!inPath(file, 'packages/contracts')) return;
        const spec = node.source.value;
        const blocked = blocked_by_contracts.some((b) => spec === b || spec.startsWith(b + '/'));
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
              '(e.g. @oss-addons/wallet/schema).',
          });
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

// A router (src/router/*.ts) is thin oRPC wiring: resolve the caller, call the
// service, map errors. The canonical request/response shapes live in the contract
// slice (@oss/orpc-contract/<module>) - the single source of truth that also emits
// OpenAPI + the typed client. Defining a Zod schema inline in a router (`z.object`,
// `z.array`, ...) forks that source of truth and drifts the spec. Flag every
// schema-constructing `z.<method>(...)` call in a router file. See clean-architecture.md.
const ZOD_BUILDERS = new Set([
  'object',
  'array',
  'string',
  'number',
  'boolean',
  'enum',
  'nativeEnum',
  'union',
  'discriminatedUnion',
  'record',
  'tuple',
  'literal',
  'intersection',
]);
const noAdhocZodInRouter = {
  create(context) {
    return {
      CallExpression(node) {
        const file = filename(context);
        if (!inPath(file, 'src/router')) return;
        const callee = node.callee;
        if (
          callee?.type === 'MemberExpression' &&
          callee.object?.type === 'Identifier' &&
          callee.object.name === 'z' &&
          callee.property?.type === 'Identifier' &&
          ZOD_BUILDERS.has(callee.property.name)
        ) {
          context.report({
            node,
            message:
              `Ad-hoc Zod (z.${callee.property.name}(...)) in a router. Define the shape in ` +
              'the contract slice (@oss/orpc-contract/<module>) - the source of truth for ' +
              'validation + OpenAPI + the typed client - and reference it. See clean-architecture.md.',
          });
        }
      },
    };
  },
};

export default {
  meta: { name: 'oss-boundaries' },
  rules: {
    'no-cross-addon': noCrossAddon,
    'no-core-to-addon': noCoreToAddon,
    'no-contracts-to-runtime': noContractsToRuntime,
    'no-deep-dist-import': noDeepDistImport,
    'no-cross-extension-import': noCrossExtensionImport,
    'no-adhoc-zod-in-router': noAdhocZodInRouter,
  },
};
