/**
 * Regenerates data/eips.json from the upstream EIP and ERC repositories.
 *
 * Run with `npm run data:build`. The output is committed so that normal builds
 * are reproducible and work offline.
 *
 * Source-of-truth note: eips.ethereum.org is a Jekyll build *of* these repos,
 * so it is downstream by construction and cannot be fresher. Its `/all` index
 * also omits `discussions-to` and per-proposal `description` entirely, and its
 * Atom feed is empty boilerplate (jekyll-feed over `site.posts`, but EIPs are
 * pages). So the repos are the source -- and the rendered site is used purely
 * as an independent validator at the end of this script.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import yaml from 'js-yaml';

const exec = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT_JSON = path.join(ROOT, 'data', 'eips.json');
const OUT_NUMBERS = path.join(ROOT, 'src', 'core', 'numbers.generated.ts');

const SOURCES = [
  // ERCs first, so that the EIPs copy wins the sole real cross-repo collision
  // (EIP-1 exists in both). Later writes overwrite earlier ones.
  { repo: 'ERCs', tarDir: 'ERCs-master', subdir: 'ERCS', kind: 'erc' as const },
  { repo: 'EIPs', tarDir: 'EIPs-master', subdir: 'EIPS', kind: 'eip' as const },
];

/** A single proposal, with short keys to keep the bundled JSON small. */
export interface Proposal {
  n: number;
  /** title */ t: string;
  /** description (absent for ~26% of proposals) */ d: string;
  /** status */ s: string;
  /** type */ ty: string;
  /** category (absent for Meta/Informational) */ c: string;
  /** which repo it lives in -- determines the GitHub source link */ k: 'eip' | 'erc';
  /** discussions-to URL (absent for ~5%) */ disc: string;
  /** created date */ cr: string;
  /** requires */ req: number[];
}

interface Frontmatter {
  eip?: number | string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  category?: string;
  'discussions-to'?: string;
  created?: string | Date;
  requires?: number | string;
}

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

/**
 * Splits the YAML frontmatter block off a proposal markdown file.
 *
 * Deliberately parsed with js-yaml rather than line-splitting: 16 titles are
 * YAML-quoted because they contain a colon (`title: "Hardfork Meta: Homestead"`),
 * and long `author`/`description` values wrap across lines. A hand-rolled
 * parser silently keeps the quotes and ships them into the UI.
 */
function parseFrontmatter(raw: string): Frontmatter | null {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = raw.slice(3, end);
  try {
    const parsed = yaml.load(block, { schema: yaml.JSON_SCHEMA });
    return parsed && typeof parsed === 'object' ? (parsed as Frontmatter) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

async function collect(): Promise<Map<number, Proposal>> {
  await mkdir(CACHE, { recursive: true });
  const proposals = new Map<number, Proposal>();
  let movedStubs = 0;

  for (const { repo, tarDir, subdir, kind } of SOURCES) {
    const tarball = path.join(CACHE, `${repo}.tar.gz`);
    log(`  fetching ethereum/${repo}...`);
    await download(
      `https://codeload.github.com/ethereum/${repo}/tar.gz/refs/heads/master`,
      tarball,
    );

    // Extract only the proposals directory. An exact member prefix (not a glob)
    // keeps this working on both BSD tar (macOS) and GNU tar.
    await rm(path.join(CACHE, tarDir), { recursive: true, force: true });
    await exec('tar', ['-xzf', tarball, '-C', CACHE, `${tarDir}/${subdir}`]);

    const dir = path.join(CACHE, tarDir, subdir);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    let kept = 0;

    for (const file of files) {
      const fm = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'));
      if (!fm) {
        log(`    ! no parseable frontmatter: ${subdir}/${file}`);
        continue;
      }
      // 365 files are two-line "Moved" pointers left behind when application
      // standards were split out into the ERCs repo. They carry no metadata.
      if (str(fm.status) === 'Moved') {
        movedStubs++;
        continue;
      }
      const n = Number(fm.eip);
      if (!Number.isInteger(n) || n <= 0) {
        log(`    ! bad eip number in ${subdir}/${file}`);
        continue;
      }
      const title = str(fm.title);
      if (!title) {
        log(`    ! missing title in ${subdir}/${file}`);
        continue;
      }
      proposals.set(n, {
        n,
        t: title,
        d: str(fm.description),
        s: str(fm.status),
        ty: str(fm.type),
        c: str(fm.category),
        k: kind,
        disc: str(fm['discussions-to']),
        cr: str(fm.created),
        req: str(fm.requires)
          .split(/[,\s]+/)
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0),
      });
      kept++;
    }
    log(`    ${files.length} files -> ${kept} live proposals`);
  }

  log(`  skipped ${movedStubs} "Moved" stubs`);
  return proposals;
}

/** Numbers and titles as published on eips.ethereum.org, for cross-checking. */
async function fetchSiteIndex(): Promise<Map<number, string>> {
  const res = await fetch('https://eips.ethereum.org/all');
  if (!res.ok) throw new Error(`site index: HTTP ${res.status}`);
  const html = await res.text();
  const site = new Map<number, string>();

  // Select cells by their semantic class rather than by column position. The
  // column layout varies per status section -- Last Call inserts a "Review
  // ends" column and Withdrawn inserts a "Withdrawn Reason" column -- so
  // positional or shape-guessing parsers silently read the wrong field.
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    if (!row) continue;
    const num = /<td[^>]*class="[^"]*\beipnum\b[^"]*"[^>]*>[\s\S]*?\/EIPS\/eip-(\d+)/.exec(row);
    if (!num) continue;
    const title = /<td[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(row);
    if (!title) {
      throw new Error(`site row for eip-${num[1]} has no .title cell -- markup changed`);
    }
    site.set(Number(num[1]), stripHtml(title[1]!));
  }
  return site;
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    // Ampersand last, so an escaped entity does not get decoded twice.
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ');
}

/**
 * Cross-checks the parsed dataset against the published site and fails the
 * build on any disagreement. This is what stops an upstream schema or layout
 * change from silently shipping a broken or empty dataset.
 */
function validate(proposals: Map<number, Proposal>, site: Map<number, string>): string[] {
  const errors: string[] = [];
  const ours = new Set(proposals.keys());
  const theirs = new Set(site.keys());

  const missing = [...theirs].filter((n) => !ours.has(n)).sort((a, b) => a - b);
  const extra = [...ours].filter((n) => !theirs.has(n)).sort((a, b) => a - b);
  if (missing.length) errors.push(`on site but not parsed: ${missing.join(', ')}`);
  if (extra.length) errors.push(`parsed but not on site: ${extra.join(', ')}`);

  const mismatched: string[] = [];
  for (const [n, siteTitle] of site) {
    const ourTitle = proposals.get(n)?.t;
    if (ourTitle && stripHtml(ourTitle) !== siteTitle) {
      mismatched.push(`  eip-${n}: parsed ${JSON.stringify(ourTitle)} vs site ${JSON.stringify(siteTitle)}`);
    }
  }
  if (mismatched.length) {
    errors.push(`${mismatched.length} title mismatch(es):\n${mismatched.slice(0, 15).join('\n')}`);
  }

  // Regression guard for the YAML-quoting bug: a title must never retain the
  // quote characters that YAML used to escape an embedded colon.
  const quoted = [...proposals.values()].filter((p) => /^["']|["']$/.test(p.t));
  if (quoted.length) {
    errors.push(`titles with leftover quotes: ${quoted.map((p) => `eip-${p.n}`).join(', ')}`);
  }

  if (proposals.size < 1000) {
    errors.push(`implausibly few proposals: ${proposals.size}`);
  }
  return errors;
}

async function main() {
  log('Building EIP/ERC dataset');
  const proposals = await collect();

  log('  validating against eips.ethereum.org/all...');
  const site = await fetchSiteIndex();
  log(`    site lists ${site.size} proposals; parsed ${proposals.size}`);

  const errors = validate(proposals, site);
  if (errors.length) {
    process.stderr.write(`\nVALIDATION FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  log('    ok: sets match, titles match, no leftover quotes');

  const sorted = [...proposals.values()].sort((a, b) => a.n - b.n);
  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(sorted)}\n`);

  // A number-only index, inlined into the content script so that pages with no
  // EIP references never pull in the full metadata payload.
  await writeFile(
    OUT_NUMBERS,
    `// Generated by scripts/build-dataset.ts -- do not edit.\n` +
      `// Valid proposal numbers only. Kept separate from the metadata so the\n` +
      `// content script can reject candidate matches without loading it.\n` +
      `export const VALID_NUMBERS: readonly number[] = [\n` +
      `${chunk(sorted.map((p) => p.n))}\n];\n`,
  );

  const bytes = Buffer.byteLength(JSON.stringify(sorted));
  log(`  wrote data/eips.json (${sorted.length} proposals, ${(bytes / 1024).toFixed(1)} KB)`);
  log(`  wrote src/core/numbers.generated.ts`);
  await rm(CACHE, { recursive: true, force: true });
}

function chunk(nums: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < nums.length; i += 20) {
    lines.push(`  ${nums.slice(i, i + 20).join(', ')},`);
  }
  return lines.join('\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
