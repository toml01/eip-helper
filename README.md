# EIP Helper

A Chrome extension that annotates EIP/ERC references on any page. It highlights
references like `EIP-7702` and, on hover, shows the full title, status, and links
to the spec, forum discussion, and source.

> EIP-7702 → **EIP-7702** · Final · Core — Set Code for EOAs

Covers all **1189** proposals across `ethereum/EIPs` and `ethereum/ERCs`,
bundled with the extension. **No network requests are made while you browse**,
and the extension requests no host permissions.

## Install (development)

```sh
npm install
npm run build
```

Then load `.output/chrome-mv3` via `chrome://extensions` → Developer mode →
**Load unpacked**.

## How it works

### Highlighting without touching the page

References are painted with the [CSS Custom Highlight API][highlight], not by
wrapping matches in `<span>` elements:

```js
CSS.highlights.set('eip-ref', new Highlight(...ranges));
```

```css
::highlight(eip-ref) { text-decoration: underline dotted; }
```

Span wrapping is the conventional approach and the usual reason extensions break
web apps — it corrupts React/Vue reconciliation, breaks `contenteditable`,
invalidates the page's own `querySelector` logic, and risks MutationObserver
feedback loops. Painting mutates nothing. The e2e suite asserts that
`document.body.innerHTML` is **byte-identical** before and after the content
script runs.

Two constraints follow, both accepted deliberately:

- `::highlight()` accepts only a small property set (`color`,
  `background-color`, `text-decoration`, `text-shadow`, `-webkit-text-stroke`) —
  no `cursor`, no borders, nothing affecting layout. The affordance is therefore
  a dotted underline and an optional tint.
- Highlights are not DOM nodes, so they cannot be focused or receive events.
  See [Known limitations](#known-limitations).

### Hover hit-testing

Hover resolves the caret position under the pointer and confirms it against the
range's own painted rects, using `document.caretPositionFromPoint` (falling back
to `caretRangeFromPoint`).

It deliberately does **not** use `CSS.highlights.highlightsFromPoint`, which is
the purpose-built API for this. That API is Chrome 135+ only, and during
development it was observed **present but always returning an empty array** in a
current Chromium build (Brave 151) — including for a highlight created in the
same world in the same frame. Depending on it would silently disable hover
entirely on affected browsers. The caret approach relies only on long-standing
APIs and behaves identically everywhere.

### Matching

Two tiers, because the number space overlaps ordinary prose badly.

**Tier 1 — prefixed, always on.** `EIP-7702`, `EIP 7702`, `EIP7702`, `EIP_7702`,
`EIP:7702`, en/em-dash variants, and `ERC-20`. Also handles two forms a naive
prefix regex misses:

- the **plural prefix** — `EIPs 3074`, `ERCs`, and `ERC-721s`
- **list continuations** — `EIPs 3074 and 7702`, `EIP-2718, 2930, 4844`.
  Continuations require ≥3 digits, so `EIP-20 and 5 others` does not sweep up
  the quantity.

**Tier 2 — bare numbers, opt-in and off by default.** Matching a bare `7702` is
genuinely dangerous, and the number distribution shows why:

| Hazard | Count | Examples |
| --- | --- | --- |
| Plausible years | 34 | 2015, 2019, 2020, 2021, 2025, 2026 |
| Under 100 | 12 | 1, 2, 3, 20, 55, 67, 86 |
| Three-digit | 79 | 100, 150, 155, 200, 777, 999 |

A page saying "back in 2020" or "150 users" would light up. So when enabled, a
bare number must clear every one of these:

- 4–5 digits (removes the 91 proposals under 1000)
- the page looks Ethereum-related — a known host, or the page already contains
  an explicit prefixed reference
- not a year context (`in 2026`, `Q3 2026`, `March 2020`, `2024-2026`, `© 2026`)
- not currency, a percentage, or a counted quantity (`$7702`, `7702%`, `7702 users`)
- not part of a larger number (`1,7702`, `7702.5`, `77021`)
- not hex or a hyphenated identifier (`0x7702`, `build-7702-rc1`)
- resolves to a real proposal

### Shared number namespace

EIPs and ERCs share one number space, so a number identifies exactly one
proposal. Writing `EIP-4337` for what is canonically ERC-4337 therefore refers to
the right thing by the wrong name — the tooltip shows the canonical label and
notes *"Referenced as EIP-4337"* rather than treating it as a miss.

### Payload split

Pages with no references should cost nothing, so the data is split in two:

| | Size | Where |
| --- | --- | --- |
| Number index | ~7 KB | inlined in the content script, for instant rejection |
| Full metadata | 334 KB | background worker, fetched only after a match |

The content script injected into every page is **~20 KB**. Metadata travels over
`runtime.sendMessage` rather than `web_accessible_resources`, so there is no
fetchable extension URL for a page to probe for.

## The dataset

`data/eips.json` is generated and committed. Regenerate with:

```sh
npm run data:build
```

The **GitHub repos are the source of truth**, not `eips.ethereum.org`:

- The site is a Jekyll build *of* those repos, so it is downstream by
  construction and cannot be fresher.
- Its `/all` index carries only number, title, and author — `discussions-to` and
  per-proposal `description` appear **zero** times, and the tooltip needs both.
- Its Atom feed is empty boilerplate: `jekyll-feed` renders `site.posts`, but
  proposals are Jekyll *pages*, so the feed contains no `<entry>` elements at
  all.

Frontmatter is parsed with `js-yaml` rather than by splitting lines, because 16
titles are YAML-quoted to escape an embedded colon
(`title: "Hardfork Meta: Homestead"`) and a line parser ships the quotes into
the UI.

Deduplication: 365 of the 366 cross-repo overlaps are `status: Moved` stubs left
behind by the ERC split; the only real collision is EIP-1, resolved by preferring
the EIPs copy.

**The build validates itself against the published site** and fails on any
disagreement — number sets must match exactly in both directions, every title
must match, and no title may retain quote characters. Site cells are selected by
semantic class (`.eipnum`, `.title`) rather than column position, since the
column layout varies per status section (Last Call inserts *Review ends*,
Withdrawn inserts *Withdrawn Reason*).

## Development

```sh
npm run dev         # dev build with HMR
npm run build       # production build
npm test            # unit tests (matcher + dataset integrity)
npm run test:e2e    # drives a real browser; run `npm run build` first
npm run compile     # type-check
npm run data:build  # regenerate the dataset
```

`npm run test:e2e` exists because the load-bearing behaviour cannot be tested in
jsdom: the highlight API, caret hit-testing, and the no-DOM-mutation guarantee.
It auto-detects a Chromium-based browser; set `CHROME_PATH` to override.

## Permissions

`storage` only — for settings. No host permissions, no `tabs`, no
`web_accessible_resources`. The extension has no way to observe browsing.

## Known limitations

- **References split across inline elements are missed** — matching runs per text
  node, so `<b>EIP</b>-7702` does not match. Measured across 10 real pages and
  **1291 references, this cost exactly 1 match (0.08%)**: a `<b>`-wrapped search
  term on a DuckDuckGo results page. Notably GitHub's syntax-highlighted
  markdown view — 972 references on one page — splits nothing, because it keeps
  plain text runs in single nodes. Not worth fixing at that rate; see
  [Roadmap](#roadmap) for what fixing it would take.
- **No keyboard access to the tooltip.** Highlights are not DOM nodes and cannot
  take focus. Hover is pointer-only for now; a keyboard path is planned.
- **New content is decorated after a ~300 ms debounce**, so during fast
  continuous scrolling there is a brief window where fresh references are not yet
  underlined.
- **A very long non-virtualized feed can hit the 2000-match cap.** At the density
  measured below that is roughly 6000 posts. Feeds that drop offscreen nodes
  (Twitter, most modern timelines) stay well under it.
- **Chromium only.** `CSS.highlights` is needed for painting. A Firefox port is
  plausible since hover no longer depends on a Chrome-only API.
- **Data goes stale between releases**, by design — the dataset is bundled so
  that browsing triggers no network requests.

## Dynamic pages

Content added after load is picked up by a `MutationObserver` (debounced 300 ms,
then run in an idle callback). Measured on a synthetic timeline that appends 250
posts per batch:

| Feed | Posts | References | All highlighted | Latency | Scan cost |
| --- | --- | --- | --- | --- | --- |
| Growing | 2000 | 668 | yes | ~310 ms | ~2 ms |
| Virtualized | 400 (steady) | 134 | yes | ~1 ms | ~0.5 ms |

The rescan re-walks the whole document rather than just the mutated subtree,
which sounded expensive but measures at ~2 ms over 2000 text nodes — so
incremental rescanning is not worth the complexity yet.

## Roadmap

- Hotkey palette: fuzzy-search proposals by topic and insert the reference at the
  cursor
- Cross-element matching, if search-results pages ever matter: group consecutive
  text nodes within each leaf block into one string, keeping an
  offset → (node, offset) map so matches can be translated back into Ranges
  (which may span nodes). Must not flatten across block boundaries, or
  `…the EIP.` + `7702 is…` in adjacent paragraphs would falsely join. Roughly one
  module plus tests
- New-activity hints for discussions (needs host permissions — a deliberate,
  separate opt-in)
- Related-proposal graph from the `requires` field, already captured in the data

## License

MIT

[highlight]: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
