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
  let index: Map<number, Proposal> | null = null;

  // Built lazily, and rebuilt for free after the worker is evicted and
  // restarted, since the source is a bundled import rather than the network.
  const getIndex = (): Map<number, Proposal> => {
    index ??= new Map((proposals as Proposal[]).map((p) => [p.n, p]));
    return index;
  };

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as LookupRequest | undefined;
    if (msg?.type !== 'lookup') return false;

    const idx = getIndex();
    const out: LookupResponse = {};
    for (const n of msg.numbers ?? []) {
      const p = idx.get(n);
      if (p) out[n] = p;
    }

    // Must be sendResponse + `return true`, not a returned Promise. WXT's
    // `browser` is globalThis.chrome in Chrome rather than a polyfill, so
    // Chrome's semantics apply: a returned Promise is ignored and the message
    // channel closes immediately, leaving sendMessage resolved with undefined.
    sendResponse(out);
    return true;
  });
});
