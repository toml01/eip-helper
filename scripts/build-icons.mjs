/**
 * Renders the extension icons and Chrome Web Store promo assets.
 *
 * Run with `npm run icons`. Outputs are committed, so this only needs running
 * when the mark changes.
 *
 * The mark is a Xi (three bars, Ethereum's symbol) sitting on a dotted
 * underline -- literally what the extension does to a page. The underline is
 * dropped below 48px, where it would just be mush.
 */
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const ICON_DIR = path.join(ROOT, 'src', 'public', 'icon');
const STORE_DIR = path.join(ROOT, 'store');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('No Chromium-based browser found. Set CHROME_PATH.');
  process.exit(1);
}

const INDIGO_DARK = '#4338ca';
const INDIGO = '#6366f1';

/**
 * The icon mark as standalone SVG.
 *
 * @param size    canvas size in px
 * @param inset   transparent padding. The store's 128px icon wants 96px of
 *                artwork centred in a 128px canvas, i.e. a 16px inset.
 * @param rule    draw the dotted underline (omit at small sizes)
 */
function markSvg(size, inset, rule) {
  const art = size - inset * 2;
  const s = (n) => (n * art) / 96 + inset; // coords authored against a 96 grid

  // Xi: three bars, outer two wider than the middle.
  const bar = (y, x1, x2, h) =>
    `<rect x="${s(x1)}" y="${s(y)}" width="${s(x2) - s(x1)}" height="${(h * art) / 96}" rx="${(h * art) / 96 / 2}" fill="#fff"/>`;

  const dots = rule
    ? `<line x1="${s(20)}" y1="${s(78)}" x2="${s(76)}" y2="${s(78)}"
         stroke="#c7d2fe" stroke-width="${(5 * art) / 96}" stroke-linecap="round"
         stroke-dasharray="${(2 * art) / 96} ${(7 * art) / 96}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${INDIGO}"/>
      <stop offset="1" stop-color="${INDIGO_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${art}" height="${art}" rx="${art * 0.22}" fill="url(#g)"/>
  ${bar(24, 18, 78, 11)}
  ${bar(45, 27, 69, 10)}
  ${bar(rule ? 62 : 65, 18, 78, 11)}
  ${dots}
</svg>`;
}

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--no-first-run', '--force-device-scale-factor=1'],
});

async function shoot(html, width, height, out, omitBackground = true) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden">${html}</body></html>`,
    { waitUntil: 'load' },
  );
  await page.screenshot({ path: out, omitBackground, type: 'png' });
  await page.close();
  console.log(`  ${path.relative(ROOT, out)}  ${width}x${height}`);
}

try {
  await mkdir(ICON_DIR, { recursive: true });
  await mkdir(STORE_DIR, { recursive: true });

  console.log('Extension icons');
  // 128 gets the store-mandated 16px transparent inset; toolbar sizes are
  // near-full-bleed so they stay legible when small.
  for (const [size, inset, rule] of [
    [16, 0, false],
    [32, 1, false],
    [48, 2, true],
    [128, 16, true],
  ]) {
    await shoot(markSvg(size, inset, rule), size, size, path.join(ICON_DIR, `${size}.png`));
  }

  // Keep the SVG source alongside the PNGs for future edits.
  await writeFile(path.join(STORE_DIR, 'icon.svg'), `${markSvg(128, 16, true)}\n`);

  console.log('Store assets');
  const tile = (w, h, titleSize, subSize, gap) => `
    <div style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;
                gap:${gap}px;background:linear-gradient(135deg,#eef2ff,#e0e7ff);
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">
      <div style="width:${h * 0.42}px;height:${h * 0.42}px;flex:none">${markSvg(h * 0.42, 0, true)}</div>
      <div>
        <div style="font-size:${titleSize}px;font-weight:680;color:#1e1b4b;letter-spacing:-0.02em">EIP Helper</div>
        <div style="font-size:${subSize}px;color:#4338ca;margin-top:${h * 0.02}px">
          Hover any <span style="text-decoration:underline dotted;text-decoration-color:#6366f1;
          text-underline-offset:3px">EIP-7702</span> for the full story
        </div>
      </div>
    </div>`;

  // Small promo tile is mandatory; marquee is optional but cheap to produce.
  await shoot(tile(440, 280, 40, 17, 20), 440, 280, path.join(STORE_DIR, 'promo-440x280.png'), false);
  await shoot(tile(1400, 560, 104, 44, 56), 1400, 560, path.join(STORE_DIR, 'promo-1400x560.png'), false);
} finally {
  await browser.close();
}
