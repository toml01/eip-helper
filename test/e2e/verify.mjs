/**
 * End-to-end verification of the built extension in a real Chromium browser.
 *
 * This exists because the load-bearing parts of this extension cannot be
 * tested in jsdom: the CSS Custom Highlight API, caret hit-testing, and the
 * claim that the page DOM is never mutated. Run `npm run build` first.
 *
 * Set CHROME_PATH to point at a specific Chromium binary.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, '../../.output/chrome-mv3');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('No Chromium-based browser found. Set CHROME_PATH.');
  process.exit(1);
}
if (!existsSync(EXT)) {
  console.error(`Build output missing at ${EXT}. Run "npm run build" first.`);
  process.exit(1);
}

// Serve the fixture over http: content scripts do not run on file:// URLs
// unless the extension is granted file access.
const fixture = await readFile(path.join(HERE, 'fixture.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

console.log(`browser: ${BROWSER}\nfixture: ${URL}\n`);

/** Drops the tooltip's inlined <style> text so the log stays readable. */
const summarize = (text) =>
  (text || '(empty)')
    .split(' | ')
    .filter((part) => !part.includes('{'))
    .join(' | ') || '(empty)';

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Capture the pristine DOM before the content script runs.
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const domBefore = await page.evaluate(() => document.body.innerHTML);

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500)); // document_idle + first scan

  // --- 1. the APIs this design depends on -------------------------------
  const api = await page.evaluate(() => ({
    highlights: !!CSS?.highlights && typeof Highlight !== 'undefined',
    caret:
      typeof document.caretPositionFromPoint === 'function' ||
      typeof document.caretRangeFromPoint === 'function',
    // Present but non-functional in this build -- recorded, not required.
    hitTestApi: typeof CSS?.highlights?.highlightsFromPoint === 'function',
  }));
  check('CSS Custom Highlight API available', api.highlights);
  check('caret hit-testing available', api.caret);
  console.log(`      (highlightsFromPoint present: ${api.hitTestApi})`);

  // --- 2. highlights registered ----------------------------------------
  const hl = await page.evaluate(() => {
    const h = CSS.highlights.get('eip-ref');
    if (!h) return null;
    return [...h].map((r) => r.toString());
  });
  check('highlight registered', Array.isArray(hl) && hl.length > 0, `${hl?.length ?? 0} ranges`);

  const texts = hl ?? [];
  const has = (t) => texts.includes(t);

  // --- 3. Tier 1 forms --------------------------------------------------
  check('matches EIP-7702', has('EIP-7702'));
  check('matches EIP-2718', has('EIP-2718'));
  check('matches EIP7702 (no separator)', has('EIP7702'));
  check('matches "eip 7702" (space)', has('eip 7702'));
  check('matches ERC-20', has('ERC-20'));
  check('matches ERC-4337 written as EIP-4337', has('EIP-4337'));

  // Plural prefix + list continuation: "EIPs 3074 and 7702"
  check('matches plural prefix "EIPs 3074"', has('EIPs 3074') || has('EIPs 3074'.trim()));
  check(
    'matches list continuation (bare 7702 after "and")',
    texts.filter((t) => t === '7702').length >= 1,
    `${texts.filter((t) => t === '7702').length} bare 7702`,
  );
  // "ERC721s" -- trailing plural trimmed off the highlight
  check('trims trailing plural (ERC721 not ERC721s)', has('ERC721') && !has('ERC721s'));

  // --- 4. false positives NOT highlighted -------------------------------
  const scoped = async (sel) =>
    page.evaluate((s) => {
      const h = CSS.highlights.get('eip-ref');
      if (!h) return [];
      const el = document.querySelector(s);
      return [...h]
        .filter((r) => el.contains(r.startContainer))
        .map((r) => r.toString());
    }, sel);

  check('bare number not matched by default', (await scoped('#bare')).length === 0);
  check('years never matched', (await scoped('#years')).length === 0, JSON.stringify(await scoped('#years')));
  check('currency/quantities not matched', (await scoped('#amounts')).length === 0, JSON.stringify(await scoped('#amounts')));
  check('slugs and hex not matched', (await scoped('#slug')).length === 0, JSON.stringify(await scoped('#slug')));
  check('already-linked reference not decorated', (await scoped('#alreadylinked')).length === 0);
  check('contenteditable skipped', (await scoped('#editable')).length === 0);

  // --- 5. the core claim: no DOM mutation -------------------------------
  const domAfter = await page.evaluate(() => {
    // Exclude the extension's own tooltip host, the one element it adds.
    const clone = document.body.cloneNode(true);
    for (const child of [...clone.children]) {
      if (child.tagName === 'DIV' && child.getAttribute('style')?.includes('2147483647')) {
        child.remove();
      }
    }
    return clone.innerHTML;
  });
  check(
    'page DOM is byte-identical (no span wrapping)',
    domBefore === domAfter,
    domBefore === domAfter ? '' : 'DOM changed!',
  );

  // --- 6. hover shows the tooltip with real metadata --------------------
  const rect = await page.evaluate(() => {
    const h = CSS.highlights.get('eip-ref');
    const range = [...h].find((r) => r.toString() === 'EIP-7702');
    const b = range.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  // `steps` emits a stream of mousemove events, the way a real pointer does.
  const hover = async (pt) => {
    await page.mouse.move(pt.x - 60, pt.y, { steps: 3 });
    await page.mouse.move(pt.x, pt.y, { steps: 6 });
  };
  await hover(rect);

  // The tooltip lives in a CLOSED shadow root, so JS in the page cannot reach
  // it. Pierce it over CDP instead.
  const cdp = await page.createCDPSession();
  // Collect text from INSIDE shadow roots only -- collecting the whole document
  // would match the fixture's own page text and pass vacuously.
  const collect = (node, out = [], inShadow = false) => {
    if (inShadow && node.nodeValue?.trim()) out.push(node.nodeValue.trim());
    for (const c of node.children ?? []) collect(c, out, inShadow);
    for (const s of node.shadowRoots ?? []) collect(s, out, true);
    return out;
  };
  const shadowOf = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    return collect(root).join(' | ');
  };
  /** Polls rather than sleeping a fixed time, so the check is not timing-fragile. */
  const waitForTooltip = async (needle, ms = 4000) => {
    const deadline = Date.now() + ms;
    let last = '';
    while (Date.now() < deadline) {
      last = await shadowOf();
      if (last.includes(needle)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  };

  const shadowText = await waitForTooltip('Set Code for EOAs');
  console.log(`      tooltip: ${summarize(shadowText)}`);

  check(
    'tooltip shows canonical label',
    shadowText.includes('EIP-7702') && shadowText.includes('Set Code for EOAs'),
  );
  check('tooltip shows the title', shadowText.includes('Set Code for EOAs'));
  check('tooltip shows status and category', shadowText.includes('Final') && shadowText.includes('Core'));
  check('tooltip shows links', ['Spec', 'Discussion', 'Source'].every((l) => shadowText.includes(l)));

  // --- 7. EIP/ERC mix-up note ------------------------------------------
  const r4337 = await page.evaluate(() => {
    const h = CSS.highlights.get('eip-ref');
    const range = [...h].find((r) => r.toString() === 'EIP-4337');
    const b = range.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await hover(r4337);
  const t2 = await waitForTooltip('Referenced as EIP-4337');
  console.log(`      tooltip: ${summarize(t2)}`);
  check('EIP-4337 resolves to canonical ERC-4337', t2.includes('ERC-4337'));
  check('notes the EIP/ERC mix-up', t2.includes('Referenced as EIP-4337'));

  // --- 8. rescan after client-side render ------------------------------
  await page.evaluate(() => window.addLate());
  await new Promise((r) => setTimeout(r, 1200));
  const late = await scoped('#lateref');
  check('rescans DOM added later (MutationObserver)', late.includes('EIP-1559'), JSON.stringify(late));

  await page.screenshot({ path: path.join(HERE, 'fixture-shot.png') });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
