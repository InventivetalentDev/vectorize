/**
 * Least-squares cubic Bézier fitting (Philip J. Schneider, "An Algorithm for
 * Automatically Fitting Digitized Curves", Graphics Gems 1990).
 *
 * Fits a chain of cubic Béziers to a digitized point sequence so that no point
 * is farther than `tolerance` from the curve, splitting at the worst point
 * when necessary. Tangent directions at both ends are prescribed by the
 * caller, which lets neighbouring pieces join smoothly.
 */

/** Either a line segment `[x, y]` or a cubic `[x1, y1, x2, y2, x, y]` (from the current point). */
export type Segment = number[];

const MAX_ITERATIONS = 4;
const TANGENT_WINDOW = 8;
const MIN_CORNER_WINDOW = 4;
/** Control points closer than this (pixels) to the chord make a cubic count as a straight line. */
const COLLINEAR_EPS = 0.05;

export function fitCurve(
  pts: Float64Array,
  count: number,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
  tolerance: number,
  cornerCos = -1,
  tangentAt?: (i: number) => [number, number],
): Segment[] {
  const out: Segment[] = [];
  if (count < 2) return out;
  if (count === 2) {
    out.push([pts[2], pts[3]]);
    return out;
  }
  const tol2 = tolerance * tolerance;
  const iterationError = tol2 * 4;

  // Explicit stack to keep output in order without deep recursion.
  const stack: { first: number; last: number; t1x: number; t1y: number; t2x: number; t2y: number }[] = [];
  stack.push({ first: 0, last: count - 1, t1x, t1y, t2x, t2y });

  while (stack.length > 0) {
    const seg = stack.pop()!;
    const { first, last } = seg;
    const n = last - first + 1;
    if (n === 2) {
      out.push([pts[last * 2], pts[last * 2 + 1]]);
      continue;
    }

    let u = chordLengthParameterize(pts, first, last);
    let bez = generateBezier(pts, first, last, u, seg.t1x, seg.t1y, seg.t2x, seg.t2y);
    let err = computeMaxError(pts, first, last, bez, u);
    if (err.max > tol2 && err.max < iterationError) {
      for (let i = 0; i < MAX_ITERATIONS && err.max > tol2; i++) {
        u = reparameterize(pts, first, last, u, bez);
        bez = generateBezier(pts, first, last, u, seg.t1x, seg.t1y, seg.t2x, seg.t2y);
        err = computeMaxError(pts, first, last, bez, u);
      }
    }
    if (err.max <= tol2) {
      out.push(isCollinear(bez) ? [bez[6], bez[7]] : [bez[2], bez[3], bez[4], bez[5], bez[6], bez[7]]);
      continue;
    }

    // Split at the point of maximum error. Tangents on either side come from
    // local least-squares lines (digitised curves are pixel staircases, so
    // neighbouring points alone only ever give axis directions). If the two
    // sides disagree sharply this is a corner the polygon stage missed, e.g.
    // the end of a thin line, and the pieces get independent tangents.
    let split = err.index;
    if (n >= 5) split = Math.max(first + 2, Math.min(last - 2, split));
    const lw = Math.min(TANGENT_WINDOW, split - first), rw = Math.min(TANGENT_WINDOW, last - split);
    const [lx, ly] = windowDirection(pts, split - lw, split);
    const [rx, ry] = windowDirection(pts, split, split + rw);
    let leftOut: number, leftOutY: number, rightIn: number, rightInY: number;
    // A single pixel edge is always axis-aligned, so only trust a corner when
    // both sides have enough points to establish a direction.
    if (lw >= MIN_CORNER_WINDOW && rw >= MIN_CORNER_WINDOW && lx * rx + ly * ry < cornerCos) {
      leftOut = -lx;
      leftOutY = -ly;
      rightIn = rx;
      rightInY = ry;
    } else {
      let bx: number, by: number;
      if (tangentAt) {
        [bx, by] = tangentAt(split);
      } else {
        bx = lx + rx;
        by = ly + ry;
        const bl = Math.hypot(bx, by) || 1;
        bx /= bl;
        by /= bl;
      }
      leftOut = -bx;
      leftOutY = -by;
      rightIn = bx;
      rightInY = by;
    }
    // Push right piece first so the left piece is processed (and emitted) first.
    stack.push({ first: split, last, t1x: rightIn, t1y: rightInY, t2x: seg.t2x, t2y: seg.t2y });
    stack.push({ first, last: split, t1x: seg.t1x, t1y: seg.t1y, t2x: leftOut, t2y: leftOutY });
  }
  return out;
}

/** True when both control points lie on the chord, i.e. the cubic is really a line. */
function isCollinear(b: Float64Array): boolean {
  const dx = b[6] - b[0], dy = b[7] - b[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return true;
  const d1 = Math.abs((b[2] - b[0]) * dy - (b[3] - b[1]) * dx) / len;
  const d2 = Math.abs((b[4] - b[0]) * dy - (b[5] - b[1]) * dx) / len;
  // Handles must also point forward along the chord, not fold back.
  const f1 = (b[2] - b[0]) * dx + (b[3] - b[1]) * dy, f2 = (b[4] - b[0]) * dx + (b[5] - b[1]) * dy;
  return d1 < COLLINEAR_EPS && d2 < COLLINEAR_EPS && f1 >= 0 && f2 <= len * len;
}

/** Unit direction of the least-squares line through pts[a..b], oriented from a to b. */
function windowDirection(pts: Float64Array, a: number, b: number): [number, number] {
  const cnt = b - a + 1;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let k = a; k <= b; k++) {
    const x = pts[k * 2], y = pts[k * 2 + 1];
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const mx = sx / cnt, my = sy / cnt;
  const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
  let dx: number, dy: number;
  if (cxx === 0 && cyy === 0) {
    dx = pts[b * 2] - pts[a * 2];
    dy = pts[b * 2 + 1] - pts[a * 2 + 1];
  } else {
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    dx = Math.cos(theta);
    dy = Math.sin(theta);
  }
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  if ((pts[b * 2] - pts[a * 2]) * dx + (pts[b * 2 + 1] - pts[a * 2 + 1]) * dy < 0) {
    dx = -dx;
    dy = -dy;
  }
  return [dx, dy];
}

function chordLengthParameterize(pts: Float64Array, first: number, last: number): Float64Array {
  const n = last - first + 1;
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = (first + i) * 2, b = a - 2;
    u[i] = u[i - 1] + Math.hypot(pts[a] - pts[b], pts[a + 1] - pts[b + 1]);
  }
  const total = u[n - 1] || 1;
  for (let i = 1; i < n; i++) u[i] /= total;
  return u;
}

/** Returns [x0, y0, x1, y1, x2, y2, x3, y3]. */
function generateBezier(
  pts: Float64Array,
  first: number,
  last: number,
  u: Float64Array,
  t1x: number,
  t1y: number,
  t2x: number,
  t2y: number,
): Float64Array {
  const n = last - first + 1;
  const x0 = pts[first * 2], y0 = pts[first * 2 + 1];
  const x3 = pts[last * 2], y3 = pts[last * 2 + 1];
  let c00 = 0, c01 = 0, c11 = 0, xx0 = 0, xx1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i], it = 1 - t;
    const b0 = it * it * it, b1 = 3 * t * it * it, b2 = 3 * t * t * it, b3 = t * t * t;
    const a0x = t1x * b1, a0y = t1y * b1;
    const a1x = t2x * b2, a1y = t2y * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    const px = pts[(first + i) * 2], py = pts[(first + i) * 2 + 1];
    const tx = px - (x0 * (b0 + b1) + x3 * (b2 + b3));
    const ty = py - (y0 * (b0 + b1) + y3 * (b2 + b3));
    xx0 += a0x * tx + a0y * ty;
    xx1 += a1x * tx + a1y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = 0, alphaR = 0;
  if (Math.abs(det) > 1e-12) {
    alphaL = (xx0 * c11 - xx1 * c01) / det;
    alphaR = (c00 * xx1 - c01 * xx0) / det;
  }
  const segLength = Math.hypot(x3 - x0, y3 - y0);
  const epsilon = 1e-6 * segLength;
  if (alphaL < epsilon || alphaR < epsilon || alphaL > segLength * 2 || alphaR > segLength * 2) {
    // Degenerate fit: fall back to the Wu/Barsky heuristic.
    alphaL = alphaR = segLength / 3;
  }
  return Float64Array.of(x0, y0, x0 + t1x * alphaL, y0 + t1y * alphaL, x3 + t2x * alphaR, y3 + t2y * alphaR, x3, y3);
}

function bezierPoint(b: Float64Array, t: number, out: Float64Array): void {
  const it = 1 - t;
  const b0 = it * it * it, b1 = 3 * t * it * it, b2 = 3 * t * t * it, b3 = t * t * t;
  out[0] = b0 * b[0] + b1 * b[2] + b2 * b[4] + b3 * b[6];
  out[1] = b0 * b[1] + b1 * b[3] + b2 * b[5] + b3 * b[7];
}

const tmp = new Float64Array(2);

function computeMaxError(pts: Float64Array, first: number, last: number, bez: Float64Array, u: Float64Array): { max: number; index: number } {
  let max = 0;
  let index = (first + last) >> 1;
  for (let i = first + 1; i < last; i++) {
    bezierPoint(bez, u[i - first], tmp);
    const dx = tmp[0] - pts[i * 2], dy = tmp[1] - pts[i * 2 + 1];
    const d = dx * dx + dy * dy;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  return { max, index };
}

function reparameterize(pts: Float64Array, first: number, last: number, u: Float64Array, bez: Float64Array): Float64Array {
  const n = last - first + 1;
  const out = new Float64Array(n);
  // Control points of the first and second derivatives.
  const q1 = new Float64Array(6), q2 = new Float64Array(4);
  for (let i = 0; i < 3; i++) {
    q1[i * 2] = (bez[(i + 1) * 2] - bez[i * 2]) * 3;
    q1[i * 2 + 1] = (bez[(i + 1) * 2 + 1] - bez[i * 2 + 1]) * 3;
  }
  for (let i = 0; i < 2; i++) {
    q2[i * 2] = (q1[(i + 1) * 2] - q1[i * 2]) * 2;
    q2[i * 2 + 1] = (q1[(i + 1) * 2 + 1] - q1[i * 2 + 1]) * 2;
  }
  for (let i = 0; i < n; i++) {
    const t = u[i], it = 1 - t;
    bezierPoint(bez, t, tmp);
    const px = pts[(first + i) * 2], py = pts[(first + i) * 2 + 1];
    const d1x = it * it * q1[0] + 2 * it * t * q1[2] + t * t * q1[4];
    const d1y = it * it * q1[1] + 2 * it * t * q1[3] + t * t * q1[5];
    const d2x = it * q2[0] + t * q2[2];
    const d2y = it * q2[1] + t * q2[3];
    const ex = tmp[0] - px, ey = tmp[1] - py;
    const numerator = ex * d1x + ey * d1y;
    const denominator = d1x * d1x + d1y * d1y + ex * d2x + ey * d2y;
    let nt = denominator === 0 ? t : t - numerator / denominator;
    if (nt < 0) nt = 0;
    else if (nt > 1) nt = 1;
    out[i] = nt;
  }
  return out;
}
