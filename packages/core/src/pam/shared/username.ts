import { createDomainError, hasProfanity } from '@openora/core/server';

export const UsernameBlockedError = createDomainError<[]>(
  'UsernameBlockedError',
  () => 'Username is not allowed',
  { reason: 'prohibited_language', field: 'username' },
);

const BUILT_IN_RESERVED_USERNAMES = [
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

function toWords(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .join(' ');
}

export function isReserved(words: string, operatorReserved: readonly string[]) {
  const padded = ` ${words} `;
  return [...BUILT_IN_RESERVED_USERNAMES, ...operatorReserved]
    .map(toWords)
    .some((entry) => entry && padded.includes(` ${entry} `));
}

export function isUsernameAllowed(username: string, operatorReserved: readonly string[] = []) {
  const words = toWords(username);
  return !hasProfanity(words) && !isReserved(words, operatorReserved);
}

export function assertUsernameAllowed(username: string, operatorReserved?: readonly string[]) {
  if (!isUsernameAllowed(username, operatorReserved)) {
    throw new UsernameBlockedError();
  }
}
