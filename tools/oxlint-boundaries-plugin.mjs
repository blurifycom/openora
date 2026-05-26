// Architectural boundary enforcement for oxlint (replaces eslint-plugin-boundaries).
// Loaded via jsPlugins in .oxlintrc.json. API is ESLint v9-compatible.
//
// Rules mirror the four enforced classes in AGENTS.md > Dependency rules:
//   no-cross-module-import  - modules must not import another module's code (schema subpath ok)
//   no-platform-to-module   - platform/* (except api-runtime) must not import modules or UI
//   no-contracts-to-runtime - contracts/* may import only other contracts and zod
//   no-deep-dist-import     - never @oss/*/dist/** deep paths

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

const noPlatformToModule = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const file = filename(context);
        if (!inPath(file, 'packages/platform')) return;
        // api-runtime is the composition root - it may import everything
        if (inPath(file, 'packages/platform/api-runtime')) return;
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
  '@oss/plugin-host', '@oss/api-runtime', '@oss/sdk-core', '@oss/react-sdk',
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

export default {
  meta: { name: 'oss-boundaries' },
  rules: {
    'no-cross-module-import': noCrossModuleImport,
    'no-platform-to-module': noPlatformToModule,
    'no-contracts-to-runtime': noContractsToRuntime,
    'no-deep-dist-import': noDeepDistImport,
  },
};
