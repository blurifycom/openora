// Architectural boundary enforcement for oxlint (replaces eslint-plugin-boundaries).
// Loaded via jsPlugins in .oxlintrc.json. API is ESLint v9-compatible.
//
// Why a hand-written plugin and not eslint-plugin-boundaries:
//   eslint-plugin-boundaries enforces nothing unless every @openora/* import resolves to
//   a file - which means a native import resolver (unrs-resolver) plus a maintained
//   lint-only tsconfig mapping all ~24 @openora/* packages to src (pnpm otherwise
//   resolves them to dist and misclassifies elements). This plugin matches specifier
//   strings directly: zero deps, zero resolution, fast. See ADR-0015.
//
// Each rule scopes itself once per file in create() and returns {} when the file is out of
// scope, so out-of-scope files register zero visitors. Specifier rules also cover re-export
// laundering (export ... from / export * from), not just ImportDeclaration.

function filename(context) {
  return (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
}

function inPath(file, segment) {
  return file.includes('/' + segment + '/');
}

// Visits every node that carries an import/re-export source specifier.
function sourceVisitors(check) {
  const visit = (node) => {
    const spec = node.source?.value;
    if (typeof spec === 'string') {
      check(node, spec);
    }
  };
  return {
    ImportDeclaration: visit,
    ExportNamedDeclaration: visit,
    ExportAllDeclaration: visit,
  };
}

const RUNTIME_SPECIFIERS = ['@openora/core/server'];

function isRuntimeSpecifier(spec) {
  return RUNTIME_SPECIFIERS.some((b) => spec === b || spec.startsWith(b + '/'));
}

function isContractsZone(file) {
  return file.includes('packages/core/src/contracts');
}
function isReactZone(file) {
  return file.includes('packages/core/src/react');
}

const noContractsToRuntime = {
  create(context) {
    if (!isContractsZone(filename(context))) {
      return {};
    }
    return sourceVisitors((node, spec) => {
      const blocked = isRuntimeSpecifier(spec);
      if (!blocked) {
        return;
      }
      context.report({
        node,
        message:
          'The @openora/core/contracts zone is isomorphic - it must not import the engine ' +
          '(@openora/core/server). Keep it to contracts, base schemas, ports + zod. ' +
          'See AGENTS.md > Dependency rules / ADR-0025.',
      });
    });
  },
};

// A per-module contract/ dir under a folded domain (NOT the engine contracts/ zone, which
// is covered by no-contracts-to-runtime). Matches src/<domain>/contract/ and the multi-slice
// src/<domain>/<slice>/contract/.
function isModuleContractZone(file) {
  return /packages\/core\/src\/(?!contracts\/)[^/]+\/(?:[^/]+\/)?contract\//.test(file);
}

const CONTRACT_RUNTIME_SPECIFIERS = ['@openora/core/server', 'drizzle-orm'];

// The public root barrel (@openora/core/<domain>) re-exports the module's contract/, so the
// contract MUST stay isomorphic (browser-safe) - no engine, no Drizzle, no /schema
// (schema pulls Drizzle transitively). Zod + @openora/core/contracts are fine.
const noModuleContractToRuntime = {
  create(context) {
    if (!isModuleContractZone(filename(context))) {
      return {};
    }
    return sourceVisitors((node, spec) => {
      const blocked =
        CONTRACT_RUNTIME_SPECIFIERS.some((b) => spec === b || spec.startsWith(b + '/')) ||
        /(^|\/)schema(\/|$)/.test(spec) ||
        spec.startsWith('node:');
      if (!blocked) {
        return;
      }
      context.report({
        node,
        message:
          `A module contract/ dir is isomorphic - it is re-exported by the public root barrel ` +
          `(@openora/core/<domain>), so it must not import the engine (@openora/core/server), ` +
          `Drizzle, a /schema subpath, or node built-ins (${spec}). Keep it to Zod + ` +
          `@openora/core/contracts. See AGENTS.md > Dependency rules / ADR-0025.`,
      });
    });
  },
};

const noDeepDistImport = {
  create(context) {
    return sourceVisitors((node, spec) => {
      if (/^@openora\/.+\/dist(\/|$)/.test(spec)) {
        context.report({
          node,
          message:
            'Never import a deep dist/ path. Use the package entry instead ' +
            '(e.g. @openora/core/wallet/schema).',
        });
      }
    });
  },
};

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

function isRouterFile(file) {
  return inPath(file, 'src/router') || /packages\/core\/src\/.+\/router\//.test(file);
}

const noAdhocZodInRouter = {
  create(context) {
    if (!isRouterFile(filename(context))) {
      return {};
    }
    return {
      CallExpression(node) {
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
              "the module's contract slice (its /contract dir, exported as @openora/<module>/contracts) - " +
              'the source of truth for validation + OpenAPI + the typed client - and reference it. ' +
              'See docs/standards/module-structure.md.',
          });
        }
      },
    };
  },
};

const noReactToRuntime = {
  create(context) {
    if (!isReactZone(filename(context))) {
      return {};
    }
    return sourceVisitors((node, spec) => {
      if (!isRuntimeSpecifier(spec)) {
        return;
      }
      context.report({
        node,
        message:
          'The @openora/core/react zone must not import the engine (@openora/core/server) - ' +
          'it would pull Drizzle/Hono/node into the browser bundle. ' +
          'Keep client glue domain-free + server-free. See ADR-0025.',
      });
    });
  },
};

// Intra-core domain isolation (post-fold, ADR-0025): a domain is any dir under
// packages/core/src/<name>/ that is NOT one of the engine zones. Source-isolation
// invariant (ADR-0024/0025): a domain never imports a sibling domain's internals.
const ENGINE_ZONES = ['contracts', 'server', 'react', 'scripts'];
// common/ and testing/ are cross-cutting shared zones, not folded domains - any zone may
// import them (matches dependency-cruiser's no-cross-domain, which excludes common/). So
// they are neither a domain-of nor a cross-domain target.
const SHARED_ZONES = [...ENGINE_ZONES, 'common', 'testing'];

function coreDomainOf(file) {
  const m = file.match(/packages\/core\/src\/([a-z0-9-]+)\//);
  if (!m || SHARED_ZONES.includes(m[1])) {
    return null;
  }
  return m[1];
}

// The bare `@openora/core/compliance` (sealed-token util) is an engine zone; the
// compliance DOMAIN is only reachable via subpaths like /contracts, /schema.
function coreDomainTarget(spec) {
  if (!spec.startsWith('@openora/core/')) {
    return null;
  }
  const tail = spec.slice('@openora/core/'.length).split('/').filter(Boolean);
  if (tail.length === 0 || SHARED_ZONES.includes(tail[0])) {
    return null;
  }
  if (tail[0] === 'compliance' && tail.length === 1) {
    return null;
  }
  return { name: tail[0], isSchema: tail[1] === 'schema' };
}

const noCrossCoreDomain = {
  create(context) {
    const self = coreDomainOf(filename(context));
    if (!self) {
      return {};
    }
    return sourceVisitors((node, spec) => {
      const target = coreDomainTarget(spec);
      if (!target || target.name === self) {
        return;
      }
      if (target.isSchema) {
        return;
      }
      context.report({
        node,
        message:
          `A folded domain (packages/core/src/${self}) must not import a sibling domain ` +
          `(${spec}). Couple only through a sibling's read-only /schema subpath, ` +
          'a command/adapter port, a domain event, or a shared contract via the composition ' +
          'root - never a direct internal import. This is the ADR-0024/0025 source-isolation ' +
          'invariant that keeps each domain extractable. See AGENTS.md > Dependency rules.',
      });
    });
  },
};

const noEngineToDomain = {
  create(context) {
    if (!/packages\/core\/src\/(contracts|server|react)\//.test(filename(context))) {
      return {};
    }
    return sourceVisitors((node, spec) => {
      const target = coreDomainTarget(spec);
      if (!target) {
        return;
      }
      context.report({
        node,
        message:
          `The @openora/core engine (contracts/server/react) must not import a domain ` +
          `(${spec}). createApp is domain-agnostic (DI: the consumer injects ` +
          "PAM identity + the tenant resolver); a domain is wired in only through the consumer's " +
          'app and the @openora/testing harness. See ADR-0024/0025.',
      });
    });
  },
};

// Whole-graph rule catches transitive/dynamic edges. See ADR-0021/0025.
export default {
  meta: { name: 'oss-boundaries' },
  rules: {
    'no-contracts-to-runtime': noContractsToRuntime,
    'no-module-contract-to-runtime': noModuleContractToRuntime,
    'no-react-to-runtime': noReactToRuntime,
    'no-deep-dist-import': noDeepDistImport,

    'no-adhoc-zod-in-router': noAdhocZodInRouter,
    'no-cross-core-domain': noCrossCoreDomain,
    'no-engine-to-domain': noEngineToDomain,
  },
};
