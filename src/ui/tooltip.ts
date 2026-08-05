import { lookup } from '../core/dataset';
import { linksFor, statusLine } from '../core/links';
import { canonicalLabel, isKindMismatch } from '../core/match';
import type { Match } from '../core/types';

const MARGIN = 8;
const MAX_WIDTH = 340;

/**
 * The hover card. Lives in a closed shadow root so that page CSS cannot reach
 * in and extension CSS cannot leak out -- the host also gets `all: initial` to
 * cut off inherited properties, which shadow boundaries do not block.
 */
export class Tooltip {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private card: HTMLDivElement | null = null;
  private hideTimer: number | undefined;
  private pointerInside = false;
  private visible = false;
  /**
   * Incremented by every show/hide request. `show` has to await a metadata
   * lookup, and without a generation check a slow lookup could resurrect a
   * tooltip the pointer had already left, or a pending hide could fire after a
   * newer show. Both were observed as flaky hover behaviour.
   */
  private generation = 0;

  get hostElement(): Element | null {
    return this.host;
  }

  owns(node: Node): boolean {
    return !!this.host && (this.host === node || this.host.contains(node));
  }

  isVisible(): boolean {
    return this.visible;
  }

  isPointerInside(): boolean {
    return this.pointerInside;
  }

  async show(match: Match, anchor: DOMRect): Promise<void> {
    // Cancel any pending hide up front, before the await -- otherwise a hide
    // scheduled just before this call can fire while the lookup is in flight.
    window.clearTimeout(this.hideTimer);
    const generation = ++this.generation;

    const meta = (await lookup([match.n])).get(match.n);
    // A hide or a different show happened while the lookup was in flight.
    if (!meta || generation !== this.generation) return;

    const { card } = this.ensure();

    const label = canonicalLabel(meta.n, meta.k);
    const mismatch = isKindMismatch(match, meta.k);

    card.textContent = '';
    card.append(
      el('div', 'head', [
        el('span', 'label', label),
        el('span', 'status', statusLine(meta)),
      ]),
      el('div', 'title', meta.t),
    );
    // Present for ~74% of proposals.
    if (meta.d) card.append(el('div', 'desc', meta.d));
    if (mismatch) {
      card.append(
        el('div', 'note', `Referenced as ${match.writtenKind?.toUpperCase()}-${meta.n}`),
      );
    }

    const links = el('div', 'links');
    for (const link of linksFor(meta)) {
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      links.append(a);
    }
    card.append(links);

    this.visible = true;
    this.host!.style.visibility = 'hidden';
    this.host!.style.display = 'block';
    this.position(anchor);
    this.host!.style.visibility = 'visible';
  }

  hide(delayMs: number): void {
    window.clearTimeout(this.hideTimer);
    // Invalidates any show() currently awaiting its lookup.
    const generation = ++this.generation;
    const run = () => {
      // A newer show() superseded this hide while it was pending.
      if (this.pointerInside || generation !== this.generation) return;
      this.visible = false;
      if (this.host) this.host.style.display = 'none';
    };
    if (delayMs <= 0) run();
    else this.hideTimer = window.setTimeout(run, delayMs);
  }

  /** Flips above the anchor when there is no room below, and clamps to the viewport. */
  private position(anchor: DOMRect): void {
    const host = this.host!;
    const card = this.card!;
    const { width, height } = card.getBoundingClientRect();

    const below = anchor.bottom + MARGIN;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - height - MARGIN);

    const left = Math.min(
      Math.max(MARGIN, anchor.left),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    );

    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  }

  private ensure(): { card: HTMLDivElement } {
    if (this.card) return { card: this.card };

    const host = document.createElement('div');
    // `all: initial` first, then the properties this element actually needs --
    // later declarations win, and inherited page styles are cut off.
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; display: none;';
    this.host = host;

    const root = host.attachShadow({ mode: 'closed' });
    this.root = root;

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.append(style);

    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'tooltip');
    root.append(card);
    this.card = card;

    // Let the pointer travel into the card to click a link without it closing.
    card.addEventListener('mouseenter', () => {
      this.pointerInside = true;
      window.clearTimeout(this.hideTimer);
    });
    card.addEventListener('mouseleave', () => {
      this.pointerInside = false;
      this.hide(120);
    });

    document.body.append(host);
    return { card };
  }
}

function el(tag: string, cls: string, content?: string | Node[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (typeof content === 'string') node.textContent = content;
  else if (content) node.append(...content);
  return node;
}

const CSS_TEXT = `
  :host { all: initial; }
  .card {
    box-sizing: border-box;
    max-width: ${MAX_WIDTH}px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgb(0 0 0 / 0.1);
    background: #fff;
    color: #1a1a1a;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.13);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-align: left;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 3px;
  }
  .label { font-weight: 650; letter-spacing: 0.01em; }
  .status { font-size: 11px; color: #666; }
  .title { font-weight: 550; }
  .desc { margin-top: 5px; color: #444; font-size: 12px; }
  .note { margin-top: 6px; font-size: 11px; color: #8a6d00; }
  .links {
    display: flex;
    gap: 12px;
    margin-top: 9px;
    padding-top: 8px;
    border-top: 1px solid rgb(0 0 0 / 0.08);
  }
  .links a {
    color: #4f46e5;
    text-decoration: none;
    font-size: 12px;
    font-weight: 500;
  }
  .links a:hover { text-decoration: underline; }

  @media (prefers-color-scheme: dark) {
    .card {
      background: #1f2023;
      color: #e8e8ea;
      border-color: rgb(255 255 255 / 0.12);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.45);
    }
    .status { color: #9a9aa2; }
    .desc { color: #b8b8c0; }
    .note { color: #d9b64f; }
    .links { border-top-color: rgb(255 255 255 / 0.1); }
    .links a { color: #9b91ff; }
  }
`;
