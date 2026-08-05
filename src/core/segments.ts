/**
 * Joining inline text runs so a reference split across elements can be matched.
 *
 * Sites that bold a search term split it apart. X search renders "EIP-7702" as
 * three text nodes -- `EIP`, `-`, `7702` -- and matching each node alone can
 * never see the reference. So consecutive inline text runs are concatenated
 * into one string, matched, and each hit is mapped back to the node and offset
 * it started and ended at.
 *
 * The mapping is what makes this safe to paint: a Range needs real nodes and
 * offsets, so a flattened string alone is not enough.
 *
 * These functions are generic over the node type so they can be unit-tested
 * without a DOM.
 */

export interface SegmentPart<T> {
  node: T;
  /** Half-open range of this part's text within the segment string. */
  start: number;
  end: number;
}

export interface Segment<T> {
  text: string;
  parts: Array<SegmentPart<T>>;
}

export interface Position<T> {
  node: T;
  offset: number;
}

/** Concatenates runs into one string, recording where each run landed. */
export function buildSegment<T>(runs: Array<{ node: T; text: string }>): Segment<T> {
  let text = '';
  const parts: Array<SegmentPart<T>> = [];
  for (const run of runs) {
    if (!run.text) continue;
    parts.push({ node: run.node, start: text.length, end: text.length + run.text.length });
    text += run.text;
  }
  return { text, parts };
}

/**
 * Maps an offset in the segment string back to a node and an offset within it.
 *
 * An offset sitting exactly on a boundary belongs to the following part, which
 * is the equivalent Range boundary; the final offset attaches to the last part.
 */
export function locate<T>(segment: Segment<T>, offset: number): Position<T> | null {
  for (const part of segment.parts) {
    if (offset >= part.start && offset < part.end) {
      return { node: part.node, offset: offset - part.start };
    }
  }
  const last = segment.parts[segment.parts.length - 1];
  if (last && offset === last.end) {
    return { node: last.node, offset: last.end - last.start };
  }
  return null;
}

/** Every part the half-open range [start, end) touches. */
export function partsCovering<T>(segment: Segment<T>, start: number, end: number): Array<T> {
  return segment.parts
    .filter((part) => start < part.end && end > part.start)
    .map((part) => part.node);
}
