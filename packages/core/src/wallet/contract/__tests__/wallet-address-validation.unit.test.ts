import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isWalletAddressValidForNetwork } from '../index.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32 = 1;
const BECH32M = 0x2bc830a3;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= GENERATOR[i] as number;
      }
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  return [
    ...Array.from(hrp, (c) => c.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (c) => c.charCodeAt(0) & 31),
  ];
}

function toFiveBit(bytes: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) {
    out.push((acc << (5 - bits)) & 31);
  }
  return out;
}

function encode(
  hrp: string,
  version: number,
  program: readonly number[],
  constant: number,
): string {
  const data = [version, ...toFiveBit(program)];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

const bytes = (min: number, max: number) =>
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: min, maxLength: max });
const hrpFor = { SEGWIT: ['bc', 'tb', 'bcrt'], LITECOIN: ['ltc', 'tltc'] } as const;

const valid = (address: string, network: string) =>
  isWalletAddressValidForNetwork(address, network);

describe('reference encoder agrees with published vectors', () => {
  it('rebuilds BIP-173 and BIP-350 addresses', () => {
    const p2wpkh = [
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ];
    expect(encode('bc', 0, p2wpkh, BECH32)).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });
});

describe('bech32 and bech32m vectors through SEGWIT', () => {
  it.each([
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
    'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
  ])('accepts valid vector %s', (address) => {
    expect(valid(address, 'SEGWIT')).toBe(true);
  });

  it.each([
    ['bad checksum', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'],
    ['unknown hrp', 'tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty'],
    ['mixed case', 'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['invalid character b', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tb'],
    ['invalid character 1 in data', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t1'],
    [
      'bech32 checksum on witness v1',
      'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
    ],
    ['empty hrp', '1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['empty string', ''],
    ['hrp only', 'bc1'],
    ['truncated', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3'],
  ])('rejects %s', (_label, address) => {
    expect(valid(address, 'SEGWIT')).toBe(false);
  });

  it('rejects an address longer than the bech32 90 character limit', () => {
    const long = `bc1${'q'.repeat(88)}`;
    expect(long.length).toBeGreaterThan(90);
    expect(valid(long, 'SEGWIT')).toBe(false);
  });

  it('accepts the all-uppercase form BIP-173 allows', () => {
    expect(valid('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'SEGWIT')).toBe(true);
  });
});

describe('bech32 properties against an independent encoder', () => {
  const networks = [
    ['SEGWIT', hrpFor.SEGWIT],
    ['LITECOIN', hrpFor.LITECOIN],
  ] as const;

  for (const [network, hrps] of networks) {
    const hrp = fc.constantFrom(...hrps);

    it(`${network}: v0 with 20 or 32 byte program and bech32 is valid, bech32m is not`, () => {
      fc.assert(
        fc.property(hrp, fc.constantFrom(20, 32), fc.nat(), (h, size, seed) => {
          const program = Array.from({ length: size }, (_, i) => (seed * 31 + i * 17) % 256);
          expect(valid(encode(h, 0, program, BECH32), network)).toBe(true);
          expect(valid(encode(h, 0, program, BECH32M), network)).toBe(false);
        }),
      );
    });

    it(`${network}: v0 with a program size other than 20 or 32 bytes is invalid`, () => {
      fc.assert(
        fc.property(
          hrp,
          fc.integer({ min: 12, max: 40 }).filter((n) => n !== 20 && n !== 32),
          (h, size) => {
            const program = Array.from({ length: size }, (_, i) => (i * 7) % 256);
            expect(valid(encode(h, 0, program, BECH32), network)).toBe(false);
          },
        ),
      );
    });

    it(`${network}: v1..16 with bech32m is valid, bech32 is not`, () => {
      fc.assert(
        fc.property(hrp, fc.integer({ min: 1, max: 16 }), bytes(12, 40), (h, version, program) => {
          expect(valid(encode(h, version, program, BECH32M), network)).toBe(true);
          expect(valid(encode(h, version, program, BECH32), network)).toBe(false);
        }),
      );
    });

    it(`${network}: any single character substitution breaks a valid address`, () => {
      fc.assert(
        fc.property(
          hrp,
          bytes(20, 20),
          fc.nat(),
          fc.integer({ min: 1, max: 31 }),
          (h, program, at, shift) => {
            const address = encode(h, 0, program, BECH32);
            const index = h.length + 1 + (at % (address.length - h.length - 1));
            const replaced = CHARSET[(CHARSET.indexOf(address[index] as string) + shift) % 32];
            const mutated = `${address.slice(0, index)}${replaced}${address.slice(index + 1)}`;
            expect(valid(mutated, network)).toBe(false);
          },
        ),
      );
    });

    it(`${network}: dropping the last character breaks a valid address`, () => {
      fc.assert(
        fc.property(hrp, bytes(32, 32), (h, program) => {
          expect(valid(encode(h, 0, program, BECH32).slice(0, -1), network)).toBe(false);
        }),
      );
    });
  }

  it('does not accept an address whose hrp belongs to the other chain', () => {
    const program = Array.from({ length: 20 }, (_, i) => i);
    expect(valid(encode('ltc', 0, program, BECH32), 'SEGWIT')).toBe(false);
    expect(valid(encode('bc', 0, program, BECH32), 'LITECOIN')).toBe(false);
  });
});

describe('per-network patterns', () => {
  const b58 = (n: number) => '1'.repeat(n);

  const table: Record<string, { valid: string[]; invalid: string[] }> = {
    SEGWIT: {
      valid: ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
      invalid: [
        `1${b58(24)}`,
        `1${b58(40)}`,
        `4${b58(30)}`,
        `1${b58(29)}0`,
        `1${b58(29)}O`,
        `1${b58(29)}I`,
        `1${b58(29)}l`,
      ],
    },
    BITCOIN_CASH: {
      valid: [
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      ],
      invalid: [
        'bitcoincash:xpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6',
        'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6aa',
        'QPM2QSZNHKS23Z7629MMS6S4CWEF74VCWVY22GDX6A',
      ],
    },
    LITECOIN: {
      valid: ['LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz', 'M8T1B2Z97gVdvmfkQcAtYbEepune1tzGua'],
      invalid: [`L${b58(24)}`, `L${b58(40)}`, `B${b58(30)}`, `L${b58(29)}0`],
    },
    DOGECOIN: {
      valid: [`D${b58(25)}`, `D${b58(39)}`, `A${b58(33)}`],
      invalid: [`D${b58(24)}`, `D${b58(40)}`, `1${b58(33)}`, `D${b58(32)}0`],
    },
    XRP_LEDGER: {
      valid: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', `r${b58(24)}`, `r${b58(34)}`],
      invalid: [`r${b58(23)}`, `r${b58(35)}`, `x${b58(30)}`, `r${b58(29)}0`],
    },
    ERC20: {
      valid: [`0x${'a'.repeat(40)}`, `0x${'F'.repeat(40)}`, `0x${'0123456789'.repeat(4)}`],
      invalid: [
        `0x${'a'.repeat(39)}`,
        `0x${'a'.repeat(41)}`,
        `0x${'g'.repeat(40)}`,
        'a'.repeat(40),
        `0X${'a'.repeat(40)}`,
        ` 0x${'a'.repeat(40)}`,
      ],
    },
    BEP20: {
      valid: [`0x${'b'.repeat(40)}`],
      invalid: [`0x${'b'.repeat(39)}`, `0x${'b'.repeat(41)}`, `0x${'z'.repeat(40)}`],
    },
    TRC20: {
      valid: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', `T${b58(33)}`],
      invalid: [`T${b58(32)}`, `T${b58(34)}`, `A${b58(33)}`, `T${b58(32)}0`],
    },
    SOLANA: {
      valid: [b58(32), b58(44), '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
      invalid: [b58(31), b58(45), `${b58(31)}0`, `${b58(31)}O`],
    },
  };

  for (const [network, cases] of Object.entries(table)) {
    it.each(cases.valid)(`${network} accepts %s`, (address) => {
      expect(valid(address, network)).toBe(true);
    });
    it.each(cases.invalid)(`${network} rejects %s`, (address) => {
      expect(valid(address, network)).toBe(false);
    });
  }

  it('looks the network up case-insensitively', () => {
    expect(valid(`0x${'a'.repeat(40)}`, 'erc20')).toBe(true);
    expect(valid(`0x${'a'.repeat(39)}`, 'Erc20')).toBe(false);
  });
});

describe('unknown network falls back to the 8-128 length bound', () => {
  it.each([
    [7, false],
    [8, true],
    [9, true],
    [127, true],
    [128, true],
    [129, false],
    [0, false],
  ])('length %i -> %s', (length, expected) => {
    expect(valid('x'.repeat(length), 'NOT_A_CHAIN')).toBe(expected);
  });

  it('property: length alone decides for an unknown network', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (address) => {
        expect(valid(address, 'NOT_A_CHAIN')).toBe(address.length >= 8 && address.length <= 128);
      }),
    );
  });
});
