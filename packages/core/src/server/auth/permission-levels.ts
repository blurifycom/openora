import { statement, type ResourceName } from './permissions.js';
import { permissionLevels, type PermissionLevel } from '@openora/core/contracts';

export type { PermissionLevel };

export const PERMISSION_LEVELS: readonly PermissionLevel[] = permissionLevels;

export const SUPPORTED_LEVELS: readonly PermissionLevel[] = PERMISSION_LEVELS;

export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function isLevelSufficient(have: PermissionLevel, required: PermissionLevel): boolean {
  return levelRank(have) >= levelRank(required);
}

export const readActions: Partial<Record<ResourceName, readonly string[]>> = Object.fromEntries(
  (Object.keys(statement) as ResourceName[]).map((resource) => {
    const actions = statement[resource] as readonly string[];
    return [resource, actions.includes('view') ? ['view'] : []];
  }),
) as Partial<Record<ResourceName, readonly string[]>>;

export function readActionsOf(actions: readonly string[]): string[] {
  return actions.includes('view') ? ['view'] : [];
}

export function actionsOf(resource: string): readonly string[] | undefined {
  return Object.hasOwn(statement, resource)
    ? (statement[resource as ResourceName] as readonly string[])
    : undefined;
}

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
