import { createDomainError, hasProfanity } from '@openora/core/server';

export const UsernameBlockedError = createDomainError<[]>(
  'UsernameBlockedError',
  () => 'Username is not allowed',
  { reason: 'prohibited_language', field: 'username' },
);

/** Handles that read as staff or the platform itself. Operators add their own via `reservedUsernames`. */
export const BUILT_IN_RESERVED_USERNAMES = [
  'admin',
  'admins',
  'administrator',
  'sysadmin',
  'superuser',
  'root',
  'system',
  'support',
  'helpdesk',
  'help',
  'moderator',
  'moderators',
  'mod',
  'mods',
  'staff',
  'official',
  'security',
  'operator',
  'owner',
  'compliance',
  'cashier',
  'billing',
  'payments',
  'webmaster',
  'postmaster',
  'noreply',
  'bot',
] as const;

/**
 * Words only: separators and digits split the handle, so `support_1` reads as `support`.
 * The profanity list matches whole words and counts `_` and digits as word characters,
 * so without this `big_ass_1` would pass.
 */
function toWords(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .join(' ');
}

/** A reserved entry matches as a whole word run, so `mod` blocks `mod_7` but not `modest`. */
function isReserved(words: string, operatorReserved: readonly string[]) {
  const padded = ` ${words} `;
  return [...BUILT_IN_RESERVED_USERNAMES, ...operatorReserved]
    .map(toWords)
    .some((entry) => entry && padded.includes(` ${entry} `));
}

export function isUsernameAllowed(username: string, operatorReserved: readonly string[] = []) {
  const words = toWords(username);
  return !hasProfanity(words) && !isReserved(words, operatorReserved);
}

/** One gate for every path that sets a handle: sign-up and rename. */
export function assertUsernameAllowed(username: string, operatorReserved?: readonly string[]) {
  if (!isUsernameAllowed(username, operatorReserved)) {
    throw new UsernameBlockedError();
  }
}
