import { isUnmerged, type Proposal } from './types';

export interface ProposalLink {
  label: string;
  url: string;
}

/**
 * eips.ethereum.org/EIPS/eip-{n} resolves for ERC-only proposals too (verified
 * against ERC-4337), so the canonical spec link needs no branch on kind. The
 * inverse is not true: eips.ethereum.org/ERCS/... is a 404.
 *
 * Only valid for merged proposals -- an unmerged number 404s on the site.
 */
export function specUrl(n: number): string {
  return `https://eips.ethereum.org/EIPS/eip-${n}`;
}

export function prUrl(p: Proposal): string {
  return `https://github.com/ethereum/${p.prRepo}/pull/${p.pr}`;
}

export function sourceUrl(p: Proposal): string {
  if (isUnmerged(p) && p.prHead && p.prRef) {
    // Pin to the head commit so the link keeps working as the PR moves on.
    const dir = p.prRepo === 'ERCs' ? 'ERCS' : 'EIPS';
    const file = p.prRepo === 'ERCs' ? `erc-${p.n}.md` : `eip-${p.n}.md`;
    return `https://github.com/${p.prHead}/blob/${p.prRef}/${dir}/${file}`;
  }
  return p.k === 'erc'
    ? `https://github.com/ethereum/ERCs/blob/master/ERCS/erc-${p.n}.md`
    : `https://github.com/ethereum/EIPs/blob/master/EIPS/eip-${p.n}.md`;
}

/**
 * Whether `discussions-to` is something worth linking. Open-PR frontmatter is
 * unreviewed, and real values in the wild include `TBD` and `self`.
 *
 * Note what this deliberately does NOT reject: URLs whose slug still says
 * `eip-xxxx`, e.g. `.../t/eip-xxxx-tapered-issuance-burn/29263`. Those look like
 * placeholders but work fine -- Discourse resolves by the trailing topic id and
 * redirects to the current slug (that one lands on `eip-8363-...`, which is how
 * Ethereum Magicians confirms the renumbering). Dropping them would discard
 * working links.
 */
export function usableDiscussion(disc: string): boolean {
  if (!disc) return false;
  try {
    return /^https?:$/.test(new URL(disc).protocol);
  } catch {
    return false;
  }
}

export function linksFor(p: Proposal): ProposalLink[] {
  const links: ProposalLink[] = [];
  // An unmerged proposal has no page on eips.ethereum.org, so the pull request
  // takes the place of the spec link.
  links.push(isUnmerged(p) ? { label: 'Pull request', url: prUrl(p) } : { label: 'Spec', url: specUrl(p.n) });
  if (usableDiscussion(p.disc)) links.push({ label: 'Discussion', url: p.disc });
  links.push({ label: 'Source', url: sourceUrl(p) });
  return links;
}

/** e.g. "Final · Core" -- category is absent for Meta/Informational. */
export function statusLine(p: Proposal): string {
  return [p.s, p.c || p.ty].filter(Boolean).join(' · ');
}

/** Other numbers this proposal answers to, excluding the one being viewed. */
export function otherNumbers(p: Proposal, viewing: number): number[] {
  return [p.n, ...(p.aka ?? [])].filter((n) => n !== viewing);
}
