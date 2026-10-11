import { describe, expect, it } from 'vitest';
import { toHex } from '../src/core/color';
import { despeckle, removeBackground } from '../src/core/despeckle';
import { quantize, TRANSPARENT } from '../src/core/quantize';
import type { RasterImage } from '../src/core/types';

function solid(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number?]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fill(x, y);
      const p = (y * w + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  return { data, width: w, height: h };
}

const opaque = (n: number) => new Uint8Array(n).fill(1);

describe('quantize', () => {
  it('finds exactly the colors of a two-color image even when asking for more', () => {
    const img = solid(20, 10, (x) => (x < 10 ? [255, 0, 0] : [0, 0, 255]));
    const q = quantize(img, opaque(200), { mode: 'auto', colors: 8, palette: [], threshold: 128 });
    expect(q.palette.length).toBe(2);
    const hexes = q.palette.map((c) => toHex(...c)).sort();
    expect(hexes).toEqual(['#0000ff', '#ff0000']);
    expect(Array.from(q.counts).sort()).toEqual([100, 100]);
  });

  it('maps to the nearest color of a custom palette', () => {
    const img = solid(4, 1, (x) => [x * 80, x * 80, x * 80]);
    const q = quantize(img, opaque(4), { mode: 'palette', colors: 0, palette: ['#000', '#fff'], threshold: 128 });
    expect(Array.from(q.index)).toEqual([0, 0, 1, 1]);
  });

  it('thresholds in bw mode and respects transparency', () => {
    const img = solid(3, 1, (x) => [x * 100 + 50, x * 100 + 50, x * 100 + 50, x === 2 ? 0 : 255]);
    const mask = new Uint8Array([1, 1, 0]);
    const q = quantize(img, mask, { mode: 'bw', colors: 0, palette: [], threshold: 128 });
    expect(Array.from(q.index)).toEqual([0, 1, TRANSPARENT]);
  });

  it('reduces a gradient to the requested number of gray levels', () => {
    const img = solid(256, 2, (x) => [x, x, x]);
    const q = quantize(img, opaque(512), { mode: 'grayscale', colors: 4, palette: [], threshold: 128 });
    expect(q.palette.length).toBe(4);
    for (const c of q.palette) expect(c[0]).toBe(c[1]);
  });
});

describe('despeckle', () => {
  it('merges tiny specks into their surroundings', () => {
    const w = 10, h = 10;
    const index = new Uint8Array(w * h);
    index[5 * w + 5] = 1;
    index[2 * w + 2] = TRANSPARENT;
    despeckle(index, w, h, 4);
    expect(index.every((v) => v === 0)).toBe(true);
  });

  it('leaves regions at or above the minimum alone', () => {
    const w = 10, h = 10;
    const index = new Uint8Array(w * h);
    for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) index[y * w + x] = 1;
    despeckle(index, w, h, 4);
    expect(index[2 * w + 2]).toBe(1);
  });
});

describe('removeBackground', () => {
  it('clears only the border-connected background', () => {
    const w = 7, h = 7;
    const index = new Uint8Array(w * h); // all color 0
    // a ring of color 1 with a color-0 center that must survive
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) index[y * w + x] = 1;
    index[3 * w + 3] = 0;
    expect(removeBackground(index, w, h)).toBe(0);
    expect(index[0]).toBe(TRANSPARENT);
    expect(index[3 * w + 3]).toBe(0);
    expect(index[1 * w + 1]).toBe(1);
  });
});
