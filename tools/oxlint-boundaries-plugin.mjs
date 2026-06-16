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

// The published core (@oss/core = packages/core) must never reach into an add-on
// (optional, extract-later) package. Anything under packages/core/ importing an
// `@oss-addons/*` specifier is forbidden - only the composition roots under apps/*
// (and the @oss/testing harness, and add-on packages themselves) may. This
// string-level twin gives per-edit feedback; the whole-graph `no-core-to-addon`
// rule catches transitive/dynamic edges. See ADR-0021/0025.
function isCoreFile(file) {
  return inPath(file, 'packages/core');
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
            'The published core (@oss/core) must not import an add-on package (@oss-addons/*). ' +
            'Add-on is wired in only by the composition roots under apps/* ' +
            '(extensions.config.ts + the editions contract merge) and the @oss/testing harness. ' +
            'This keeps add-on packages extractable. See ADR-0021/0025.',
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

// Server/runtime specifiers that must never reach a browser bundle (the react
// zone) or leak into a contracts zone - each transitively pulls Drizzle/Hono/
// node-only code. `@oss/core/server` is the umbrella server subpath. See ADR-0025.
const RUNTIME_SPECIFIERS = ['@oss/core/server'];

function isRuntimeSpecifier(spec) {
  return RUNTIME_SPECIFIERS.some((b) => spec === b || spec.startsWith(b + '/'));
}

const blocked_by_contracts = ['@oss-addons', ...RUNTIME_SPECIFIERS];

// The contracts zone (@oss/core/contracts) and the react zone (@oss/core/react)
// are the browser-safe / isomorphic subpaths of @oss/core. Both must stay
// server-free so a browser bundle never pulls the node engine (@oss/core/server
// = Drizzle/Hono/node). See ADR-0025.
function isContractsZone(file) {
  return file.includes('packages/core/src/contracts');
}
function isReactZone(file) {
  return file.includes('packages/core/src/react');
}

const noContractsToRuntime = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!isContractsZone(file)) return;
        const spec = node.source.value;
        const blocked = blocked_by_contracts.some((b) => spec === b || spec.startsWith(b + '/'));
        if (blocked) {
          context.report({
            node,
            message:
              'The @oss/core/contracts zone is isomorphic - it must not import the engine ' +
              '(@oss/core/server) or an add-on. Keep it to contracts, base schemas, ports + zod. ' +
              'See AGENTS.md > Dependency rules / ADR-0025.',
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
// slice (the module's /contract dir, @oss/<module>/contracts) - the single source of truth that also emits
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
              "the module's contract slice (its /contract dir, exported as @oss/<module>/contracts) - " +
              'the source of truth for validation + OpenAPI + the typed client - and reference it. ' +
              'See clean-architecture.md.',
          });
        }
      },
    };
  },
};

// The react zone (@oss/core/react) is browser glue (createClient, provider, query
// hooks). Importing the node engine (@oss/core/server) or an add-on pulls
// Drizzle/Hono/node into the client bundle. Keep it domain-free + server-free.
// See ADR-0025.
const noReactToRuntime = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!isReactZone(file)) return;
        const spec = node.source.value;
        if (isRuntimeSpecifier(spec) || isAddonSpecifier(spec)) {
          context.report({
            node,
            message:
              'The @oss/core/react zone must not import the engine (@oss/core/server) or an ' +
              'add-on - it would pull Drizzle/Hono/node into the browser bundle. ' +
              'Keep client glue domain-free + server-free. See ADR-0025.',
          });
        }
      },
    };
  },
};

// --- intra-core domain isolation (post-fold, ADR-0025) ----------------------
// After the domains fold into @oss/core, a "domain" is any dir under
// packages/core/src/<name>/ that is NOT one of the engine zones below. The
// source-isolation invariant (ADR-0024/0025 rule 1: a domain never imports a
// sibling domain's internals) is now enforced INTRA-package by these string
// twins - the old whole-graph packages/domains/* rules went dead when that
// directory vanished. See AGENTS.md > Dependency rules.
const ENGINE_ZONES = ['contracts', 'server', 'react', 'scripts'];

// The domain a core file belongs to (null for engine zones / non-core files).
function coreDomainOf(file) {
  const m = file.match(/packages\/core\/src\/([a-z0-9-]+)\//);
  if (!m || ENGINE_ZONES.includes(m[1])) return null;
  return m[1];
}

// The target domain of an `@oss/core/<x>/...` specifier (null when <x> is an
// engine zone, or the bare `@oss/core/compliance` engine sealed-token util - the
// compliance DOMAIN is only reachable via subpaths like /contracts, /schema).
function coreDomainTarget(spec) {
  if (!spec.startsWith('@oss/core/')) return null;
  const tail = spec.slice('@oss/core/'.length).split('/').filter(Boolean);
  if (tail.length === 0 || ENGINE_ZONES.includes(tail[0])) return null;
  if (tail[0] === 'compliance' && tail.length === 1) return null;
  return { name: tail[0], isSchema: tail[1] === 'schema' };
}

const noCrossCoreDomain = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const self = coreDomainOf(filename(context));
        if (!self) return;
        const target = coreDomainTarget(node.source.value);
        if (!target || target.name === self) return;
        // The read-only /schema subpath is the one sanctioned cross-domain seam
        // (same carve-out as no-cross-addon). Everything else couples internals.
        if (target.isSchema) return;
        context.report({
          node,
          message:
            `A folded domain (packages/core/src/${self}) must not import a sibling domain ` +
            `(${node.source.value}). Couple only through a sibling's read-only /schema subpath, ` +
            'a command/adapter port, a domain event, or a shared contract via the composition ' +
            'root - never a direct internal import. This is the ADR-0024/0025 source-isolation ' +
            'invariant that keeps each domain extractable. See AGENTS.md > Dependency rules.',
        });
      },
    };
  },
};

const noEngineToDomain = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!/packages\/core\/src\/(contracts|server|react)\//.test(filename(context))) return;
        const target = coreDomainTarget(node.source.value);
        if (!target) return;
        context.report({
          node,
          message:
            `The @oss/core engine (contracts/server/react) must not import a domain ` +
            `(${node.source.value}). createApp is domain-agnostic (DI: the consumer injects ` +
            'PAM identity + the tenant resolver); a domain is wired in only through apps/* and ' +
            'the @oss/testing harness. See ADR-0024/0025.',
        });
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
    'no-react-to-runtime': noReactToRuntime,
    'no-deep-dist-import': noDeepDistImport,
    'no-cross-extension-import': noCrossExtensionImport,
    'no-adhoc-zod-in-router': noAdhocZodInRouter,
    'no-cross-core-domain': noCrossCoreDomain,
    'no-engine-to-domain': noEngineToDomain,
  },
};
