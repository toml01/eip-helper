import { browser } from 'wxt/browser';
import { VALID_NUMBERS } from './numbers.generated';
import type { Proposal } from './types';

/**
 * Two-tier loading. Most pages contain no EIP references at all, so the number
 * index is inlined into the content script bundle for instant rejection, while
 * the 334 KB metadata payload is only requested once a page actually yields a
 * confirmed match -- and then only for the numbers on that page.
 */
const valid = new Set<number>(VALID_NUMBERS);

export function isValidNumber(n: number): boolean {
  return valid.has(n);
}

export interface LookupRequest {
  type: 'lookup';
  numbers: number[];
}

export type LookupResponse = Record<number, Proposal>;

/** Per-page cache, so a rescan after a DOM mutation costs nothing. */
const cache = new Map<number, Proposal>();

export function cached(n: number): Proposal | undefined {
  return cache.get(n);
}

/**
 * Resolves metadata via the background worker, which holds the bundled JSON.
 * Routed through messaging rather than web_accessible_resources so the page
 * has no fetchable extension URL to probe for.
 */
export async function lookup(numbers: number[]): Promise<Map<number, Proposal>> {
  const missing = numbers.filter((n) => !cache.has(n));
  if (missing.length > 0) {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'lookup',
        numbers: missing,
      } satisfies LookupRequest)) as LookupResponse | undefined;
      for (const p of Object.values(res ?? {})) cache.set(p.n, p);
    } catch {
      // Worker asleep or extension reloading; the caller renders nothing and
      // the next hover retries.
    }
  }
  const out = new Map<number, Proposal>();
  for (const n of numbers) {
    const p = cache.get(n);
    if (p) out.set(n, p);
  }
  return out;
}
