import { TRANSPARENT } from './quantize';

/**
 * Labels 8-connected regions of equal palette index. Transparent pixels get
 * label -1. Labels are assigned in scan order, so a smaller label always has
 * its topmost-leftmost pixel earlier in scan order; that order is used as the
 * painting order in stacked mode.
 */
export function labelComponents(index: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || index[start] === TRANSPARENT) continue;
    const color = index[start];
    const label = count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx;
          if (labels[q] === -1 && index[q] === color) {
            labels[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
  }
  return { labels, count };
}

/** 8-connected labeling of a binary mask; 0 = unfilled, labels start at 1. */
export function labelMask(mask: Uint8Array, w: number, h: number, out: Int32Array, stack: Int32Array): number {
  const n = w * h;
  out.fill(0);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (out[start] !== 0 || mask[start] === 0) continue;
    const label = ++count;
    let sp = 0;
    stack[sp++] = start;
    out[start] = label;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx;
          if (out[q] === 0 && mask[q] !== 0) {
            out[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
  }
  return count;
}

/**
 * For stacked rendering every shape is painted with an overlap of `radius`
 * pixels into the neighbouring shapes that are painted after it, so neither
 * simplification nor anti-aliasing at small render sizes can open a seam.
 * This computes, per palette index, the list of foreign pixels that its masks
 * should additionally include (CSR layout: `offsets[c]` .. `offsets[c + 1]`
 * into `pixels`).
 *
 * Borrowing grows outward from each region, breadth first, but never through
 * a region painted before the borrowing one, and a pixel is only borrowed when
 * that cannot merge two regions of the same color: it must be reachable from
 * exactly one region of that color, and neighbouring borrowed pixels must come
 * from the same region. Otherwise the painting order (one shape per region)
 * would no longer be well defined.
 */
export function dilationLists(
  index: Uint8Array,
  labels: Int32Array,
  w: number,
  h: number,
  paletteSize: number,
  radius: number,
): { offsets: Int32Array; pixels: Int32Array } {
  const n = w * h;
  const offsets = new Int32Array(paletteSize + 1);
  if (radius <= 0) return { offsets, pixels: new Int32Array(0) };

  // Pixels grouped by color (counting sort).
  const byColorOffsets = new Int32Array(paletteSize + 1);
  for (let p = 0; p < n; p++) if (index[p] !== TRANSPARENT) byColorOffsets[index[p] + 1]++;
  for (let c = 0; c < paletteSize; c++) byColorOffsets[c + 1] += byColorOffsets[c];
  const byColor = new Int32Array(byColorOffsets[paletteSize]);
  {
    const cursor = byColorOffsets.slice(0, paletteSize);
    for (let p = 0; p < n; p++) if (index[p] !== TRANSPARENT) byColor[cursor[index[p]]++] = p;
  }

  const src = new Int32Array(n); // source region label, or -1 when conflicting
  const stamp = new Int32Array(n); // color + 1 of the last pass that touched the pixel
  let frontier = new Int32Array(n);
  let next = new Int32Array(n);
  const perColor: Int32Array[] = [];
  let total = 0;

  for (let c = 0; c < paletteSize; c++) {
    const gen = c + 1;
    let fc = 0;
    for (let i = byColorOffsets[c]; i < byColorOffsets[c + 1]; i++) {
      const p = byColor[i];
      src[p] = labels[p];
      stamp[p] = gen;
      frontier[fc++] = p;
    }
    const borrowed: number[] = [];
    for (let round = 0; round < radius && fc > 0; round++) {
      let nc = 0;
      for (let i = 0; i < fc; i++) {
        const p = frontier[i];
        const S = src[p];
        if (S < 0) continue;
        const x = p % w;
        const y = (p - x) / w;
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            const q = row + xx;
            const iq = index[q];
            if (iq === c || iq === TRANSPARENT) continue;
            if (labels[q] < S) continue; // q's region is painted before the source: cannot extend under it
            if (stamp[q] === gen) {
              if (src[q] !== S) src[q] = -1; // reachable from two regions of this color
              continue;
            }
            stamp[q] = gen;
            src[q] = S;
            next[nc++] = q;
            borrowed.push(q);
          }
        }
      }
      const t = frontier;
      frontier = next;
      next = t;
      fc = nc;
    }
    // Final consistency pass: borrowed pixels next to a pixel of this color's
    // pass that stems from another region are dropped (both sides).
    const drop = new Uint8Array(borrowed.length);
    for (let i = 0; i < borrowed.length; i++) {
      const p = borrowed[i];
      const S = src[p];
      if (S < 0) {
        drop[i] = 1;
        continue;
      }
      const x = p % w;
      const y = (p - x) / w;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let yy = y0; yy <= y1 && !drop[i]; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx;
          if (stamp[q] === gen && src[q] !== S) {
            drop[i] = 1;
            break;
          }
        }
      }
    }
    const kept: number[] = [];
    for (let i = 0; i < borrowed.length; i++) if (!drop[i]) kept.push(borrowed[i]);
    const arr = Int32Array.from(kept);
    perColor.push(arr);
    total += arr.length;
    offsets[c + 1] = total;
  }
  const pixels = new Int32Array(total);
  for (let c = 0; c < paletteSize; c++) pixels.set(perColor[c], offsets[c]);
  return { offsets, pixels };
}
