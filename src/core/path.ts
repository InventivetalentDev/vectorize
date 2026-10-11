import { fitCurve } from './fit';
import type { Polyline } from './simplify';
import type { Polygon } from './trace';

/** Compact SVG path-data builder with implicit command repetition. */
export class PathBuilder {
  private parts: string[] = [];
  private lastCmd = '';
  private endsWithNumber = false;
  constructor(private precision: number) {}

  private num(v: number): string {
    let s = v.toFixed(this.precision);
    if (this.precision > 0) s = s.replace(/\.?0+$/, '');
    if (s === '-0') s = '0';
    return s;
  }

  private cmd(letter: string, ...nums: number[]): void {
    if (letter !== this.lastCmd) {
      this.parts.push(letter);
      this.lastCmd = letter;
      this.endsWithNumber = false;
    }
    for (const v of nums) {
      const s = this.num(v);
      if (this.endsWithNumber && s[0] !== '-') this.parts.push(' ');
      this.parts.push(s);
      this.endsWithNumber = true;
    }
  }

  moveTo(x: number, y: number): void {
    this.lastCmd = '';
    this.cmd('M', x, y);
  }
  lineTo(x: number, y: number): void {
    this.cmd('L', x, y);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.cmd('C', x1, y1, x2, y2, x, y);
  }
  close(): void {
    this.parts.push('Z');
    this.lastCmd = '';
    this.endsWithNumber = false;
  }
  toString(): string {
    return this.parts.join('');
  }
}

export interface ContourStyle {
  /** Curve-fit tolerance in pixels; 0 emits straight polygons. */
  smoothing: number;
  /** Vertices turning at least this much (degrees) are corners that stay sharp. */
  cornerThreshold: number;
}

/**
 * A vertex closer than this (pixels) to the chord between its neighbours is
 * never treated as a corner, so tiny round features don't become polygons.
 */
const CORNER_MIN_DIST = 2;
/** Turn angle (degrees) at a fit split point above which the split is treated as a corner. */
const SPLIT_CORNER_DEG = 110;
/** Inherent digitisation noise (pixels) added on top of the smoothing tolerance. */
const PIXEL_NOISE = 0.55;

/** Consecutive lines whose directions differ by less than this (pixels of cross product per unit length) are merged. */
const COLLINEAR_EPS = 0.05;
/** Points closer than this (pixels, along the tangent) to a range endpoint are not handed to the fitter. */
const MIN_ADVANCE = 0.75;
/** Longest gap (pixels) between consecutive points handed to the curve fitter. */
const MAX_STEP = 2;

/**
 * Appends one closed contour to `pb`.
 *
 * `raw` is the pixel-exact polygon and `poly` its polygonised form. Corners
 * are detected on the polygon; between corners, cubic Béziers are
 * least-squares fitted to the raw points (densified so long straight edges
 * are sampled too), which averages out pixel staircase noise. Returns the
 * number of anchor points written.
 */
export function appendContour(pb: PathBuilder, raw: Polygon, poly: Polyline, style: ContourStyle): number {
  const n = raw.length >> 1;
  const m = poly.count;
  if (m < 3) return 0;
  const { idx, pos, dir } = poly;

  if (style.smoothing <= 0) {
    pb.moveTo(pos[0], pos[1]);
    for (let i = 1; i < m; i++) pb.lineTo(pos[i * 2], pos[i * 2 + 1]);
    pb.close();
    return m;
  }

  // Corner detection: a sharp turn whose pixels do not cut inside the turn
  // (those are curves), far enough from the neighbours' chord to matter.
  const cosLimit = Math.cos((style.cornerThreshold * Math.PI) / 180) + 1e-9;
  const isCorner = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    const p = (i + m - 1) % m, q = (i + 1) % m;
    const cos = dir[p * 2] * dir[i * 2] + dir[p * 2 + 1] * dir[i * 2 + 1];
    if (cos > cosLimit || poly.rounded[i]) continue;
    const ax = pos[p * 2], ay = pos[p * 2 + 1], bx = pos[q * 2], by = pos[q * 2 + 1];
    const cx = pos[i * 2], cy = pos[i * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const dist = len > 0 ? Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / len : Math.hypot(cx - ax, cy - ay);
    if (dist >= CORNER_MIN_DIST) isCorner[i] = 1;
  }
  // Curves are fitted between "breaks": corners and the ends of straight segments.
  const { straight } = poly;
  const breaks: number[] = [];
  for (let i = 0; i < m; i++) if (isCorner[i] || straight[i] || straight[(i + m - 1) % m]) breaks.push(i);

  // Densify: the tracer drops collinear vertices, so long straight edges have
  // no interior points; without these the fit error would go unmeasured there.
  const densePts: number[] = [];
  const rawToDense = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    rawToDense[i] = densePts.length >> 1;
    const j = (i + 1) % n;
    const x0 = raw[i * 2], y0 = raw[i * 2 + 1], x1 = raw[j * 2], y1 = raw[j * 2 + 1];
    densePts.push(x0, y0);
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / MAX_STEP);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      densePts.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  const nd = densePts.length >> 1;
  rawToDense[n] = nd;
  const dense = Float64Array.from(densePts);
  const didx = new Int32Array(m);
  for (let k = 0; k < m; k++) didx[k] = rawToDense[idx[k]];

  // Tangent at every polygon vertex: the bisector of its two segment
  // directions, or the segment's own direction at corners.
  const vtan = new Float64Array(m * 2);
  for (let i = 0; i < m; i++) {
    const p = (i + m - 1) % m;
    let tx: number, ty: number;
    if (straight[p]) {
      tx = dir[p * 2];
      ty = dir[p * 2 + 1];
    } else if (straight[i]) {
      tx = dir[i * 2];
      ty = dir[i * 2 + 1];
    } else {
      tx = dir[p * 2] + dir[i * 2];
      ty = dir[p * 2 + 1] + dir[i * 2 + 1];
      const l = Math.hypot(tx, ty);
      if (l < 1e-9) {
        tx = dir[i * 2];
        ty = dir[i * 2 + 1];
      } else {
        tx /= l;
        ty /= l;
      }
    }
    vtan[i * 2] = tx;
    vtan[i * 2 + 1] = ty;
  }
  // Which polygon segment each dense point lies on, so tangents can be
  // interpolated between the (accurate) vertex tangents along a segment.
  const segOf = new Int32Array(nd);
  for (let k = 0; k < m; k++) {
    const a = didx[k], b = didx[(k + 1) % m];
    let len = (b - a + nd) % nd;
    if (len === 0) len = nd;
    for (let i = 0; i < len; i++) segOf[(a + i) % nd] = k;
  }
  const tangentAtDense = (r: number): [number, number] => {
    const k = segOf[r], k1 = (k + 1) % m;
    const a = didx[k];
    let len = (didx[k1] - a + nd) % nd;
    if (len === 0) len = nd;
    const t = ((r - a + nd) % nd) / len;
    const sx = isCorner[k] ? dir[k * 2] : vtan[k * 2], sy = isCorner[k] ? dir[k * 2 + 1] : vtan[k * 2 + 1];
    const ex = isCorner[k1] ? dir[k * 2] : vtan[k1 * 2], ey = isCorner[k1] ? dir[k * 2 + 1] : vtan[k1 * 2 + 1];
    const tx = (1 - t) * sx + t * ex, ty = (1 - t) * sy + t * ey;
    const l = Math.hypot(tx, ty);
    if (l < 1e-9) return [dir[k * 2], dir[k * 2 + 1]];
    return [tx / l, ty / l];
  };
  const tolerance = style.smoothing + PIXEL_NOISE;
  // The fitter's own corner check (on split points) only needs to catch what
  // the polygon stage cannot see, such as the ends of thin lines, so it uses
  // a much stricter angle than the user's corner threshold.
  const splitCornerCos = Math.min(cosLimit, Math.cos((SPLIT_CORNER_DEG * Math.PI) / 180));

  const seq = new Float64Array((nd + 1) * 2);
  let seqStart = 0;
  // Segments are buffered so consecutive collinear lines can be merged.
  const out: number[][] = [];
  let startX = 0, startY = 0;
  const begin = (x: number, y: number) => {
    startX = x;
    startY = y;
  };
  const pushLine = (x: number, y: number) => {
    const prev = out[out.length - 1];
    if (prev && prev.length === 2) {
      const before = out.length >= 2 ? out[out.length - 2] : null;
      const bx = before ? before[before.length - 2] : startX, by = before ? before[before.length - 1] : startY;
      const ux = prev[0] - bx, uy = prev[1] - by, vx = x - prev[0], vy = y - prev[1];
      const cross = ux * vy - uy * vx;
      if (Math.abs(cross) <= COLLINEAR_EPS * Math.hypot(ux, uy) && ux * vx + uy * vy >= 0) {
        prev[0] = x;
        prev[1] = y;
        return;
      }
    }
    out.push([x, y]);
  };
  const emitSegments = (segs: ReturnType<typeof fitCurve>) => {
    for (const s of segs) {
      if (s.length === 2) pushLine(s[0], s[1]);
      else out.push(s);
    }
  };
  const finish = (): number => {
    // Z closes the path, so a final line back to the start is redundant.
    const last = out[out.length - 1];
    if (out.length > 1 && last.length === 2 && Math.abs(last[0] - startX) < 1e-6 && Math.abs(last[1] - startY) < 1e-6) out.pop();
    pb.moveTo(startX, startY);
    for (const s of out) {
      if (s.length === 2) pb.lineTo(s[0], s[1]);
      else pb.curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
    }
    pb.close();
    return out.length;
  };

  /**
   * Dense points from vertex `a` to vertex `b` (inclusive), endpoints replaced
   * by the refined positions. Points next to an endpoint that do not advance
   * along its tangent are dropped: a refined vertex can sit a little further
   * along the edge than the raw junction, and such points would read as a
   * zigzag to the fitter.
   */
  let seqOffset = 0;
  const fill = (a: number, b: number, t1x: number, t1y: number, t2x: number, t2y: number): number => {
    const i0 = didx[a], i1 = didx[b];
    let count = (i1 - i0 + nd) % nd;
    if (count === 0) count = nd;
    for (let i = 0; i <= count; i++) {
      const r = ((i0 + i) % nd) * 2;
      seq[i * 2] = dense[r];
      seq[i * 2 + 1] = dense[r + 1];
    }
    const sx = pos[a * 2], sy = pos[a * 2 + 1], ex = pos[b * 2], ey = pos[b * 2 + 1];
    let from = 1, to = count - 1;
    while (from < to && (seq[from * 2] - sx) * t1x + (seq[from * 2 + 1] - sy) * t1y < MIN_ADVANCE) from++;
    while (to > from && (ex - seq[to * 2]) * -t2x + (ey - seq[to * 2 + 1]) * -t2y < MIN_ADVANCE) to--;
    const kept = to - from + 1;
    if (from > 1) seq.copyWithin(2, from * 2, (to + 1) * 2);
    seq[0] = sx;
    seq[1] = sy;
    seq[(kept + 1) * 2] = ex;
    seq[(kept + 1) * 2 + 1] = ey;
    seqStart = i0;
    seqOffset = from - 1;
    return kept + 2;
  };
  const tangentAtSeq = (i: number): [number, number] => tangentAtDense((seqStart + seqOffset + i) % nd);

  if (breaks.length === 0) {
    // Closed smooth loop: start anywhere with a continuous tangent.
    const tx = vtan[0], ty = vtan[1];
    const count = fill(0, 0, tx, ty, -tx, -ty);
    begin(pos[0], pos[1]);
    emitSegments(fitCurve(seq, count, tx, ty, -tx, -ty, tolerance, splitCornerCos, tangentAtSeq));
    return finish();
  }

  const b0 = breaks[0];
  begin(pos[b0 * 2], pos[b0 * 2 + 1]);
  for (let i = 0; i < breaks.length; i++) {
    const a = breaks[i], b = breaks[(i + 1) % breaks.length];
    if (straight[a] && (a + 1) % m === b) {
      pushLine(pos[b * 2], pos[b * 2 + 1]);
      continue;
    }
    // Forward tangent at a, backward tangent at b: a corner's own segment
    // direction, or the (straight-aware) vertex tangent.
    const bp = (b + m - 1) % m;
    const t1x = isCorner[a] ? dir[a * 2] : vtan[a * 2], t1y = isCorner[a] ? dir[a * 2 + 1] : vtan[a * 2 + 1];
    const t2x = isCorner[b] ? -dir[bp * 2] : -vtan[b * 2], t2y = isCorner[b] ? -dir[bp * 2 + 1] : -vtan[b * 2 + 1];
    const count = fill(a, b, t1x, t1y, t2x, t2y);
    if (count === 2) {
      pushLine(seq[2], seq[3]);
      continue;
    }
    emitSegments(fitCurve(seq, count, t1x, t1y, t2x, t2y, tolerance, splitCornerCos, tangentAtSeq));
  }
  return finish();
}
