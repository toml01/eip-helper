import { browser } from 'wxt/browser';
import proposals from '../../data/eips.json';
import type { LookupRequest, LookupResponse } from '../core/dataset';
import type { Proposal } from '../core/types';

/**
 * Holds the bundled dataset and answers metadata lookups from content scripts.
 *
 * The service worker is the right home for this: it keeps the 334 KB payload
 * out of every frame's memory, and it means no web_accessible_resources entry
 * (which a page could fetch to detect the extension).
 */
export default defineBackground(() => {
  let index: Map<number, Proposal[]> | null = null;

  /**
   * Built lazily, and rebuilt for free after the worker is evicted and restarted,
   * since the source is a bundled import rather than the network.
   *
   * Grouped rather than last-write-wins: rival open PRs can claim the same number
   * before an editor assigns it, and a proposal can also answer to curated
   * aliases, so one number may map to several proposals.
   */
  const getIndex = (): Map<number, Proposal[]> => {
    if (!index) {
      index = new Map();
      for (const p of proposals as Proposal[]) {
        for (const n of [p.n, ...(p.aka ?? [])]) {
          const list = index.get(n);
          if (list) list.push(p);
          else index.set(n, [p]);
        }
      }
    }
    return index;
  };

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as LookupRequest | undefined;
    if (msg?.type !== 'lookup') return false;

    const idx = getIndex();
    const out: LookupResponse = {};
    for (const n of msg.numbers ?? []) {
      const list = idx.get(n);
      if (list?.length) out[n] = list;
    }

    // Must be sendResponse + `return true`, not a returned Promise. WXT's
    // `browser` is globalThis.chrome in Chrome rather than a polyfill, so
    // Chrome's semantics apply: a returned Promise is ignored and the message
    // channel closes immediately, leaving sendMessage resolved with undefined.
    sendResponse(out);
    return true;
  });
});
