import { statement, type ResourceName } from './permissions.js';
import { permissionLevels, type PermissionLevel } from '@openora/core/contracts';

export type { PermissionLevel };

// Caller can only grant a level <= their own per module (no-escalation invariant).
export const PERMISSION_LEVELS: readonly PermissionLevel[] = permissionLevels;

export const SUPPORTED_LEVELS: readonly PermissionLevel[] = PERMISSION_LEVELS;

export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function isLevelSufficient(have: PermissionLevel, required: PermissionLevel): boolean {
  return levelRank(have) >= levelRank(required);
}

// `content` has no 'view' action (create/update/delete/publish only), so read level
// maps to an empty set there - effectively read_write-or-nothing for that resource.
export function readActionsOf(actions: readonly string[]): string[] {
  return actions.includes('view') ? ['view'] : [];
}

export function actionsOf(resource: string): readonly string[] | undefined {
  return Object.hasOwn(statement, resource)
    ? (statement[resource as ResourceName] as readonly string[])
    : undefined;
}

/** Expands a (resource, level) cell to the action set AdminGuard checks - levels are stored, actions derived at the authz edge. */
export function levelToActions(resource: string, level: PermissionLevel): readonly string[] {
  const actions = actionsOf(resource);
  if (!actions) {
    return [];
  }
  if (level === 'no_access') {
    return [];
  }
  if (level === 'read_write') {
    return actions;
  }
  return readActionsOf(actions);
}

/** Collapses a concrete action set to the closest level - used only for legacy/edge data; new writes are level-native. */
export function actionsToLevel(resource: string, actions: readonly string[]): PermissionLevel {
  const all = actionsOf(resource);
  if (!all || all.length === 0) {
    return 'no_access';
  }
  const has = new Set(actions);
  if (all.every((a) => has.has(a))) {
    return 'read_write';
  }
  const read = readActionsOf(all);
  if (read.length > 0 && read.every((a) => has.has(a))) {
    return 'read';
  }
  return 'no_access';
}
