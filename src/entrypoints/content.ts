import { isValidNumber, lookup } from '../core/dataset';
import { findMatches, isEthContext } from '../core/match';
import { buildSegment, locate, partsCovering, type Segment } from '../core/segments';
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

/** Subtrees that are never scanned. */
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

/**
 * Elements that end an inline run. Deliberately a static tag list rather than
 * getComputedStyle: resolving styles for every element would be far too
 * expensive for a scan that reruns on every DOM mutation, and this is both
 * faster and deterministic.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'BUTTON', 'DD',
  'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** Hosts whose links count as pointing at the proposal itself. */
const SPEC_HOSTS = /(?:^|\.)(?:eips\.ethereum\.org|ercs\.ethereum\.org|github\.com)$/i;

interface Hit {
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

  /**
   * Hits indexed by every text node they cover. A hit can span several nodes,
   * so hovering any part of one has to resolve to the same match.
   */
  let byNode = new Map<Text, Hit[]>();
  let observer: MutationObserver | null = null;
  let rescanTimer: number | undefined;

  const scan = () => {
    byNode = new Map();
    if (!isSiteEnabled(settings, location.hostname)) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const segments = collectSegments(tooltip.hostElement);

    // Tier 1 first, so "does this page discuss Ethereum at all?" is answered
    // before deciding whether bare numbers are plausible here.
    const firstPass = matchSegments(segments, false);
    const allowBare =
      settings.bareNumbers && isEthContext(location.hostname, firstPass.length > 0);
    const found = allowBare ? matchSegments(segments, true) : firstPass;

    if (found.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }

    const rangeList: Range[] = [];
    for (const { segment, match } of found.slice(0, MAX_MATCHES)) {
      const from = locate(segment, match.start);
      const to = locate(segment, match.end);
      if (!from || !to) continue;

      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        continue; // Nodes changed under us; the next rescan picks it up.
      }

      const hit: Hit = { match, range };
      for (const node of partsCovering(segment, match.start, match.end)) {
        const list = byNode.get(node);
        if (list) list.push(hit);
        else byNode.set(node, [hit]);
      }
      rangeList.push(range);
    }

    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...rangeList));

    // Warm the metadata cache for what is on the page, so the first hover has
    // no latency. Pages with no matches never trigger this.
    void lookup([...new Set(found.map((f) => f.match.n))]);
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
 * disable hover entirely. Resolving the caret position and confirming it
 * against the range relies only on long-standing APIs.
 */
function hitTest(x: number, y: number, byNode: Map<Text, Hit[]>): Hit | null {
  const caret = caretAt(x, y);
  if (!caret) return null;

  const hits = byNode.get(caret.node);
  if (!hits) return null;

  for (const hit of hits) {
    // isPointInRange handles ranges spanning several nodes, which matters now
    // that a match can be assembled from multiple inline runs. The geometry
    // check is still needed because the caret snaps to the nearest position.
    if (hit.range.isPointInRange(caret.node, caret.offset) && containsPoint(hit.range, x, y)) {
      return hit;
    }
  }
  return null;
}

function caretAt(x: number, y: number): { node: Text; offset: number } | null {
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

/**
 * Walks the document, grouping consecutive inline text runs into segments and
 * breaking at every block-level element.
 *
 * The break is the safety property: without it, a paragraph ending in "EIP"
 * followed by one starting with "7702" would read as a reference.
 */
function collectSegments(tooltipHost: Element | null): Array<Segment<Text>> {
  const segments: Array<Segment<Text>> = [];
  let runs: Array<{ node: Text; text: string }> = [];

  const flush = () => {
    if (runs.length === 0) return;
    const segment = buildSegment(runs);
    runs = [];
    // Rejection happens after joining, not per node: when a site splits a
    // reference, the run holding "EIP" contains no digit at all, so a per-node
    // digit filter would discard exactly the runs that need joining.
    if (/\d/.test(segment.text)) segments.push(segment);
  };

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          // Editing surfaces: painting into them is harmless, but highlights
          // interact badly with carets and selections, and appearing to
          // corrupt someone's draft is not worth the coverage.
          if (el instanceof HTMLElement && el.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (tooltipHost && (tooltipHost === el || tooltipHost.contains(el))) {
            return NodeFilter.FILTER_REJECT;
          }
          // Block elements are visited only to mark a boundary; inline ones are
          // transparent, so their text joins the surrounding run.
          return BLOCK_TAGS.has(el.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    },
  );

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) flush();
    else runs.push({ node: node as Text, text: node.nodeValue ?? '' });
  }
  flush();
  return segments;
}

function matchSegments(
  segments: Array<Segment<Text>>,
  allowBare: boolean,
): Array<{ segment: Segment<Text>; match: Match }> {
  const out: Array<{ segment: Segment<Text>; match: Match }> = [];
  for (const segment of segments) {
    for (const match of findMatches(segment.text, { isValid: isValidNumber, allowBare })) {
      if (alreadyLinked(segment, match)) continue;
      out.push({ segment, match });
    }
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/**
 * Whether this reference is already a link to the proposal itself, in which
 * case decorating it adds nothing. Common on eips.ethereum.org and in rendered
 * markdown.
 *
 * The host check matters: X links "#EIP7702" to its own hashtag page, whose
 * href contains "EIP7702" but has nothing to do with the spec. Matching on the
 * number alone would silently skip every hashtagged reference.
 */
function alreadyLinked(segment: Segment<Text>, match: Match): boolean {
  const start = locate(segment, match.start);
  const anchor = start?.node.parentElement?.closest('a[href]') as HTMLAnchorElement | null;
  const href = anchor?.getAttribute('href');
  if (!href) return false;

  try {
    const url = new URL(href, location.href);
    if (!SPEC_HOSTS.test(url.hostname)) return false;
    const rest = `${url.pathname}${url.search}${url.hash}`;
    return new RegExp(`(?:eip|erc)[-_]?${match.n}(?:\\D|$)`, 'i').test(rest);
  } catch {
    return false;
  }
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
