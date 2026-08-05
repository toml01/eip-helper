/** A proposal record as stored in data/eips.json (short keys keep it small). */
export interface Proposal {
  n: number;
  t: string;
  d: string;
  s: string;
  ty: string;
  c: string;
  k: 'eip' | 'erc';
  disc: string;
  cr: string;
  req: number[];
}

/** A reference found in page text, before metadata is attached. */
export interface Match {
  /** Character offset of the match within the text it was found in. */
  start: number;
  end: number;
  /** The resolved proposal number. */
  n: number;
  /** The exact text that matched, e.g. "EIP-7702" or "7702". */
  text: string;
  /**
   * The prefix as written by the author, if any. Used to detect the
   * EIP/ERC mix-up case -- someone writing "EIP-4337" for what is
   * canonically ERC-4337.
   */
  writtenKind: 'eip' | 'erc' | null;
}

export interface Settings {
  enabled: boolean;
  /**
   * Match bare numbers with no EIP/ERC prefix. Off by default: 34 proposal
   * numbers are plausible years (2015, 2020, 2025, 2026...) and 91 are under
   * 1000, so unguarded bare matching lights up ordinary prose.
   */
  bareNumbers: boolean;
  highlightStyle: 'underline' | 'background' | 'both';
  /** Hostnames the user has switched off. */
  disabledSites: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  bareNumbers: false,
  highlightStyle: 'underline',
  // Redundant on the canonical site, which already renders every reference as
  // a real link with a preview.
  disabledSites: ['eips.ethereum.org', 'ercs.ethereum.org'],
};
