// Structural validation for a UI plugin descriptor. The platform is headless: the
// page/block SDK layer (and its `SLOTS` contract) was removed (2026-06-09) and will
// be re-extracted from the downstream frontend. Until then this kit validates the
// structural invariants every UI plugin must hold regardless of the slot catalog -
// non-empty id, unique slot ids, unique column keys, present render functions. A
// host that owns a slot catalog can layer a name-allow-list check on top.

// Minimal structural shape of a UI plugin descriptor. Kept local so the kit has no
// dependency on the (removed) page/block SDK layer.
export type UIPluginSlot = {
  id: string;
  name: string;
  render?: unknown;
};

export type UIPluginColumn = {
  name: string;
  key: string;
};

export type UIPlugin = {
  id: string;
  slots?: UIPluginSlot[];
  columns?: UIPluginColumn[];
};

export type ValidationIssue = {
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

/**
 * Static-validate a UI plugin descriptor's structural invariants.
 * Checks:
 *  - a non-empty string `id`
 *  - slot ids are unique within the plugin
 *  - column keys are unique per slot within the plugin
 *  - render functions are present (a slot contributor must render something)
 *
 * Operators run this in their own test suite (eg `validatePlugin(myPlugin)`
 * inside vitest) to catch contract drift before runtime.
 */
export function validatePlugin(plugin: UIPlugin): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!plugin.id || typeof plugin.id !== 'string') {
    issues.push({
      severity: 'error',
      path: 'id',
      message: 'Plugin must declare a non-empty string `id`.',
    });
  }

  const slotIds = new Set<string>();
  for (const [i, s] of (plugin.slots ?? []).entries()) {
    if (slotIds.has(s.id)) {
      issues.push({
        severity: 'error',
        path: `slots[${i}].id`,
        message: `Duplicate slot id "${s.id}" within plugin "${plugin.id}".`,
      });
    }
    slotIds.add(s.id);
    if (typeof s.render !== 'function') {
      issues.push({
        severity: 'error',
        path: `slots[${i}].render`,
        message: `Missing render function for slot "${s.id}".`,
      });
    }
  }

  const columnIds = new Set<string>();
  for (const [i, c] of (plugin.columns ?? []).entries()) {
    const ck = `${c.name}::${c.key}`;
    if (columnIds.has(ck)) {
      issues.push({
        severity: 'error',
        path: `columns[${i}]`,
        message: `Duplicate column key "${c.key}" for slot "${c.name}" within plugin "${plugin.id}".`,
      });
    }
    columnIds.add(ck);
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

/** Throws if validation fails - convenience wrapper for inline test assertions. */
export function assertValidPlugin(plugin: UIPlugin): void {
  const r = validatePlugin(plugin);
  if (!r.ok) {
    const msg = r.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  - ${i.path}: ${i.message}`)
      .join('\n');
    throw new Error(`[plugin-test-kit] validatePlugin failed for "${plugin.id}":\n${msg}`);
  }
}
