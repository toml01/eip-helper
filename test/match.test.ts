import { describe, expect, it } from 'vitest';
import { findMatches, isEthContext, bareLooksLikeProposal } from '../src/core/match';
import { VALID_NUMBERS } from '../src/core/numbers.generated';

const valid = new Set(VALID_NUMBERS);
const isValid = (n: number) => valid.has(n);

const nums = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.n);

const texts = (text: string, allowBare = false) =>
  findMatches(text, { isValid, allowBare }).map((m) => m.text);

describe('Tier 1 — prefixed references', () => {
  it.each([
    ['EIP-7702', 7702],
    ['eip-7702', 7702],
    ['EIP 7702', 7702],
    ['EIP7702', 7702],
    ['eip7702', 7702],
    ['EIP_7702', 7702],
    ['EIP:7702', 7702],
    ['EIP - 7702', 7702],
    ['EIP–7702', 7702], // en dash
    ['EIP—7702', 7702], // em dash
    ['ERC-20', 20],
    ['ERC20', 20],
    ['erc 20', 20],
    ['ERC-4337', 4337],
  ])('matches %j', (input, expected) => {
    expect(nums(input)).toEqual([expected]);
  });

  it('matches the plural prefix, which is common in prose', () => {
    // Without the optional "s" the prefix is missed entirely.
    expect(nums('EIPs 3074 introduced this')).toEqual([3074]);
    expect(nums('several ERCs 4337 style')).toContain(4337);
  });

  it('matches a trailing plural on the number', () => {
    expect(nums('ERC-721s are non-fungible')).toEqual([721]);
  });

  it('highlights only the reference, not a trailing plural', () => {
    expect(texts('ERC-721s')).toEqual(['ERC-721']);
  });

  it('finds several references in one run of text', () => {
    expect(nums('EIP-7702 builds on EIP-2718 and ERC-4337')).toEqual([7702, 2718, 4337]);
  });

  it('is case-insensitive and works mid-sentence', () => {
    expect(nums('see Eip-1559 for the fee market')).toEqual([1559]);
  });

  describe('rejections', () => {
    it('rejects numbers that are not real proposals', () => {
      expect(nums('EIP-99999')).toEqual([]);
      expect(nums('EIP-8888')).toEqual([]);
    });

    it('requires a word boundary before the prefix', () => {
      expect(nums('AEIP-7702')).toEqual([]);
      expect(nums('xeip7702')).toEqual([]);
    });

    it('does not match a prefix with no number', () => {
      expect(nums('the EIP- process')).toEqual([]);
      expect(nums('read the EIP')).toEqual([]);
    });

    it('does not read a sentence boundary as a separator', () => {
      // "." is deliberately excluded from the separator set.
      expect(nums('That is the EIP. 7702 comes later.')).toEqual([]);
    });

    it('does not match a number glued to trailing letters', () => {
      expect(nums('EIP-7702X')).toEqual([]);
    });
  });
});

describe('Tier 1 — list continuations', () => {
  it('follows "and", commas, and slashes after a prefixed reference', () => {
    expect(nums('EIPs 3074 and 7702')).toEqual([3074, 7702]);
    expect(nums('EIP-2718, 2930, 4844')).toEqual([2718, 2930, 4844]);
    expect(nums('EIP-7702/3074')).toEqual([7702, 3074]);
    expect(nums('EIPs 1559 & 4844')).toEqual([1559, 4844]);
  });

  it('requires 3+ digits in a continuation, so quantities are not swept up', () => {
    // 5 is a real EIP, but "and 5 others" is a count, not a reference.
    expect(nums('EIP-20 and 5 others')).toEqual([20]);
  });

  it('stops at a number that is not a real proposal', () => {
    expect(nums('EIP-7702 and 99999')).toEqual([7702]);
  });

  it('does not run past unrelated prose', () => {
    expect(nums('EIP-7702 improves on it. 3074 was the old way.')).toEqual([7702]);
  });
});

describe('Tier 2 — bare numbers', () => {
  it('is off unless explicitly allowed', () => {
    expect(nums('7702 changes EOAs')).toEqual([]);
  });

  it('matches a plausible bare reference when allowed', () => {
    expect(nums('7702 changes EOAs', true)).toEqual([7702]);
    expect(nums('4337 bundlers', true)).toEqual([4337]);
  });

  it('never matches numbers under 1000, the noisiest range', () => {
    // 20, 150 and 999 are all real proposals but hopeless as bare matches.
    expect(nums('20 items', true)).toEqual([]);
    expect(nums('150 users online', true)).toEqual([]);
    expect(nums('999 problems', true)).toEqual([]);
  });

  it('never matches year-shaped numbers, even though they are real proposals', () => {
    // 2015, 2020, 2025 and 2026 are all real proposal numbers.
    for (const year of ['2015', '2019', '2020', '2021', '2025', '2026']) {
      expect(nums(`back in ${year} things changed`, true)).toEqual([]);
      expect(nums(`${year} was a good year`, true)).toEqual([]);
    }
  });

  it('rejects year contexts and ranges', () => {
    expect(nums('since 2020', true)).toEqual([]);
    expect(nums('Q3 2026 roadmap', true)).toEqual([]);
    expect(nums('the 2024-2026 period', true)).toEqual([]);
    expect(nums('March 2020 update', true)).toEqual([]);
    expect(nums('© 2026 Foundation', true)).toEqual([]);
  });

  it('rejects currency and quantities', () => {
    expect(nums('$7702 raised', true)).toEqual([]);
    expect(nums('7702 USD', true)).toEqual([]);
    expect(nums('7702 users', true)).toEqual([]);
    expect(nums('7702 blocks', true)).toEqual([]);
    expect(nums('7702%', true)).toEqual([]);
  });

  it('rejects numbers that are part of a larger number', () => {
    expect(nums('1,7702', true)).toEqual([]);
    expect(nums('3.7702', true)).toEqual([]);
    expect(nums('7702.5', true)).toEqual([]);
    expect(nums('77021', true)).toEqual([]);
    expect(nums('1234567702', true)).toEqual([]);
  });

  it('rejects hex and identifiers by word boundary', () => {
    expect(nums('0x7702', true)).toEqual([]);
    expect(nums('0xdeadbeef7702', true)).toEqual([]);
    expect(nums('v7702', true)).toEqual([]);
    expect(nums('build-7702-rc1', true)).toEqual([]);
  });

  it('rejects date shapes', () => {
    expect(nums('2024/7702', true)).toEqual([]);
    expect(nums('7702/2024', true)).toEqual([]);
  });

  it('does not double-report a number already matched with a prefix', () => {
    expect(nums('EIP-7702 and 7702 again', true)).toEqual([7702, 7702]);
    // The prefixed match and the continuation each count once -- no third
    // bare match overlapping the same characters.
    expect(findMatches('EIP-7702', { isValid, allowBare: true })).toHaveLength(1);
  });
});

describe('bareLooksLikeProposal', () => {
  it('accepts a bare number in neutral prose', () => {
    const text = 'the 7702 delegation model';
    expect(bareLooksLikeProposal(text, 4, 8)).toBe(true);
  });

  it('rejects a bare number in a year context', () => {
    const text = 'in 2026 we ship';
    expect(bareLooksLikeProposal(text, 3, 7)).toBe(false);
  });
});

describe('isEthContext', () => {
  it('trusts known hosts with no prior match', () => {
    expect(isEthContext('eips.ethereum.org', false)).toBe(true);
    expect(isEthContext('ethereum-magicians.org', false)).toBe(true);
    expect(isEthContext('www.ethresear.ch', false)).toBe(true);
    expect(isEthContext('notes.ethereum.org', false)).toBe(true);
  });

  it('requires a prior explicit match on unknown hosts', () => {
    expect(isEthContext('news.ycombinator.com', false)).toBe(false);
    expect(isEthContext('news.ycombinator.com', true)).toBe(true);
  });

  it('is not fooled by a lookalike host', () => {
    expect(isEthContext('ethereum.org.evil.com', false)).toBe(false);
  });
});

describe('EIP/ERC namespace', () => {
  it('resolves both prefixes, since the number space is shared', () => {
    // 4337 is canonically an ERC; writing "EIP-4337" still refers to it.
    const m = findMatches('EIP-4337', { isValid })[0]!;
    expect(m.n).toBe(4337);
    expect(m.writtenKind).toBe('eip');
  });

  it('records the prefix as written so a mismatch can be surfaced', () => {
    expect(findMatches('ERC-7702', { isValid })[0]!.writtenKind).toBe('erc');
  });
});
