// Architectural boundary enforcement for oxlint (replaces eslint-plugin-boundaries).
// Loaded via jsPlugins in .oxlintrc.json. API is ESLint v9-compatible.
//
// Why a hand-written plugin and not eslint-plugin-boundaries:
//   eslint-plugin-boundaries enforces nothing unless every @blurifycom/* import resolves to
//   a file - which means a native import resolver (unrs-resolver) plus a maintained
//   lint-only tsconfig mapping all ~24 @blurifycom/* packages to src (pnpm otherwise
//   resolves them to dist and misclassifies elements). This plugin matches specifier
//   strings directly: zero deps, zero resolution, fast. See ADR-0015.

function filename(context) {
  return (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
}

function inPath(file, segment) {
  return file.includes('/' + segment + '/') || file.includes('/' + segment);
}

function isCoreFile(file) {
  return inPath(file, 'packages/core');
}

function isAddonSpecifier(spec) {
  return spec === '@blurifycom-addons' || spec.startsWith('@blurifycom-addons/');
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
            'The published core (@blurifycom/core) must not import an add-on package (@blurifycom-addons/*). ' +
            'Add-on is wired in only by the composition roots under apps/* ' +
            '(extensions.config.ts + the editions contract merge) and the @blurifycom/testing harness. ' +
            'This keeps add-on packages extractable. See ADR-0021/0025.',
        });
      },
    };
  },
};

function importingAddon(file) {
  const m = file.match(/packages\/addons\/([a-z0-9-]+)\//);
  return m ? m[1] : null;
}

function addonImportTarget(spec) {
  if (!spec.startsWith('@blurifycom-addons/')) return null;
  const tail = spec.slice('@blurifycom-addons/'.length).split('/').filter(Boolean);
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
        if (target.isSchemaSubpath) return;
        context.report({
          node,
          message:
            `An add-on package must not import another add-on package (${node.source.value}). ` +
            'Import a sibling only through its read-only /schema subpath ' +
            '(@blurifycom-addons/<name>/schema); communicate otherwise via events or a command port. ' +
            'See ADR-0020.',
        });
      },
    };
  },
};

const RUNTIME_SPECIFIERS = ['@blurifycom/core/server'];

function isRuntimeSpecifier(spec) {
  return RUNTIME_SPECIFIERS.some((b) => spec === b || spec.startsWith(b + '/'));
}

const blocked_by_contracts = ['@blurifycom-addons', ...RUNTIME_SPECIFIERS];

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
              'The @blurifycom/core/contracts zone is isomorphic - it must not import the engine ' +
              '(@blurifycom/core/server) or an add-on. Keep it to contracts, base schemas, ports + zod. ' +
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
        if (/^@blurifycom\/[^/]+\/dist\/|^@blurifycom\/.+\/dist\//.test(spec)) {
          context.report({
            node,
            message:
              'Never import a deep dist/ path. Use the package entry instead ' +
              '(e.g. @blurifycom-addons/wallet/schema).',
          });
        }
      },
    };
  },
};

const noCrossExtensionImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        const m = file.match(/apps\/api\/src\/extensions\/([^/]+)\//);
        if (!m) return;
        const ownExt = m[1];
        const spec = node.source.value;
        if (!spec.startsWith('.')) return;
        const segments = spec.split('/').filter(Boolean);
        let i = 0;
        while (i < segments.length && segments[i] === '..') i++;
        if (i === 0) return;
        const target = segments[i];
        if (!target) return;
        if (target !== ownExt && target !== 'extensions' && target.length > 0) {
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
              "the module's contract slice (its /contract dir, exported as @blurifycom/<module>/contracts) - " +
              'the source of truth for validation + OpenAPI + the typed client - and reference it. ' +
              'See clean-architecture.md.',
          });
        }
      },
    };
  },
};

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
              'The @blurifycom/core/react zone must not import the engine (@blurifycom/core/server) or an ' +
              'add-on - it would pull Drizzle/Hono/node into the browser bundle. ' +
              'Keep client glue domain-free + server-free. See ADR-0025.',
          });
        }
      },
    };
  },
};

// Intra-core domain isolation (post-fold, ADR-0025): a domain is any dir under
// packages/core/src/<name>/ that is NOT one of the engine zones. Source-isolation
// invariant (ADR-0024/0025): a domain never imports a sibling domain's internals.
const ENGINE_ZONES = ['contracts', 'server', 'react', 'scripts'];

function coreDomainOf(file) {
  const m = file.match(/packages\/core\/src\/([a-z0-9-]+)\//);
  if (!m || ENGINE_ZONES.includes(m[1])) return null;
  return m[1];
}

// The bare `@blurifycom/core/compliance` (sealed-token util) is an engine zone; the
// compliance DOMAIN is only reachable via subpaths like /contracts, /schema.
function coreDomainTarget(spec) {
  if (!spec.startsWith('@blurifycom/core/')) return null;
  const tail = spec.slice('@blurifycom/core/'.length).split('/').filter(Boolean);
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
            `The @blurifycom/core engine (contracts/server/react) must not import a domain ` +
            `(${node.source.value}). createApp is domain-agnostic (DI: the consumer injects ` +
            'PAM identity + the tenant resolver); a domain is wired in only through apps/* and ' +
            'the @blurifycom/testing harness. See ADR-0024/0025.',
        });
      },
    };
  },
};

// Whole-graph rule catches transitive/dynamic edges. See ADR-0021/0025.
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
