import { isValidNumber, lookup } from '../core/dataset';
import { findMatches, isEthContext } from '../core/match';
import { getSettings, isSiteEnabled, onSettingsChanged } from '../core/settings';
import type { Match, Settings } from '../core/types';
import { Tooltip } from '../ui/tooltip';

const HIGHLIGHT_NAME = 'eip-ref';
const STYLE_ID = 'eip-helper-highlight-style';

/** Backstop for pathological pages; the tooltip is useless past this anyway. */
const MAX_MATCHES = 2000;
const RESCAN_DEBOUNCE_MS = 300;
const HOVER_DWELL_MS = 120;
const HOVER_GRACE_MS = 200;

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'SVG',
  'MATH',
  'IFRAME',
  'CANVAS',
]);

/** A highlighted reference and the range painting it. */
interface Hit {
  start: number;
  end: number;
  match: Match;
  range: Range;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // Paint-only highlighting is what lets this run on <all_urls> safely. The
    // alternative -- wrapping matches in <span>s -- mutates the page DOM and
    // breaks React reconciliation and contenteditable.
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    void start();
  },
});

async function start() {
  let settings = await getSettings();
  const tooltip = new Tooltip();

  /** Hits grouped by text node, which is how the pointer is mapped to a match. */
  let byNode = new Map<Text, Hit[]>();
  let observer: MutationObserver | null = null;
  let rescanTimer: number | undefined;

  const scan = () => {
    byNode = new Map();
    if (!isSiteEnabled(settings, location.hostname)) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const nodes = collectTextNodes(tooltip.hostElement);

    // Tier 1 first, so "does this page discuss Ethereum at all?" is answered
    // before deciding whether bare numbers are plausible here.
    const firstPass = matchNodes(nodes, { allowBare: false });
    const allowBare =
      settings.bareNumbers && isEthContext(location.hostname, firstPass.length > 0);
    const found = allowBare ? matchNodes(nodes, { allowBare: true }) : firstPass;

    if (found.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const capped = found.slice(0, MAX_MATCHES);
    const rangeList: Range[] = [];
    for (const { node, match } of capped) {
      const range = document.createRange();
      try {
        range.setStart(node, match.start);
        range.setEnd(node, match.end);
      } catch {
        continue; // Node changed under us; the next rescan picks it up.
      }
      const hits = byNode.get(node);
      const hit: Hit = { start: match.start, end: match.end, match, range };
      if (hits) hits.push(hit);
      else byNode.set(node, [hit]);
      rangeList.push(range);
    }

    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...rangeList));

    // Warm the metadata cache for what is on the page, so the first hover has
    // no latency. Pages with no matches never trigger this.
    void lookup([...new Set(capped.map((c) => c.match.n))]);
  };

  const scheduleRescan = () => {
    window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => scan(), { timeout: 1000 });
      } else {
        scan();
      }
    }, RESCAN_DEBOUNCE_MS);
  };

  const observe = () => {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      // The tooltip is the one thing this extension adds to the DOM; reacting
      // to its own mutations would be an endless rescan loop.
      if (mutations.every((m) => tooltip.owns(m.target))) return;
      scheduleRescan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  // -- hover -------------------------------------------------------------
  let hoverFrame = 0;
  let dwellTimer: number | undefined;
  let active: Match | null = null;

  document.addEventListener(
    'mousemove',
    (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (byNode.size === 0) return;

        const hit = hitTest(e.clientX, e.clientY, byNode);

        if (!hit) {
          if (active && !tooltip.isPointerInside()) {
            active = null;
            window.clearTimeout(dwellTimer);
            tooltip.hide(HOVER_GRACE_MS);
          }
          return;
        }

        if (active?.n === hit.match.n && tooltip.isVisible()) return;
        active = hit.match;
        window.clearTimeout(dwellTimer);
        dwellTimer = window.setTimeout(() => {
          void tooltip.show(hit.match, hit.range.getBoundingClientRect());
        }, HOVER_DWELL_MS);
      });
    },
    { passive: true },
  );

  // A highlight is not a DOM node, so it has no scroll or focus events of its
  // own. Hide rather than try to keep a stale rect in sync.
  window.addEventListener('scroll', () => tooltip.hide(0), { passive: true, capture: true });

  onSettingsChanged((next: Settings) => {
    settings = next;
    injectStyle(settings);
    tooltip.hide(0);
    scan();
  });

  injectStyle(settings);
  scan();
  observe();
}

/**
 * Finds the reference under the pointer.
 *
 * Deliberately does NOT use CSS.highlights.highlightsFromPoint. That API is the
 * purpose-built one, but it is Chrome-135-only and was observed present-yet-
 * always-empty in a current Chromium build (Brave 151), which would silently
 * disable hover entirely. Resolving the caret position and then confirming
 * against the range's own painted rects relies only on long-standing APIs and
 * works the same everywhere.
 */
function hitTest(x: number, y: number, byNode: Map<Text, Hit[]>): Hit | null {
  const caret = caretAt(x, y);
  if (!caret) return null;

  const hits = byNode.get(caret.node);
  if (!hits) return null;

  for (const hit of hits) {
    // caretAt snaps to the nearest position, so an offset inside the match is
    // necessary but not sufficient -- confirm the pointer is really over the
    // painted text.
    if (caret.offset >= hit.start && caret.offset <= hit.end && containsPoint(hit.range, x, y)) {
      return hit;
    }
  }
  return null;
}

interface Caret {
  node: Text;
  offset: number;
}

function caretAt(x: number, y: number): Caret | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) {
    return { node: pos.offsetNode as Text, offset: pos.offset };
  }
  // Older Blink/WebKit spelling.
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
    return { node: range.startContainer as Text, offset: range.startOffset };
  }
  return null;
}

function containsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

function collectTextNodes(tooltipHost: Element | null): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      // Cheapest possible rejection: no digits means no possible reference.
      if (!text || text.length < 2 || !/\d/.test(text)) return NodeFilter.FILTER_REJECT;
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (tooltipHost && tooltipHost.contains(parent)) return NodeFilter.FILTER_REJECT;
      for (let el: Element | null = parent; el; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        // Editing surfaces: painting into them is harmless, but highlights
        // interact badly with carets and selections, and appearing to corrupt
        // someone's draft is not worth the coverage.
        if (el instanceof HTMLElement && el.isContentEditable) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function matchNodes(
  nodes: Text[],
  opts: { allowBare: boolean },
): Array<{ node: Text; match: Match }> {
  const out: Array<{ node: Text; match: Match }> = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text) continue;
    const matches = findMatches(text, { isValid: isValidNumber, allowBare: opts.allowBare });
    if (matches.length === 0) continue;
    const link = node.parentElement?.closest('a[href]') as HTMLAnchorElement | null;
    for (const match of matches) {
      // Don't decorate a reference that is already a link to the same
      // proposal -- common on eips.ethereum.org and in rendered markdown.
      if (link && linksToProposal(link.getAttribute('href') ?? '', match.n)) continue;
      out.push({ node, match });
    }
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

function linksToProposal(href: string, n: number): boolean {
  return new RegExp(`(?:eip|erc)[-_]?${n}(?:\\D|$)`, 'i').test(href);
}

function injectStyle(settings: Settings) {
  document.getElementById(STYLE_ID)?.remove();

  // Highlight pseudo-elements accept only a few properties (color,
  // background-color, text-decoration, text-shadow, -webkit-text-stroke) --
  // no cursor, no border, nothing affecting layout. So the affordance has to
  // be carried by decoration and tint alone.
  const underline = `text-decoration: underline dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    text-decoration-color: rgb(99 102 241 / 0.85);`;
  const background = 'background-color: rgb(99 102 241 / 0.14);';

  const body =
    settings.highlightStyle === 'underline'
      ? underline
      : settings.highlightStyle === 'background'
        ? background
        : `${underline}\n    ${background}`;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Must live in the page's own tree: ::highlight() resolves against the
  // document owning the highlighted ranges, not the extension's shadow root.
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) {\n    ${body}\n  }`;
  document.head.append(style);
}
