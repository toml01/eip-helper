/**
 * Finding EIP/ERC references in plain text.
 *
 * Pure string functions -- no DOM -- so the tricky parts are unit-testable.
 *
 * Two tiers:
 *   Tier 1  explicit prefix ("EIP-7702", "ERC 20", "EIPs 3074 and 7702").
 *           Unambiguous, always on.
 *   Tier 2  bare numbers ("7702"). Opt-in and heavily gated, because the
 *           number space overlaps ordinary prose badly: 34 proposals are
 *           plausible years (including 2015, 2019-2021, 2025, 2026) and 91
 *           are under 1000 (1, 2, 20, 100, 150, 999...).
 */
import type { Match } from './types';

/**
 * Prefixed reference. Notes on the pieces:
 *   \b(eip|erc)s?   - the optional plural matters; "EIPs 3074" and "ERCs" are
 *                     common in prose, and without it the prefix is missed.
 *   [\s]*[-–—_:]?[\s]*
 *                   - covers "EIP-7702", "EIP 7702", "EIP7702", "EIP - 7702".
 *                     Deliberately excludes "." so that a sentence boundary
 *                     ("...the EIP. 7702 is...") is not read as a reference.
 *   (\d{1,5})s?\b   - the optional trailing plural lets "ERC-721s" match.
 */
const PREFIXED = /\b(eip|erc)s?[ \t]*[-–—_:]?[ \t]*(\d{1,5})s?\b/gi;

/**
 * Continuation of a prefixed list: the "and 7702" in "EIPs 3074 and 7702".
 * Anchored to a Tier 1 match, so it inherits that match's certainty.
 *
 * Continuations require >=3 digits. Without that, "EIP-20 and 5 others" would
 * pick up 5 (a real EIP) from an ordinary quantity.
 */
const CONTINUATION = /^([ \t]*(?:,|and|&|\/|\+)[ \t]*)(\d{3,5})s?\b/i;

/** Bare number: 4-5 digits only. Excluding <=999 removes the noisiest 91. */
const BARE = /\b(\d{4,5})\b/g;

/** Words that mark a following 4-digit number as a year rather than a proposal. */
const YEAR_LEAD =
  /(?:^|[\s(])(?:in|since|by|during|until|till|through|after|before|from|circa|c\.|ca\.|around|about|early|mid|late|spring|summer|autumn|fall|winter|q[1-4]|fy|©|copyright|version|ver|v)[\s.]*$/i;

const MONTHS =
  /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s.,]*$/i;

/** Currency symbols and unit words that mark a number as an amount. */
const CURRENCY_LEAD = /[$€£¥₪]\s*$/;
/** Kept separate from the word units below: \b does not apply after "%". */
const PERCENT_TRAIL = /^\s*%/;
const UNIT_TRAIL =
  /^\s*(?:usd|eur|gbp|eth|btc|wei|gwei|szabo|finney|tokens?|coins?|nft|px|em|rem|ms|kb|mb|gb|tb|bytes?|blocks?|txs?|users?|people|times|years?|months?|days?|hours?|min(?:ute)?s?|sec(?:ond)?s?)\b/i;

const HOSTS = [
  'eips.ethereum.org',
  'ercs.ethereum.org',
  'ethereum-magicians.org',
  'ethresear.ch',
  'ethereum.org',
  'blog.ethereum.org',
  'notes.ethereum.org',
  'hackmd.io',
  'forum.openzeppelin.com',
  'ethereum.stackexchange.com',
];

/**
 * Whether bare numbers are plausible on this page at all. Either the host is
 * one where proposal numbers are the dominant meaning of a 4-digit number, or
 * the page has already proven itself by containing an explicit reference.
 */
export function isEthContext(hostname: string, hasPrefixedMatch: boolean): boolean {
  if (hasPrefixedMatch) return true;
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

export interface FindOptions {
  /** Rejects any number not in the dataset. */
  isValid: (n: number) => boolean;
  /** Enables Tier 2. Requires both the user setting and page context. */
  allowBare?: boolean;
}

/** Finds all references in a single run of text, ordered and non-overlapping. */
export function findMatches(text: string, opts: FindOptions): Match[] {
  const matches: Match[] = [];
  const claimed: Array<[number, number]> = [];

  const claim = (start: number, end: number) => {
    claimed.push([start, end]);
  };
  const isClaimed = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  // -- Tier 1 -------------------------------------------------------------
  PREFIXED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PREFIXED.exec(text)) !== null) {
    const kind = m[1]!.toLowerCase() as 'eip' | 'erc';
    const n = Number(m[2]);
    // The matched slice may include a trailing plural "s" that is not part of
    // the number; trim back to the last digit so the highlight ends cleanly.
    const digitsEnd = m.index + m[0].replace(/s$/i, '').length;

    if (!opts.isValid(n)) continue;
    matches.push({
      start: m.index,
      end: digitsEnd,
      n,
      text: text.slice(m.index, digitsEnd),
      writtenKind: kind,
    });
    claim(m.index, digitsEnd);

    // Walk any "and 7702, 3074" tail that follows.
    let cursor = digitsEnd;
    for (;;) {
      const tail = CONTINUATION.exec(text.slice(cursor));
      if (!tail) break;
      const num = Number(tail[2]);
      const numStart = cursor + tail[1]!.length;
      const numEnd = numStart + tail[2]!.length;
      if (!opts.isValid(num)) break;
      matches.push({
        start: numStart,
        end: numEnd,
        n: num,
        text: text.slice(numStart, numEnd),
        // Written bare, but licensed by the prefix that introduced the list.
        writtenKind: kind,
      });
      claim(numStart, numEnd);
      cursor = numEnd;
    }
    PREFIXED.lastIndex = Math.max(PREFIXED.lastIndex, cursor);
  }

  // -- Tier 2 -------------------------------------------------------------
  if (opts.allowBare) {
    BARE.lastIndex = 0;
    while ((m = BARE.exec(text)) !== null) {
      const n = Number(m[1]);
      const start = m.index;
      const end = start + m[1]!.length;
      if (isClaimed(start, end)) continue;
      if (!opts.isValid(n)) continue;
      if (!bareLooksLikeProposal(text, start, end)) continue;
      matches.push({ start, end, n, text: m[1]!, writtenKind: null });
      claim(start, end);
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Rejects bare numbers whose surroundings say "this is a year, an amount, or
 * part of a larger number" rather than "this is a proposal".
 */
export function bareLooksLikeProposal(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end, end + 24);

  // Part of a larger number: "1,7702", "3.7702", "7702.5", "12,7702,1".
  if (/[\d][.,]$/.test(before)) return false;
  if (/^[.,][\d]/.test(after)) return false;
  // Hyphenated numeric range, which for 4-digit numbers is nearly always years
  // or a numeric span: "2024 - 2026", "7702 - 7710".
  if (/[\d]\s*[-–—]\s*$/.test(before)) return false;
  if (/^\s*[-–—]\s*[\d]{4}\b/.test(after)) return false;
  // Hyphen-joined identifier or slug: "build-7702-rc1", "v2-7702", "7702-rc1".
  // This also rejects prose like "pre-7702 behaviour", which is a genuine
  // reference -- but Tier 2 is opt-in, so under-matching is the safer error.
  if (/[A-Za-z0-9]-$/.test(before)) return false;
  if (/^-[A-Za-z0-9]/.test(after)) return false;
  // Date shapes: "2024/05/07", "05/2024".
  if (/[\d]\s*\/\s*$/.test(before)) return false;
  if (/^\s*\/\s*[\d]/.test(after)) return false;

  if (CURRENCY_LEAD.test(before)) return false;
  if (PERCENT_TRAIL.test(after)) return false;
  if (UNIT_TRAIL.test(after)) return false;
  if (MONTHS.test(before)) return false;
  if (YEAR_LEAD.test(before)) return false;

  // A bare 19xx/20xx with nothing marking it as a proposal is far more likely
  // a year. Require an explicit prefix for those.
  const n = Number(text.slice(start, end));
  if (n >= 1900 && n <= 2100) return false;

  return true;
}

/**
 * Canonical display label. Because EIPs and ERCs share one number space, a
 * number identifies exactly one proposal -- so someone writing "EIP-4337" for
 * what is canonically ERC-4337 is referring to the right thing by the wrong
 * name. Worth showing gently rather than treating as a miss.
 */
export function canonicalLabel(n: number, kind: 'eip' | 'erc'): string {
  return `${kind.toUpperCase()}-${n}`;
}

export function isKindMismatch(match: Match, actual: 'eip' | 'erc'): boolean {
  return match.writtenKind !== null && match.writtenKind !== actual;
}
