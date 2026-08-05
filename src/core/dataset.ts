import { browser } from 'wxt/browser';
import { UNMERGED_NUMBERS, VALID_NUMBERS } from './numbers.generated';
import type { Proposal } from './types';

/**
 * Two-tier loading. Most pages contain no EIP references at all, so the number
 * index is inlined into the content script bundle for instant rejection, while
 * the metadata payload is only requested once a page actually yields a confirmed
 * match -- and then only for the numbers on that page.
 */
const merged = new Set<number>(VALID_NUMBERS);
const unmerged = new Set<number>(UNMERGED_NUMBERS);

/**
 * Builds the predicate the matcher uses. Splitting the index by tier means the
 * "include open PRs" setting costs nothing at match time.
 */
export function numberValidator(includeUnmerged: boolean): (n: number) => boolean {
  if (!includeUnmerged) return (n) => merged.has(n);
  return (n) => merged.has(n) || unmerged.has(n);
}

export interface LookupRequest {
  type: 'lookup';
  numbers: number[];
}

/**
 * A number can resolve to several proposals: rival open PRs sometimes claim the
 * same number before an editor assigns it.
 */
export type LookupResponse = Record<number, Proposal[]>;

/** Per-page cache, so a rescan after a DOM mutation costs nothing. */
const cache = new Map<number, Proposal[]>();

/**
 * Resolves metadata via the background worker, which holds the bundled JSON.
 * Routed through messaging rather than web_accessible_resources so the page has
 * no fetchable extension URL to probe for.
 */
export async function lookup(numbers: number[]): Promise<Map<number, Proposal[]>> {
  const missing = numbers.filter((n) => !cache.has(n));
  if (missing.length > 0) {
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'lookup',
        numbers: missing,
      } satisfies LookupRequest)) as LookupResponse | undefined;
      for (const [key, list] of Object.entries(res ?? {})) {
        cache.set(Number(key), list);
      }
      // Remember misses too, so a number with no metadata is not re-requested on
      // every rescan.
      for (const n of missing) if (!cache.has(n)) cache.set(n, []);
    } catch {
      // Worker asleep or extension reloading; the caller renders nothing and the
      // next hover retries.
    }
  }
  const out = new Map<number, Proposal[]>();
  for (const n of numbers) {
    const list = cache.get(n);
    if (list?.length) out.set(n, list);
  }
  return out;
}
