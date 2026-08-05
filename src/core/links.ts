import type { Proposal } from './types';

export interface ProposalLink {
  label: string;
  url: string;
}

/**
 * eips.ethereum.org/EIPS/eip-{n} resolves for ERC-only proposals too (verified
 * against ERC-4337), so the canonical spec link needs no branch on kind. The
 * inverse is not true: eips.ethereum.org/ERCS/... is a 404.
 */
export function specUrl(n: number): string {
  return `https://eips.ethereum.org/EIPS/eip-${n}`;
}

export function sourceUrl(p: Proposal): string {
  return p.k === 'erc'
    ? `https://github.com/ethereum/ERCs/blob/master/ERCS/erc-${p.n}.md`
    : `https://github.com/ethereum/EIPs/blob/master/EIPS/eip-${p.n}.md`;
}

export function linksFor(p: Proposal): ProposalLink[] {
  const links: ProposalLink[] = [{ label: 'Spec', url: specUrl(p.n) }];
  // Present for ~95% of proposals; omit the link rather than render a dead one.
  if (p.disc) links.push({ label: 'Discussion', url: p.disc });
  links.push({ label: 'Source', url: sourceUrl(p) });
  return links;
}

/** e.g. "Final · Core" -- category is absent for Meta/Informational. */
export function statusLine(p: Proposal): string {
  return [p.s, p.c || p.ty].filter(Boolean).join(' · ');
}
