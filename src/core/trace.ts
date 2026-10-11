/**
 * Binary mask -> closed contours along pixel edges.
 *
 * Every boundary edge between a filled and an empty pixel (or the image border)
 * is oriented so that the filled side is on the right. Contours are then formed
 * by walking these directed edges; at ambiguous (checkerboard) vertices we
 * prefer turning left, which makes diagonally touching filled pixels part of
 * the same shape (8-connectivity for filled, 4-connectivity for empty).
 *
 * Outer contours come out clockwise in screen space (y down), holes
 * counter-clockwise. Collinear vertices are dropped on the fly.
 */

/** Flat polygon: [x0, y0, x1, y1, ...], implicitly closed. */
export type Polygon = number[];

export interface Contour {
  points: Polygon;
  /** True for the boundary of a hole (empty region enclosed by filled pixels). */
  hole: boolean;
  /** Index of a filled pixel touching the first edge (identifies the shape). */
  inside: number;
  /** Index of an empty pixel touching the first edge, or -1 when that is outside the image. */
  outside: number;
}

const E = 0, S = 1, W = 2; // N = 3

export function traceMask(mask: Uint8Array, w: number, h: number): Contour[] {
  // hor[y * w + x]: edge from (x, y) to (x + 1, y). 1 = eastbound, 2 = westbound.
  const hor = new Uint8Array(w * (h + 1));
  // ver[y * (w + 1) + x]: edge from (x, y) to (x, y + 1). 1 = southbound, 2 = northbound.
  const ver = new Uint8Array((w + 1) * h);

  for (let y = 0; y <= h; y++) {
    const above = y > 0 ? (y - 1) * w : -1;
    const below = y < h ? y * w : -1;
    for (let x = 0; x < w; x++) {
      const a = above >= 0 ? mask[above + x] : 0;
      const b = below >= 0 ? mask[below + x] : 0;
      if (a !== b) hor[y * w + x] = b ? 1 : 2;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x <= w; x++) {
      const l = x > 0 ? mask[row + x - 1] : 0;
      const r = x < w ? mask[row + x] : 0;
      if (l !== r) ver[y * (w + 1) + x] = l ? 1 : 2;
    }
  }

  const contours: Contour[] = [];
  const w1 = w + 1;

  for (let ey = 0; ey <= h; ey++) {
    for (let ex = 0; ex < w; ex++) {
      const e = hor[ey * w + ex];
      if (e === 0) continue;
      hor[ey * w + ex] = 0;
      let x: number, y: number, dir: number;
      const sx = e === 1 ? ex : ex + 1;
      const sy = ey;
      if (e === 1) {
        x = ex + 1;
        y = ey;
        dir = E;
      } else {
        x = ex;
        y = ey;
        dir = W;
      }
      const poly: Polygon = [sx, sy];

      for (;;) {
        // Try left turn, straight, right turn (in that order).
        let next = -1;
        for (let t = 3; t <= 5; t++) {
          const nd = (dir + t) & 3;
          if (nd === E) {
            if (x < w && hor[y * w + x] === 1) {
              hor[y * w + x] = 0;
              next = nd;
              break;
            }
          } else if (nd === W) {
            if (x > 0 && hor[y * w + x - 1] === 2) {
              hor[y * w + x - 1] = 0;
              next = nd;
              break;
            }
          } else if (nd === S) {
            if (y < h && ver[y * w1 + x] === 1) {
              ver[y * w1 + x] = 0;
              next = nd;
              break;
            }
          } else {
            if (y > 0 && ver[(y - 1) * w1 + x] === 2) {
              ver[(y - 1) * w1 + x] = 0;
              next = nd;
              break;
            }
          }
        }
        if (next < 0) break; // back at the start with nothing left to walk
        if (next !== dir) {
          poly.push(x, y);
          dir = next;
        }
        if (dir === E) x++;
        else if (dir === W) x--;
        else if (dir === S) y++;
        else y--;
      }

      // The start vertex may sit in the middle of a straight run.
      const len = poly.length;
      if (len >= 6) {
        const lx = poly[len - 2], ly = poly[len - 1];
        if ((lx === poly[0] && poly[0] === poly[2]) || (ly === poly[1] && poly[1] === poly[3])) {
          poly.shift();
          poly.shift();
        }
      }
      if (poly.length < 6) continue;
      // The first hor edge of a contour found in scan order is its topmost one:
      // filled below it means an outer boundary, filled above it means a hole.
      const hole = e === 2;
      contours.push({
        points: poly,
        hole,
        inside: hole ? (ey - 1) * w + ex : ey * w + ex,
        outside: hole ? ey * w + ex : ey > 0 ? (ey - 1) * w + ex : -1,
      });
    }
  }
  return contours;
}

/** Signed area (shoelace); positive for clockwise in screen coordinates. */
export function polygonArea(poly: Polygon): number {
  let area = 0;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    area += (poly[j] - poly[i]) * (poly[j + 1] + poly[i + 1]);
  }
  return area / 2;
}
