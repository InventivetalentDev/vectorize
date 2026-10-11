import type { Polygon } from './trace';

/**
 * A simplified closed polygon: one vertex per junction between fitted line
 * segments, in traversal order.
 */
export interface Polyline {
  count: number;
  /** Index into the raw polygon of the vertex each junction came from. */
  idx: Int32Array;
  /** Refined junction positions [x0, y0, x1, y1, ...] (intersections of the fitted lines). */
  pos: Float64Array;
  /** Unit direction [dx, dy] of the segment that leaves each vertex. */
  dir: Float64Array;
  /** 1 when the segment leaving vertex k is a genuinely straight edge (raw pixels fit its line within digitisation noise). */
  straight: Uint8Array;
  /** 1 when the raw pixels around vertex k consistently cut inside the turn, i.e. the vertex sits on a curve, not on a corner. */
  rounded: Uint8Array;
}

/**
 * Inherent digitisation noise, added on top of the user tolerance: a
 * perfectly straight edge digitised as a pixel staircase deviates up to
 * 0.5 * (|dx| + |dy|) from its best line (a max-norm criterion: 0.5 for
 * axis-aligned edges, ~0.71 for diagonals). The user tolerance is therefore
 * the geometric slack beyond what pixels can represent.
 */
const STAIR_SLACK = 0.51;
/** Minimum angle (radians) between consecutive segments before their intersection is used as a vertex. */
const MIN_CORNER_ANGLE = 0.05;
/** Largest step against the segment direction (pixels) still accepted inside one segment. */
const BACKTRACK_SLACK = 0.5;
/** Shortest segment (pixels) that is emitted as a straight line rather than fitted as part of a curve. */
const MIN_STRAIGHT_LENGTH = 4;
/** Sagitta (pixels) of the arcs meeting at a vertex above which it counts as rounded, not a corner. */
const ROUNDED_SIGNAL = 0.4;
/** Fewest raw vertices / shortest length for a segment's curvature estimate to be trusted. */
const MIN_SAGITTA_POINTS = 8;
const MIN_SAGITTA_LENGTH = 6;
/** Bulge (pixels) of a segment's middle relative to its ends above which it is curved rather than straight. */
const CURVE_SIGNAL = 0.35;
/** A straight edge must be at least this many times longer than both neighbouring segments. */
const STRAIGHT_DOMINANCE = 2;
/** Angle steps (radians) tried when refining a line towards its minimax orientation. */
const ANGLE_STEPS = [0.03, 0.015, 0.0075, 0.0035, 0.0015];

/**
 * Polygonises a closed pixel-edge contour. Starting from the four extreme
 * vertices (so thin features can never vanish), every arc is recursively
 * split at the vertex farthest from the arc's least-squares line until all
 * raw vertices lie within `eps` of their segment's line; neighbouring
 * segments that together still fit are merged again. Vertices are then placed
 * at the intersections of consecutive lines. Unlike Douglas-Peucker this is
 * robust to the ±0.5px noise of digitised edges, and true corners are
 * reconstructed exactly rather than snapped to a pixel.
 */
export function polygonize(raw: Polygon, eps: number): Polyline {
  const n = raw.length >> 1;
  if (eps <= 0 || n < 4) return trivial(raw);

  const px = (k: number) => raw[(k % n) * 2];
  const py = (k: number) => raw[(k % n) * 2 + 1];

  // Least-squares line of raw[from..to], oriented along the traversal.
  let mx = 0, my = 0, dx = 1, dy = 0;
  const lineOf = (from: number, to: number) => {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const cnt = to - from + 1;
    for (let k = from; k <= to; k++) {
      const x = px(k), y = py(k);
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    mx = sx / cnt;
    my = sy / cnt;
    const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    dx = Math.cos(theta);
    dy = Math.sin(theta);
    if ((px(to) - px(from)) * dx + (py(to) - py(from)) * dy < 0) {
      dx = -dx;
      dy = -dy;
    }
  };
  /**
   * Nudges the current line towards the minimax (Chebyshev) line of
   * raw[from..to]: centres the deviation band and searches a few small angle
   * steps for the narrowest band. A digitised straight edge is guaranteed to
   * fit a band of half-width 0.5 * (|dx| + |dy|) around its minimax line.
   */
  const refine = (from: number, to: number) => {
    let theta = Math.atan2(dy, dx);
    const halfRange = (t: number): number => {
      const nx = -Math.sin(t), ny = Math.cos(t);
      let lo = Infinity, hi = -Infinity;
      for (let k = from; k <= to; k++) {
        const d = (px(k) - mx) * nx + (py(k) - my) * ny;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      return (hi - lo) / 2;
    };
    let best = halfRange(theta);
    for (const step of ANGLE_STEPS) {
      for (const sign of [1, -1]) {
        const t = theta + sign * step;
        const r = halfRange(t);
        if (r < best) {
          best = r;
          theta = t;
        }
      }
    }
    dx = Math.cos(theta);
    dy = Math.sin(theta);
    // Centre the band.
    const nx = -dy, ny = dx;
    let lo = Infinity, hi = -Infinity;
    for (let k = from; k <= to; k++) {
      const d = (px(k) - mx) * nx + (py(k) - my) * ny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const shift = (lo + hi) / 2;
    mx += nx * shift;
    my += ny * shift;
  };
  /** Returns -1 when raw[from..to] fits the current (refined) line, else the index to split at. */
  const splitPoint = (from: number, to: number): number => {
    const tol = eps + STAIR_SLACK * (Math.abs(dx) + Math.abs(dy));
    let far = -1, farD = tol;
    for (let k = from + 1; k < to; k++) {
      const d = Math.abs((px(k) - mx) * -dy + (py(k) - my) * dx);
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    if (far >= 0) return far;
    // No doubling back along the line, or thin slivers would collapse into it.
    for (let k = from + 1; k <= to; k++) {
      if ((px(k) - px(k - 1)) * dx + (py(k) - py(k - 1)) * dy < -BACKTRACK_SLACK) return k === to ? k - 1 : k;
    }
    return -1;
  };
  const fitsRange = (from: number, to: number): number => {
    lineOf(from, to);
    refine(from, to);
    return splitPoint(from, to);
  };

  // Anchors: the extreme vertices, which are always kept.
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (let i = 1; i < n; i++) {
    const x = raw[i * 2], y = raw[i * 2 + 1];
    if (x < raw[minX * 2]) minX = i;
    if (x > raw[maxX * 2]) maxX = i;
    if (y < raw[minY * 2 + 1]) minY = i;
    if (y > raw[maxY * 2 + 1]) maxY = i;
  }
  const anchors = Array.from(new Set([minX, maxX, minY, maxY])).sort((a, b) => a - b);
  if (anchors.length < 2) return trivial(raw);

  // Split every arc between anchors until all pieces fit.
  const starts: number[] = [];
  const ends: number[] = [];
  const arcOf: number[] = [];
  const stack: number[] = [];
  for (let a = 0; a < anchors.length; a++) {
    const from = anchors[a];
    const to = a + 1 < anchors.length ? anchors[a + 1] : anchors[0] + n;
    stack.length = 0;
    stack.push(from, to);
    while (stack.length > 0) {
      const t = stack.pop()!;
      const f = stack.pop()!;
      const at = t - f > 1 ? fitsRange(f, t) : -1;
      if (at < 0) {
        starts.push(f);
        ends.push(t);
        arcOf.push(a);
      } else {
        stack.push(at, t, f, at);
      }
    }
  }

  // Merge neighbouring segments of the same arc that fit a single line.
  let merged = true;
  while (merged && starts.length > 1) {
    merged = false;
    for (let k = 0; k + 1 < starts.length; k++) {
      if (arcOf[k] !== arcOf[k + 1]) continue;
      if (fitsRange(starts[k], ends[k + 1]) < 0) {
        ends[k] = ends[k + 1];
        starts.splice(k + 1, 1);
        ends.splice(k + 1, 1);
        arcOf.splice(k + 1, 1);
        merged = true;
        k--;
      }
    }
  }

  const segCount = starts.length;
  if (segCount < 3) return trivial(raw);
  const lines = new Float64Array(segCount * 4);
  for (let k = 0; k < segCount; k++) {
    lineOf(starts[k], ends[k]);
    lines[k * 4] = mx;
    lines[k * 4 + 1] = my;
    lines[k * 4 + 2] = dx;
    lines[k * 4 + 3] = dy;
  }

  // Straightness of each segment and roundness of each vertex, judged from
  // how the raw pixels sit relative to the fitted lines. A parabola is
  // fitted to the deviations along each segment; its bulge (the sagitta of
  // the underlying arc) is a far stronger curvature signal than any single
  // pixel, since staircase noise averages out.
  const straight = new Uint8Array(segCount);
  const sagitta = new Float64Array(segCount); // signed (left normal): ends relative to the middle
  const lengths = new Float64Array(segCount);
  for (let k = 0; k < segCount; k++) lengths[k] = Math.hypot(px(ends[k]) - px(starts[k]), py(ends[k]) - py(starts[k]));
  for (let k = 0; k < segCount; k++) {
    const lmx = lines[k * 4], lmy = lines[k * 4 + 1], ldx = lines[k * 4 + 2], ldy = lines[k * 4 + 3];
    const from = starts[k], to = ends[k];
    const sMid = ((px(from) - lmx) * ldx + (py(from) - lmy) * ldy + (px(to) - lmx) * ldx + (py(to) - lmy) * ldy) / 2;
    let maxDev = 0;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, d0 = 0, d1 = 0, d2 = 0;
    for (let i = from; i <= to; i++) {
      const x = px(i) - lmx, y = py(i) - lmy;
      const d = x * -ldy + y * ldx;
      const t = x * ldx + y * ldy - sMid;
      if (Math.abs(d) > maxDev) maxDev = Math.abs(d);
      const tt = t * t;
      s0++;
      s1 += t;
      s2 += tt;
      s3 += tt * t;
      s4 += tt * tt;
      d0 += d;
      d1 += d * t;
      d2 += d * tt;
    }
    // Solve the normal equations for d = a t^2 + b t + c (Cramer's rule).
    const det = s4 * (s2 * s0 - s1 * s1) - s3 * (s3 * s0 - s1 * s2) + s2 * (s3 * s1 - s2 * s2);
    let a = 0;
    if (Math.abs(det) > 1e-9) {
      a = (d2 * (s2 * s0 - s1 * s1) - s3 * (d1 * s0 - s1 * d0) + s2 * (d1 * s1 - s2 * d0)) / det;
    }
    const half = lengths[k] / 2;
    sagitta[k] = a * half * half;
    const noise = STAIR_SLACK * (Math.abs(ldx) + Math.abs(ldy));
    // The axis-aligned parts of a digitised circle are genuinely flat, so a
    // segment only counts as a straight edge when it clearly outranks its
    // neighbours in length.
    const neighbours = Math.max(lengths[(k + segCount - 1) % segCount], lengths[(k + 1) % segCount]);
    straight[k] =
      Math.abs(sagitta[k]) <= CURVE_SIGNAL &&
      maxDev <= noise + 0.5 * eps &&
      lengths[k] >= MIN_STRAIGHT_LENGTH &&
      lengths[k] >= STRAIGHT_DOMINANCE * neighbours
        ? 1
        : 0;
  }
  // The parabola fit is only meaningful with enough pixels behind it.
  const reliable = new Uint8Array(segCount);
  for (let k = 0; k < segCount; k++) {
    reliable[k] = ends[k] - starts[k] + 1 >= MIN_SAGITTA_POINTS && lengths[k] >= MIN_SAGITTA_LENGTH ? 1 : 0;
  }
  const rounded = new Uint8Array(segCount);
  for (let k = 0; k < segCount; k++) {
    const p = (k + segCount - 1) % segCount;
    if (straight[p] && straight[k]) continue; // two straight edges meet: a corner
    if (!reliable[p] && !reliable[k]) continue;
    const cross = lines[p * 4 + 2] * lines[k * 4 + 3] - lines[p * 4 + 3] * lines[k * 4 + 2];
    if (Math.abs(cross) < 1e-6) continue;
    // On an arc the pixels near a vertex cut inside the turn; the sagitta
    // measures exactly that (ends relative to the middle, along the normal).
    const sum = (reliable[p] ? sagitta[p] : 0) + (reliable[k] ? sagitta[k] : 0);
    const inside = (Math.sign(cross) * sum) / (reliable[p] && reliable[k] ? 2 : 1);
    if (inside > ROUNDED_SIGNAL) rounded[k] = 1;
  }

  // Vertices: intersection of consecutive fitted lines.
  const idx = new Int32Array(segCount);
  const pos = new Float64Array(segCount * 2);
  const dir = new Float64Array(segCount * 2);
  for (let k = 0; k < segCount; k++) {
    const p = (k + segCount - 1) % segCount;
    const ax = lines[p * 4], ay = lines[p * 4 + 1], adx = lines[p * 4 + 2], ady = lines[p * 4 + 3];
    const bx = lines[k * 4], by = lines[k * 4 + 1], bdx = lines[k * 4 + 2], bdy = lines[k * 4 + 3];
    const jx = px(starts[k]), jy = py(starts[k]);
    const cross = adx * bdy - ady * bdx;
    let x: number, y: number;
    if (Math.abs(cross) < MIN_CORNER_ANGLE) {
      // Nearly collinear: project the raw junction onto the mean line.
      const ta = (jx - ax) * adx + (jy - ay) * ady;
      const tb = (jx - bx) * bdx + (jy - by) * bdy;
      x = (ax + ta * adx + bx + tb * bdx) / 2;
      y = (ay + ta * ady + by + tb * bdy) / 2;
    } else {
      const t = ((bx - ax) * bdy - (by - ay) * bdx) / cross;
      x = ax + t * adx;
      y = ay + t * ady;
      // Very shallow corners can put the intersection far away; stay near the data.
      if (Math.hypot(x - jx, y - jy) > 3 * eps + 2) {
        const ta = (jx - ax) * adx + (jy - ay) * ady;
        x = ax + ta * adx;
        y = ay + ta * ady;
      }
    }
    idx[k] = starts[k] % n;
    pos[k * 2] = x;
    pos[k * 2 + 1] = y;
    dir[k * 2] = bdx;
    dir[k * 2 + 1] = bdy;
  }
  return { count: segCount, idx, pos, dir, straight, rounded };
}

/** Every raw vertex, unchanged. */
function trivial(raw: Polygon): Polyline {
  const n = raw.length >> 1;
  const idx = new Int32Array(n);
  const pos = new Float64Array(n * 2);
  const dir = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    idx[i] = i;
    pos[i * 2] = raw[i * 2];
    pos[i * 2 + 1] = raw[i * 2 + 1];
    const j = (i + 1) % n;
    const dx = raw[j * 2] - raw[i * 2], dy = raw[j * 2 + 1] - raw[i * 2 + 1];
    const l = Math.hypot(dx, dy) || 1;
    dir[i * 2] = dx / l;
    dir[i * 2 + 1] = dy / l;
  }
  return { count: n, idx, pos, dir, straight: new Uint8Array(n).fill(1), rounded: new Uint8Array(n) };
}
