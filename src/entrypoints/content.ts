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

/**
 * `highlightsFromPoint` is not in the DOM typings yet. It shipped in Chrome 135
 * and returns the highlights painted at a viewport point.
 */
interface HighlightRegistryWithHitTest {
  highlightsFromPoint(
    x: number,
    y: number,
    options?: { shadowRoots?: ShadowRoot[] },
  ): Array<{ highlight: Highlight; ranges: AbstractRange[] }>;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    // Paint-only highlighting is the whole reason this extension can run on
    // <all_urls> safely. Without it, the alternative would be wrapping matches
    // in <span>s, which corrupts React reconciliation and contenteditable.
    const registry = CSS?.highlights as unknown as
      | (HighlightRegistry & HighlightRegistryWithHitTest)
      | undefined;
    if (!registry || typeof registry.highlightsFromPoint !== 'function') return;

    void start(registry);
  },
});

async function start(registry: HighlightRegistry & HighlightRegistryWithHitTest) {
  let settings = await getSettings();
  const tooltip = new Tooltip();

  /** Range identity is how a hovered highlight maps back to a proposal. */
  let ranges = new Map<Range, Match>();
  let observer: MutationObserver | null = null;
  let rescanTimer: number | undefined;

  const clear = () => {
    registry.delete(HIGHLIGHT_NAME);
    ranges = new Map();
    tooltip.hide(0);
  };

  const scan = () => {
    ranges = new Map();
    if (!isSiteEnabled(settings, location.hostname)) {
      registry.delete(HIGHLIGHT_NAME);
      return;
    }

    const nodes = collectTextNodes(tooltip.hostElement);

    // Tier 1 first, so that "does this page discuss Ethereum at all?" is
    // answered before deciding whether bare numbers are plausible.
    const firstPass = matchNodes(nodes, { allowBare: false });
    const allowBare =
      settings.bareNumbers && isEthContext(location.hostname, firstPass.length > 0);
    const found = allowBare ? matchNodes(nodes, { allowBare: true }) : firstPass;

    if (found.length === 0) {
      registry.delete(HIGHLIGHT_NAME);
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
        continue; // Node changed under us; the next rescan will pick it up.
      }
      ranges.set(range, match);
      rangeList.push(range);
    }

    registry.set(HIGHLIGHT_NAME, new Highlight(...rangeList));

    // Warm the metadata cache for what is actually on screen, so the first
    // hover has no latency. Pages with no matches never trigger this.
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
      // to its own mutations would be an infinite rescan loop.
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
        if (ranges.size === 0) return;

        const hit = registry
          .highlightsFromPoint(e.clientX, e.clientY)
          .find((h) => h.highlight === registry.get(HIGHLIGHT_NAME));

        const range = hit?.ranges[0] as Range | undefined;
        const match = range ? resolve(ranges, range) : undefined;

        if (!match) {
          if (active && !tooltip.isPointerInside()) {
            active = null;
            window.clearTimeout(dwellTimer);
            tooltip.hide(HOVER_GRACE_MS);
          }
          return;
        }

        if (active?.n === match.n && tooltip.isVisible()) return;
        active = match;
        window.clearTimeout(dwellTimer);
        dwellTimer = window.setTimeout(() => {
          void tooltip.show(match, range!.getBoundingClientRect());
        }, HOVER_DWELL_MS);
      });
    },
    { passive: true },
  );

  // A highlight is not a DOM node, so it cannot receive focus or scroll events.
  // Hide on scroll rather than trying to keep a stale rect in sync.
  window.addEventListener('scroll', () => tooltip.hide(0), { passive: true, capture: true });

  onSettingsChanged((next: Settings) => {
    settings = next;
    injectStyle(settings);
    clear();
    scan();
  });

  injectStyle(settings);
  scan();
  observe();
}

/**
 * Maps a hovered range back to its match. Identity holds in practice, since the
 * registry hands back the same Range objects that were registered, but boundary
 * comparison is a cheap guarantee against that changing.
 */
function resolve(ranges: Map<Range, Match>, hovered: Range): Match | undefined {
  const direct = ranges.get(hovered);
  if (direct) return direct;
  for (const [range, match] of ranges) {
    if (
      range.startContainer === hovered.startContainer &&
      range.startOffset === hovered.startOffset &&
      range.endOffset === hovered.endOffset
    ) {
      return match;
    }
  }
  return undefined;
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
        // interact badly with carets and selections, and the risk of appearing
        // to corrupt a user's draft is not worth the coverage.
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

  // Highlight pseudo-elements accept only a small set of properties (color,
  // background-color, text-decoration, text-shadow, -webkit-text-stroke) --
  // no cursor, no border, nothing that affects layout. So the affordance has
  // to be carried by decoration and tint alone.
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
  // document that owns the highlighted ranges, not the extension's shadow root.
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) {\n    ${body}\n  }`;
  document.head.append(style);
}
