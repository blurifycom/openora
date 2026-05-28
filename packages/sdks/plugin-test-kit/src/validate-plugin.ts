import type { UIPlugin } from '@oss/react-pages';
import { SLOTS, type SlotName, type ColumnSlotName } from '@oss/react-pages';

const KNOWN_SLOT_NAMES = new Set<string>(flattenSlotNames(SLOTS));

function flattenSlotNames(obj: unknown, acc: string[] = []): string[] {
  if (typeof obj === 'string') {
    acc.push(obj);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      flattenSlotNames(v, acc);
    }
  }
  return acc;
}

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
 * Static-validate a UI plugin descriptor against the OSS slot contract.
 * Checks:
 *  - declared slot names exist in `SLOTS`
 *  - declared column slot names exist in `SLOTS`
 *  - slot/column ids are unique within the plugin
 *  - render functions are present (warn if a slot contributor forgot one)
 *  - no slot fill targets a sealed token (sealed services are not slots)
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
    if (!KNOWN_SLOT_NAMES.has(s.name as SlotName | ColumnSlotName)) {
      issues.push({
        severity: 'error',
        path: `slots[${i}].name`,
        message: `Unknown slot name "${s.name}". Use a value from SLOTS.`,
      });
    }
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
    if (!KNOWN_SLOT_NAMES.has(c.name as SlotName | ColumnSlotName)) {
      issues.push({
        severity: 'error',
        path: `columns[${i}].name`,
        message: `Unknown column slot name "${c.name}". Use a value from SLOTS.`,
      });
    }
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
