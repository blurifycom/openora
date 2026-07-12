// Deterministic module-structure + naming lint enforcement for oxlint (jsPlugins).
// Loaded via jsPlugins in .oxlintrc.json, same house pattern as oxlint-boundaries-plugin.mjs
// (string/path checks, no AST gymnastics, no import resolution). Scope: packages/core/src/**
// only, skipping the engine zones (contracts/server/react/scripts) - those are checked by
// tools/verify-module-shape.ts instead. See AGENTS.md > Where does X go? / db-conventions.
//
// Rules:
//   module-file-placement - every .ts file inside a folded domain must live in one of the
//     canonical layer dirs (schema, contract, service, router, adapters, react,
//     drizzle, __tests__, seed, moderation, shared) or be a sanctioned root file (index.ts,
//     plugin.ts, migrate.ts, drizzle.config.ts, or a surveyed root feature file such as
//     wallet's admin-reporting.ts). Stops new strays; does not force a mass move of the
//     current tree.
//   layer-file-naming - files directly in service/ end .service.ts (plus a short surveyed
//     allowlist of pre-existing exceptions); files in __tests__/ end .test.ts.
//   no-inline-pg-enum - pgEnum('name', [...]) with an inline array literal is an error;
//     values must come from a named tuple (see packages/core/src/wallet/schema/index.ts).
//   no-relative-zone-escape - a relative import that leaves its module root must instead use
//     the package's own public subpath (@openora/core/<domain>...). Module root = the
//     top-most dir under the domain that owns the file, reusing the same derivation as
//     module-file-placement: a single-slice domain (wallet, iam, ...) has rest[0] itself a
//     LAYER_DIR, so the whole domain is one module; a multi-slice domain (casino, engagement,
//     pam) nests a slice dir (casino/gaming) as the module, and a domain-root file (index.ts,
//     contracts.ts, server.ts, react.ts - anything with rest.length<=1) is the domain's own
//     composition root, so its module root is the whole domain too (it necessarily reaches
//     every slice to build the barrel - that's its job, not an escape). Escape-boundary
//     decision (surveyed against the current tree): a slice importing a SIBLING slice
//     relatively (eg pam/player-management reaching into pam/profile/schema) IS an escape -
//     the domain has a published schema/contract/plugin subpath per slice, use it. A slice
//     importing a domain-root-level shared dir (eg pam/shared, itself a LAYER_DIR sitting at
//     the domain root next to the slices) or a bare domain-root file is NOT an escape - it has
//     no public subpath of its own (not every domain-internal file is published) and is
//     legitimate domain-internal sharing. Reaching an engine zone (contracts/server/react) is
//     always an escape (each has a public subpath). Reaching common/ or testing/ is never an
//     escape - those are cross-cutting utility dirs, not folded domains, out of scope exactly
//     like they are for module-file-placement (no public subpath exists or is warranted).
//   no-reinfer-imported-schema - `z.infer<typeof X>` where X is imported from a
//     contract/contracts/schemas path, in a file that is not itself under a contract/ or
//     schemas/ dir. The type is already exported once from the owning contract; re-running
//     z.infer locally is a hand-rolled duplicate that silently drifts. Import the type instead.
//   no-bare-string-id-param - a service/router function or method param (or a member of an
//     inline object-literal param type) whose name ends `Id` and whose type is a bare
//     `string`. Type it through the owning contract/schema type (`X['id']`) or the shared
//     `Uuid` (`@openora/core/contracts`) - never a bare string. A short allowlist covers the
//     genuinely-external ids the conventions doc already carves out (eg a KYC vendor's own
//     reference id).
//   no-unbounded-db-fanout - `Promise.all(rows.map(fn))` over a query result in a service/router
//     file, where the fan-out opens one pool connection per row. Use mapConcurrent (bounded).
//   no-naive-timestamp - `timestamp()` in a schema file without { withTimezone: true } - drops
//     the zone; every datetime column is timestamptz (db-conventions).
//   no-float-money - `real()`/`doublePrecision()`/`float()` in a schema file - money is exact
//     decimal (ADR-0029); disable-with-note for a genuine non-money float.
//   drizzle-snake-case - a pgTable/pgEnum/index name, or an explicit column name, that is not
//     snake_case - drizzle derives snake_case columns from the camelCase key (db-conventions).
//   no-raw-z-uuid - `z.uuid()`/`z.string().uuid()` in core source - use the shared UuidSchema.
//   no-inline-z-enum-outside-contract - `z.enum([...])` inline outside a contract/schemas dir -
//     define the enum triple on the contract surface (single source of truth).

const ENGINE_ZONES = new Set(['contracts', 'server', 'react', 'scripts']);
// common/ and testing/ are cross-cutting utility dirs, not folded domains (no index.ts at
// their root, not checked by verify-module-shape.ts either) - out of scope here too.
const EXCLUDED_TOP_DIRS = new Set(['common', 'testing']);

const LAYER_DIRS = new Set([
  'schema',
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

const SERVICE_FILE_ALLOWLIST = new Set([
  'ports.ts',
  're-kyc-trigger.ts',
  'kyc-status-writer.ts',
  'rg-eval.ts',
  'tag-mappers.ts',
]);

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
        if (!segments || segments.length < 2) {
          return;
        }
        const [domain, ...rest] = segments;
        if (ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) {
          return;
        }

        if (rest.length === 1) {
          if (!ROOT_ALLOWED_FILES.has(rest[0])) {
            context.report({
              node,
              message:
                `${rest[0]} sits at the packages/core/src/${domain} root but isn't a ` +
                'sanctioned root file (index.ts, plugin.ts, migrate.ts, drizzle.config.ts, ' +
                'contracts.ts, server.ts, react.ts, or a surveyed feature file). Move it into ' +
                'a canonical layer dir (schema/, contract/, service/, router/, ' +
                'adapters/, react/, drizzle/, __tests__/, seed/).',
            });
          }
          return;
        }

        if (LAYER_DIRS.has(rest[0])) {
          return;
        }

        if (rest.length === 2) {
          if (!ROOT_ALLOWED_FILES.has(rest[1])) {
            context.report({
              node,
              message:
                `${rest[1]} sits at the packages/core/src/${domain}/${rest[0]} module root but ` +
                "isn't a sanctioned root file. Move it into a canonical layer dir (schema/, " +
                'contract/, service/, router/, adapters/, react/, drizzle/, __tests__/).',
            });
          }
          return;
        }

        if (LAYER_DIRS.has(rest[1])) {
          return;
        }

        context.report({
          node,
          message:
            `packages/core/src/${domain}/${rest[0]}/${rest[1]} is not a canonical layer dir ` +
            '(schema, contract, service, router, adapters, react, drizzle, __tests__, ' +
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
        if (!segments || segments.length < 2) {
          return;
        }
        const [domain, ...rest] = segments;
        if (ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) {
          return;
        }

        const layerIdx = LAYER_DIRS.has(rest[0])
          ? 0
          : rest.length >= 2 && LAYER_DIRS.has(rest[1])
            ? 1
            : -1;
        if (layerIdx === -1) {
          return;
        }
        const layer = rest[layerIdx];
        // Only enforce naming on files directly inside the layer dir, not nested subfolders
        // (adapters/mock/*, seed/data/* stay free-form - the layer dirs with a naming rule
        // are service/ and __tests__/, neither of which has nested subfolders today).
        if (rest.length !== layerIdx + 2) {
          return;
        }
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

// Resolves a relative import specifier against the importing file's dir, both expressed as
// packages/core/src/-relative segment arrays. Returns null if the relative path climbs above
// packages/core/src itself (not expected in the current tree).
function resolveRelativeSegments(fileSegments, spec) {
  const stack = fileSegments.slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack : null;
}

// Module root for a file/target's segments - mirrors module-file-placement's shape derivation
// (see the no-relative-zone-escape header note above).
function moduleRootOf(segments) {
  const [domain, ...rest] = segments;
  if (!domain || ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) {
    return null;
  }
  if (rest.length <= 1 || LAYER_DIRS.has(rest[0])) {
    return [domain];
  }
  return [domain, rest[0]];
}

function checkRelativeZoneEscape(context, segments, domain, mRoot, node, source) {
  if (!source || !source.startsWith('.')) {
    return;
  }
  const targetSegments = resolveRelativeSegments(segments, source);
  if (!targetSegments) {
    return;
  }
  const targetDomain = targetSegments[0];

  if (targetDomain !== domain) {
    if (EXCLUDED_TOP_DIRS.has(targetDomain)) {
      return;
    }
    context.report({
      node,
      message:
        `'${source}' escapes packages/core/src/${domain} into ${targetDomain}. Import from the ` +
        `package's own public subpath (eg @openora/core/${targetDomain}) instead of a relative path.`,
    });
    return;
  }

  if (mRoot.length === 1) {
    return;
  }
  const tRoot = moduleRootOf(targetSegments) ?? [domain];
  if (tRoot.join('/') === mRoot.join('/')) {
    return;
  }

  const targetRest = targetSegments.slice(1);
  if (LAYER_DIRS.has(targetRest[0])) {
    return;
  }
  // A single extension-bearing segment is a domain-root file (index.js, server.js,
  // contracts.js) - legit composition reach. A single extensionless segment is a bare
  // sibling-slice directory barrel (../../lobby) - an escape, so don't exempt it.
  if (targetRest.length === 1 && targetRest[0].includes('.')) {
    return;
  }

  const targetSlice = `${domain}/${targetRest[0]}`;
  context.report({
    node,
    message:
      `'${source}' escapes the packages/core/src/${mRoot.join('/')} module into the sibling ` +
      `slice packages/core/src/${targetSlice}. Import from that slice's public subpath ` +
      `(eg @openora/core/${domain}/schema/${targetRest[0]}) instead of a relative path.`,
  });
}

const noRelativeZoneEscape = {
  create(context) {
    const segments = coreSrcSegments(filename(context));
    if (!segments || segments.length < 2) {
      return {};
    }
    const [domain] = segments;
    // scripts + common + testing are exempt (build/cross-cutting; no zone discipline). Engine
    // zones (contracts/server/react) ARE checked now: their module root is the whole zone, so
    // an intra-zone import (server/kernel -> server/db) passes the mRoot.length===1 short-circuit
    // while a cross-zone one (server -> contracts) is flagged -> use @openora/core/contracts.
    if (EXCLUDED_TOP_DIRS.has(domain) || domain === 'scripts') {
      return {};
    }
    const mRoot = ENGINE_ZONES.has(domain) ? [domain] : moduleRootOf(segments);
    if (!mRoot) {
      return {};
    }
    const visit = (node) =>
      checkRelativeZoneEscape(context, segments, domain, mRoot, node, node.source?.value);
    return {
      ImportDeclaration: visit,
      ExportNamedDeclaration: visit,
      ExportAllDeclaration: visit,
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
        if (!isPgEnumCall(node)) {
          return;
        }
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

// A per-module contract/ dir (contract/, contracts/) or a base-schemas dir (schemas/) - the
// zones that OWN a wire shape and are allowed to z.infer it directly.
function isContractOrSchemaZone(file) {
  return /\/(contract|contracts|schemas)\//.test(file);
}

// An import specifier reaching a contract/contracts/schemas path, subpath or relative.
function isContractSchemaSpecifier(spec) {
  return /(^|\/)(contract|contracts|schemas)(\/|$)/.test(spec);
}

function isZInferTypeName(typeName) {
  return (
    typeName?.type === 'TSQualifiedName' &&
    typeName.left?.type === 'Identifier' &&
    typeName.left.name === 'z' &&
    typeName.right?.type === 'Identifier' &&
    typeName.right.name === 'infer'
  );
}

const noReinferImportedSchema = {
  create(context) {
    if (isContractOrSchemaZone(filename(context))) {
      return {};
    }
    // Populated by ImportDeclaration below, read by TSTypeReference - imports sit above their
    // use in source order, so this fills in before a same-file z.infer<typeof X> is visited.
    const importedFrom = new Map();
    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== 'string' || !isContractSchemaSpecifier(source)) {
          return;
        }
        for (const spec of node.specifiers ?? []) {
          if (spec.type === 'ImportSpecifier' || spec.type === 'ImportDefaultSpecifier') {
            importedFrom.set(spec.local.name, source);
          }
        }
      },
      TSTypeReference(node) {
        if (!isZInferTypeName(node.typeName)) {
          return;
        }
        const arg = node.typeArguments?.params?.[0];
        if (arg?.type !== 'TSTypeQuery' || arg.exprName?.type !== 'Identifier') {
          return;
        }
        const schemaName = arg.exprName.name;
        const source = importedFrom.get(schemaName);
        if (!source) {
          return;
        }
        context.report({
          node,
          message:
            `z.infer<typeof ${schemaName}> re-infers a type already exported from '${source}'. ` +
            'Import the type from the owning contract instead of re-inferring it here ' +
            `(eg import type { ${schemaName.replace(/Schema$/, '')} } from '${source}').`,
        });
      },
    };
  },
};

function isServiceOrRouterFile(file) {
  const segments = coreSrcSegments(file);
  if (!segments) {
    return false;
  }
  const [domain, ...rest] = segments;
  if (ENGINE_ZONES.has(domain) || EXCLUDED_TOP_DIRS.has(domain)) {
    return false;
  }
  return rest.includes('service') || rest.includes('router');
}

// Ids whose value is owned by a third party, not this platform - carved out by name in
// conventions.md section 3 (the audit contract's correlationId note). Extend this list only
// for another surveyed external id, not speculatively.
const EXTERNAL_ID_PARAM_NAMES = new Set(['referenceId']);

function isBareStringType(typeAnnotation) {
  return typeAnnotation?.type === 'TSStringKeyword';
}

function reportBareStringId(context, name, node) {
  context.report({
    node,
    message:
      `'${name}' is a bare string id param. Type it through the owning contract/schema type ` +
      `(eg X['id']) or the shared Uuid type (@openora/core/contracts) - never a bare string.`,
  });
}

function checkIdParam(context, name, typeAnnotation, node) {
  if (!name.endsWith('Id') || EXTERNAL_ID_PARAM_NAMES.has(name)) {
    return;
  }
  if (isBareStringType(typeAnnotation)) {
    reportBareStringId(context, name, node);
  }
}

// Only descends one level into an inline object-literal param type (the named-object-param
// convention's shape) - a param referencing a named type alias is out of scope, same as the
// rule never reaches into a function's return type.
function checkParams(context, params) {
  for (const param of params) {
    const paramType = param.typeAnnotation?.typeAnnotation;
    if (param.type === 'Identifier') {
      checkIdParam(context, param.name, paramType, param);
    }
    if (paramType?.type !== 'TSTypeLiteral') {
      continue;
    }
    for (const member of paramType.members) {
      if (member.type !== 'TSPropertySignature' || member.key?.type !== 'Identifier') {
        continue;
      }
      checkIdParam(context, member.key.name, member.typeAnnotation?.typeAnnotation, member);
    }
  }
}

const noBareStringIdParam = {
  create(context) {
    if (!isServiceOrRouterFile(filename(context))) {
      return {};
    }
    const visit = (node) => checkParams(context, node.params);
    return {
      FunctionDeclaration: visit,
      FunctionExpression: visit,
      ArrowFunctionExpression: visit,
    };
  },
};

function isPromiseAllCallee(callee) {
  return (
    callee?.type === 'MemberExpression' &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'Promise' &&
    callee.property?.type === 'Identifier' &&
    (callee.property.name === 'all' || callee.property.name === 'allSettled')
  );
}

// A `.map()`/`.flatMap()` call whose receiver is NOT an array literal - ie a collection of
// unknown size (a query result). `Promise.all([a, b].map(...))` over a literal is a fixed,
// bounded fan-out and is left alone.
function isUnboundedMapCall(node) {
  if (node?.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') {
    return false;
  }
  const { property, object } = node.callee;
  if (property?.type !== 'Identifier' || (property.name !== 'map' && property.name !== 'flatMap')) {
    return false;
  }
  return object?.type !== 'ArrayExpression';
}

const noUnboundedDbFanout = {
  create(context) {
    if (!isServiceOrRouterFile(filename(context))) {
      return {};
    }
    return {
      CallExpression(node) {
        if (!isPromiseAllCallee(node.callee) || !isUnboundedMapCall(node.arguments?.[0])) {
          return;
        }
        context.report({
          node,
          message:
            'Promise.all over a mapped query result fans out one DB connection per row and ' +
            'exhausts the pool at scale. Use mapConcurrent(items, limit, fn) from ' +
            '@openora/core/server, or oxlint-disable this line with a note if the collection ' +
            'is provably bounded (eg a fixed worker set).',
        });
      },
    };
  },
};

// A drizzle schema file - tables live in a `schema/` dir (folded domains) or a `schema.ts`
// leaf (eg server/db/outbox). The contracts `schemas/` dir (plural) holds ZOD schemas, not
// drizzle tables, so it is explicitly out of scope.
function isDrizzleSchemaFile(file) {
  const segments = coreSrcSegments(file);
  if (!segments || segments.includes('schemas')) {
    return false;
  }
  return segments.includes('schema') || segments.at(-1) === 'schema.ts';
}

function stringLiteralValue(node) {
  return node && typeof node.value === 'string' ? node.value : null;
}

function isIdentifierCallee(node, name) {
  return node.callee?.type === 'Identifier' && node.callee.name === name;
}

const noNaiveTimestamp = {
  create(context) {
    if (!isDrizzleSchemaFile(filename(context))) {
      return {};
    }
    return {
      CallExpression(node) {
        if (!isIdentifierCallee(node, 'timestamp')) {
          return;
        }
        const hasTz = node.arguments?.some(
          (arg) =>
            arg?.type === 'ObjectExpression' &&
            arg.properties?.some(
              (p) =>
                p.type === 'Property' &&
                p.key?.type === 'Identifier' &&
                p.key.name === 'withTimezone' &&
                p.value?.type === 'Literal' &&
                p.value.value === true,
            ),
        );
        if (!hasTz) {
          context.report({
            node,
            message:
              'timestamp() without { withTimezone: true } stores a naive datetime and drops the ' +
              'zone. Every *At column is timestamptz - use timestamp({ withTimezone: true }).',
          });
        }
      },
    };
  },
};

const FLOAT_COLUMN_BUILDERS = new Set(['real', 'doublePrecision', 'float']);

const noFloatMoney = {
  create(context) {
    if (!isDrizzleSchemaFile(filename(context))) {
      return {};
    }
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || !FLOAT_COLUMN_BUILDERS.has(node.callee.name)) {
          return;
        }
        context.report({
          node,
          message:
            `${node.callee.name}() is IEEE float - money must be exact decimal (ADR-0029). ` +
            'Use decimal({ precision: 18, scale: 2 }) with a currency column. For a genuine ' +
            'non-money float, oxlint-disable this line with a note.',
        });
      },
    };
  },
};

const DRIZZLE_NAME_DECLARERS = new Set([
  'pgTable',
  'pgEnum',
  'index',
  'uniqueIndex',
  'foreignKey',
  'primaryKey',
  'unique',
]);
const DRIZZLE_COLUMN_BUILDERS = new Set([
  'uuid',
  'text',
  'varchar',
  'char',
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'boolean',
  'timestamp',
  'date',
  'time',
  'interval',
  'decimal',
  'numeric',
  'real',
  'doublePrecision',
  'json',
  'jsonb',
  'inet',
]);

function isSnakeCase(value) {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

const drizzleSnakeCase = {
  create(context) {
    if (!isDrizzleSchemaFile(filename(context))) {
      return {};
    }
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier') {
          return;
        }
        const name = node.callee.name;
        const literal = stringLiteralValue(node.arguments?.[0]);
        // Column builders take an OPTIONAL explicit name; when present it must be snake_case
        // (drizzle derives it from the camelCase key via casing:'snake_case', so a camelCase
        // literal produces a camelCase SQL column). Name-declarers always take a name string.
        const isDeclarer = DRIZZLE_NAME_DECLARERS.has(name);
        if (!isDeclarer && !DRIZZLE_COLUMN_BUILDERS.has(name)) {
          return;
        }
        if (literal === null || isSnakeCase(literal)) {
          return;
        }
        context.report({
          node,
          message: `'${literal}' is not snake_case. Drizzle SQL identifiers (${
            isDeclarer ? 'table/enum/index names' : 'columns'
          }) are snake_case - ${
            isDeclarer
              ? 'name it in snake_case'
              : "drop the explicit name and let casing:'snake_case' derive it from the key"
          }.`,
        });
      },
    };
  },
};

// Walk a member-call chain (z.string().uuid()) back to its root identifier.
function rootIdentifierName(node) {
  let current = node;
  while (current) {
    if (current.type === 'Identifier') {
      return current.name;
    }
    if (current.type === 'CallExpression') {
      current = current.callee;
    } else if (current.type === 'MemberExpression') {
      current = current.object;
    } else {
      return null;
    }
  }
  return null;
}

const noRawZUuid = {
  create(context) {
    const file = filename(context);
    // Scope to the platform's own source; the one sanctioned definition is the shared schema.
    if (!coreSrcSegments(file) || file.endsWith('contracts/schemas/common.ts')) {
      return {};
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type !== 'MemberExpression' ||
          callee.property?.type !== 'Identifier' ||
          callee.property.name !== 'uuid' ||
          rootIdentifierName(callee.object) !== 'z'
        ) {
          return;
        }
        context.report({
          node,
          message:
            'Use UuidSchema (@openora/core/contracts) instead of z.uuid()/z.string().uuid() - ' +
            'a single source of truth for the uuid shape across contracts.',
        });
      },
    };
  },
};

const noInlineZEnumOutsideContract = {
  create(context) {
    const file = filename(context);
    if (!coreSrcSegments(file) || isContractOrSchemaZone(file)) {
      return {};
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type !== 'MemberExpression' ||
          callee.object?.type !== 'Identifier' ||
          callee.object.name !== 'z' ||
          callee.property?.type !== 'Identifier' ||
          callee.property.name !== 'enum' ||
          node.arguments?.[0]?.type !== 'ArrayExpression'
        ) {
          return;
        }
        context.report({
          node,
          message:
            'Inline z.enum([...]) duplicates a value set. Define the enum triple (values tuple + ' +
            'z.enum(tuple) + inferred type) on the contract surface and import it - single source ' +
            'of truth for enums (see conventions section 3).',
        });
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
    'no-relative-zone-escape': noRelativeZoneEscape,
    'no-reinfer-imported-schema': noReinferImportedSchema,
    'no-bare-string-id-param': noBareStringIdParam,
    'no-unbounded-db-fanout': noUnboundedDbFanout,
    'no-naive-timestamp': noNaiveTimestamp,
    'no-float-money': noFloatMoney,
    'drizzle-snake-case': drizzleSnakeCase,
    'no-raw-z-uuid': noRawZUuid,
    'no-inline-z-enum-outside-contract': noInlineZEnumOutsideContract,
  },
};
