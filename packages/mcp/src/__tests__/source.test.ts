import { describe, expect, it } from 'vitest';
import { findSymbol, findUsages, type SourceFile } from '../source.js';

const files: SourceFile[] = [
  {
    path: 'wallet/service/wallet.service.ts',
    text: [
      'export class WalletService {',
      '  constructor(private readonly ledger: Ledger) {}',
      '',
      '  async withdraw(',
      '    input: WithdrawInput,',
      '  ): Promise<Result> {',
      "    if (input.amount === '{') {",
      '      return this.fail();',
      '    }',
      '    return this.ledger.withdraw(input);',
      '  }',
      '',
      '  balance(): number {',
      '    return 0;',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    path: 'wallet/contract/wallet.contract.ts',
    text: [
      'export const WithdrawInputSchema = z.object({',
      '  amount: z.string(),',
      '});',
      'export type WithdrawInput = z.infer<typeof WithdrawInputSchema>;',
      'export interface WalletPort {',
      '  withdraw(input: WithdrawInput): Promise<Result>;',
      '}',
    ].join('\n'),
  },
  {
    path: 'wallet/__tests__/wallet.test.ts',
    text: 'service.withdraw(WithdrawInputSchema.parse({}));',
  },
  { path: 'gaming/router.ts', text: 'const withdrawal = 1;\nwallet.withdraw(x);' },
  {
    path: 'shared/errors.ts',
    text: [
      'import {',
      '  type WalletPort,',
      "} from '../wallet/contract/wallet.contract.js';",
      'export const makeNotFoundError = (entity: string) =>',
      '  createDomainError(`${entity} not found`, {',
      "    code: 'NOT_FOUND',",
      '  });',
    ].join('\n'),
  },
];

describe('findUsages', () => {
  it('matches whole identifiers outside tests', () => {
    expect(findUsages(files, 'withdraw').map((u) => `${u.path}:${u.line}`)).toEqual([
      'wallet/service/wallet.service.ts:4',
      'wallet/service/wallet.service.ts:10',
      'wallet/contract/wallet.contract.ts:6',
      'gaming/router.ts:2',
    ]);
  });

  it('scopes to a module and can include tests', () => {
    expect(findUsages(files, 'withdraw', { module: 'gaming' })).toHaveLength(1);
    expect(
      findUsages(files, 'WithdrawInputSchema', { includeTests: true }).map((u) => u.path),
    ).toContain('wallet/__tests__/wallet.test.ts');
  });
});

describe('findSymbol', () => {
  it('returns a multi-line method body, ignoring braces in strings', () => {
    const [hit, ...rest] = findSymbol(files, 'WalletService.withdraw');
    expect(rest).toEqual([]);
    expect(hit?.line).toBe(4);
    expect(hit?.body.at(-1)).toBe('  }');
    expect(hit?.body).toHaveLength(8);
  });

  it('finds every declaration of a bare name, not its call sites', () => {
    expect(findSymbol(files, 'withdraw').map((h) => `${h.path}:${h.line}`)).toEqual([
      'wallet/service/wallet.service.ts:4',
      'wallet/contract/wallet.contract.ts:6',
    ]);
  });

  it('reads a schema, a type alias and an interface', () => {
    expect(findSymbol(files, 'WithdrawInputSchema')[0]?.body).toHaveLength(3);
    expect(findSymbol(files, 'WithdrawInput')[0]?.body).toHaveLength(1);
    expect(findSymbol(files, 'WalletPort')[0]?.body).toHaveLength(3);
  });

  it('skips import lists and follows an arrow body onto the next line', () => {
    expect(findSymbol(files, 'WalletPort').map((h) => h.path)).toEqual([
      'wallet/contract/wallet.contract.ts',
    ]);
    expect(findSymbol(files, 'makeNotFoundError')[0]?.body).toHaveLength(4);
  });

  it('stays inside the owner', () => {
    expect(findSymbol(files, 'WalletPort.balance')).toEqual([]);
  });
});
