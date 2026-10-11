import { TRANSPARENT } from './quantize';

/**
 * Merges every 8-connected region of fewer than `minArea` pixels into the color
 * that surrounds it most. Operates in place on the palette index map.
 * Transparent (`TRANSPARENT`) counts as a color, so tiny holes get filled and
 * tiny floating specks disappear.
 */
export function despeckle(index: Uint8Array, w: number, h: number, minArea: number, passes = 2): void {
  if (minArea <= 1) return;
  const n = w * h;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(n);
  const hist = new Int32Array(256);

  for (let pass = 0; pass < passes; pass++) {
    visited.fill(0);
    let changed = false;
    for (let start = 0; start < n; start++) {
      if (visited[start]) continue;
      const color = index[start];
      let sp = 0, size = 0;
      stack[sp++] = start;
      visited[start] = 1;
      hist.fill(0);
      while (sp > 0) {
        const p = stack[--sp];
        comp[size++] = p;
        const x = p % w;
        const y = (p - x) / w;
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            const q = row + xx;
            const c = index[q];
            if (c !== color) {
              hist[c]++;
            } else if (!visited[q]) {
              visited[q] = 1;
              stack[sp++] = q;
            }
          }
        }
      }
      if (size < minArea) {
        let best = -1, bestCount = 0;
        for (let c = 0; c < 256; c++) {
          if (hist[c] > bestCount) {
            bestCount = hist[c];
            best = c;
          }
        }
        if (best >= 0 && best !== color) {
          for (let i = 0; i < size; i++) index[comp[i]] = best;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/**
 * Makes the border-connected region of the most common border color
 * transparent (4-connected flood fill from the image edges).
 * Returns the palette index that was removed, or -1 if nothing changed.
 */
export function removeBackground(index: Uint8Array, w: number, h: number): number {
  const n = w * h;
  if (n === 0) return -1;
  const hist = new Int32Array(256);
  for (let x = 0; x < w; x++) {
    hist[index[x]]++;
    hist[index[(h - 1) * w + x]]++;
  }
  for (let y = 1; y < h - 1; y++) {
    hist[index[y * w]]++;
    hist[index[y * w + w - 1]]++;
  }
  let bg = -1, bgCount = 0;
  for (let c = 0; c < TRANSPARENT; c++) {
    if (hist[c] > bgCount) {
      bgCount = hist[c];
      bg = c;
    }
  }
  if (bg < 0 || hist[TRANSPARENT] > bgCount) return -1;

  const stack = new Int32Array(n);
  let sp = 0;
  const push = (p: number) => {
    if (index[p] === bg) {
      index[p] = TRANSPARENT;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  return bg;
}
