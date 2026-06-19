/**
 * Converts a sqlite-vec L2 distance (over L2-normalized embeddings) into a
 * calibrated [0,1] relevance score.
 *
 * For unit vectors, L2 distance d relates to cosine similarity by
 *   d^2 = 2(1 - cos)  =>  cos = 1 - d^2/2.
 *
 * The previous transform 1/(1+d) compressed every result into ~0.62-0.70, so a
 * perfect match was nearly indistinguishable from an unrelated one. e5 cosine
 * similarities for unrelated text sit around ~0.6, while strong matches approach
 * ~1.0, so we rescale [0.6, 1.0] cosine onto [0, 1] and clamp. Unrelated results
 * land near 0; strong matches near 1. This is presentation-only — ranking is
 * unchanged because the mapping is monotonic in distance.
 */
const COS_FLOOR = 0.6;
const COS_RANGE = 1 - COS_FLOOR;

export function distanceToScore(distance: number): number {
  const cos = 1 - (distance * distance) / 2;
  const scaled = (cos - COS_FLOOR) / COS_RANGE;
  return Math.max(0, Math.min(1, scaled));
}
