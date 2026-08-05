import { describe, expect, it } from 'vitest';
import proposals from '../data/eips.json';
import { VALID_NUMBERS } from '../src/core/numbers.generated';
import { specUrl, sourceUrl, linksFor, statusLine } from '../src/core/links';
import type { Proposal } from '../src/core/types';

const all = proposals as Proposal[];
const byNumber = new Map(all.map((p) => [p.n, p]));

describe('dataset integrity', () => {
  it('has a plausible number of proposals', () => {
    expect(all.length).toBeGreaterThan(1100);
    expect(all.length).toBeLessThan(1600);
  });

  it('assigns each number exactly one proposal', () => {
    // EIPs and ERCs share one namespace, so a duplicate here would mean the
    // "Moved" stub filtering or the EIP-1 collision handling regressed.
    expect(byNumber.size).toBe(all.length);
  });

  it('keeps exactly one EIP-1, from the EIPs repo', () => {
    const ones = all.filter((p) => p.n === 1);
    expect(ones).toHaveLength(1);
    expect(ones[0]!.k).toBe('eip');
  });

  it('never retains YAML quote characters in a title', () => {
    // Regression guard: 16 titles are YAML-quoted upstream because they
    // contain a colon, e.g. title: "Hardfork Meta: Homestead".
    const bad = all.filter((p) => /^["']|["']$/.test(p.t));
    expect(bad.map((p) => p.n)).toEqual([]);
  });

  it('preserves colons inside quoted titles', () => {
    expect(byNumber.get(606)!.t).toBe('Hardfork Meta: Homestead');
    expect(byNumber.get(211)!.t).toBe('New opcodes: RETURNDATASIZE and RETURNDATACOPY');
  });

  it('excludes "Moved" stubs', () => {
    expect(all.some((p) => p.s === 'Moved')).toBe(false);
  });

  it('always has a title, status and type', () => {
    expect(all.filter((p) => !p.t || !p.s || !p.ty)).toEqual([]);
  });

  it('routes proposals to the repo they actually live in', () => {
    expect(byNumber.get(7702)!.k).toBe('eip');
    expect(byNumber.get(4337)!.k).toBe('erc');
    expect(byNumber.get(20)!.k).toBe('erc');
  });

  it('matches the inlined number index', () => {
    expect([...VALID_NUMBERS].sort((a, b) => a - b)).toEqual(
      all.map((p) => p.n).sort((a, b) => a - b),
    );
  });
});

describe('spot checks', () => {
  it('resolves EIP-7702', () => {
    const p = byNumber.get(7702)!;
    expect(p.t).toBe('Set Code for EOAs');
    expect(p.s).toBe('Final');
    expect(p.c).toBe('Core');
    expect(statusLine(p)).toBe('Final · Core');
  });

  it('resolves ERC-4337', () => {
    const p = byNumber.get(4337)!;
    expect(p.t).toBe('Account Abstraction Using Alt Mempool');
    expect(p.k).toBe('erc');
  });
});

describe('links', () => {
  it('uses one canonical spec URL for both kinds', () => {
    // eips.ethereum.org/EIPS/eip-N resolves for ERC-only proposals too.
    expect(specUrl(7702)).toBe('https://eips.ethereum.org/EIPS/eip-7702');
    expect(specUrl(4337)).toBe('https://eips.ethereum.org/EIPS/eip-4337');
  });

  it('points the source link at the right repo', () => {
    expect(sourceUrl(byNumber.get(7702)!)).toContain('/ethereum/EIPs/blob/master/EIPS/eip-7702.md');
    expect(sourceUrl(byNumber.get(4337)!)).toContain('/ethereum/ERCs/blob/master/ERCS/erc-4337.md');
  });

  it('omits the discussion link when upstream has none', () => {
    const withDisc = all.find((p) => p.disc)!;
    const withoutDisc = all.find((p) => !p.disc)!;
    expect(linksFor(withDisc).map((l) => l.label)).toEqual(['Spec', 'Discussion', 'Source']);
    expect(linksFor(withoutDisc).map((l) => l.label)).toEqual(['Spec', 'Source']);
  });

  it('falls back to type when a proposal has no category', () => {
    // Meta and Informational proposals correctly have no category.
    const meta = all.find((p) => !p.c)!;
    expect(statusLine(meta)).toBe(`${meta.s} · ${meta.ty}`);
  });

  it('produces only https links', () => {
    for (const p of all) {
      for (const link of linksFor(p)) {
        expect(link.url).toMatch(/^https:\/\//);
      }
    }
  });
});
