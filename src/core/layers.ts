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
 * For stacked rendering every shape is painted with a 1px overlap into the
 * neighbouring shapes that are painted after it, so simplification can never
 * open a seam. This computes, per palette index, the list of foreign pixels
 * that its masks should additionally include (CSR layout: `offsets[c]` ..
 * `offsets[c + 1]` into `pixels`).
 *
 * A pixel is only borrowed when that cannot merge two regions of the same
 * color: it must touch exactly one region of that color, and neighbouring
 * borrowed pixels must come from the same region. Otherwise the painting
 * order (one shape per region) would no longer be well defined.
 */
export function dilationLists(
  index: Uint8Array,
  labels: Int32Array,
  w: number,
  h: number,
  paletteSize: number,
): { offsets: Int32Array; pixels: Int32Array } {
  const n = w * h;
  const offsets = new Int32Array(paletteSize + 1);
  const cols = new Int32Array(8);
  const srcs = new Int32Array(8);
  let pixels = new Int32Array(0);
  let sources = new Int32Array(0);
  let cursor = new Int32Array(0);

  // Pass 0 counts candidates per color, pass 1 stores them with their source region.
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      for (let c = 0; c < paletteSize; c++) offsets[c + 1] += offsets[c];
      pixels = new Int32Array(offsets[paletteSize]);
      sources = new Int32Array(offsets[paletteSize]);
      cursor = offsets.slice(0, paletteSize);
    }
    for (let p = 0; p < n; p++) {
      const ip = index[p];
      if (ip === TRANSPARENT) continue;
      const lp = labels[p];
      const x = p % w;
      const y = (p - x) / w;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      let m = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx;
          const iq = index[q];
          if (iq === ip || iq === TRANSPARENT) continue;
          const lq = labels[q];
          let j = 0;
          while (j < m && cols[j] !== iq) j++;
          if (j === m) {
            cols[m] = iq;
            srcs[m] = lq;
            m++;
          } else if (srcs[j] !== lq) {
            srcs[j] = -1; // touches two regions of this color: never borrow
          }
        }
      }
      for (let j = 0; j < m; j++) {
        if (srcs[j] < 0 || srcs[j] >= lp) continue; // conflict, or painted after p
        if (pass === 0) offsets[cols[j] + 1]++;
        else {
          pixels[cursor[cols[j]]] = p;
          sources[cursor[cols[j]]++] = srcs[j];
        }
      }
    }
  }

  // Pass 2: drop borrowed pixels next to a borrowed pixel from another region.
  const src = new Int32Array(n);
  const stamp = new Int32Array(n);
  const keep = new Uint8Array(pixels.length).fill(1);
  for (let c = 0; c < paletteSize; c++) {
    const gen = c + 1;
    for (let i = offsets[c]; i < offsets[c + 1]; i++) {
      src[pixels[i]] = sources[i];
      stamp[pixels[i]] = gen;
    }
    for (let i = offsets[c]; i < offsets[c + 1]; i++) {
      const p = pixels[i];
      const x = p % w;
      const y = (p - x) / w;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let yy = y0; yy <= y1 && keep[i]; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const q = row + xx;
          if (stamp[q] === gen && src[q] !== sources[i]) {
            keep[i] = 0;
            break;
          }
        }
      }
    }
  }
  const outOffsets = new Int32Array(paletteSize + 1);
  let total = 0;
  for (let c = 0; c < paletteSize; c++) {
    for (let i = offsets[c]; i < offsets[c + 1]; i++) total += keep[i];
    outOffsets[c + 1] = total;
  }
  const outPixels = new Int32Array(total);
  for (let c = 0, j = 0; c < paletteSize; c++) {
    for (let i = offsets[c]; i < offsets[c + 1]; i++) if (keep[i]) outPixels[j++] = pixels[i];
  }
  return { offsets: outOffsets, pixels: outPixels };
}
