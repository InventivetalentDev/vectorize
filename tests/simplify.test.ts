import { describe, expect, it } from 'vitest';
import { polygonize } from '../src/core/simplify';
import { traceMask } from '../src/core/trace';

function digitize(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return m;
}

describe('polygonize', () => {
  it('keeps every vertex for epsilon 0', () => {
    const p = [0, 0, 10, 0, 10, 10, 0, 10];
    const poly = polygonize(p, 0);
    expect(poly.count).toBe(4);
    expect(Array.from(poly.pos)).toEqual(p);
    expect(Array.from(poly.dir.slice(0, 2))).toEqual([1, 0]);
  });

  it('collapses pixel staircases of any slope into single segments', () => {
    for (const deg of [10, 30, 46, 60, 80]) {
      const m = Math.tan((deg * Math.PI) / 180);
      const w = 80, h = 80;
      const mask = digitize(w, h, (x, y) => y > m * (x - 10.3));
      const [{ points }] = traceMask(mask, w, h);
      const poly = polygonize(points, 0.3);
      // image border corners + the two ends of the diagonal edge
      expect(poly.count).toBeLessThanOrEqual(5);
    }
  });

  it('reconstructs the corners of a rotated square', () => {
    const w = 100, h = 100, cx = 50, cy = 50, half = 25, a = (20 * Math.PI) / 180;
    const mask = digitize(w, h, (x, y) => {
      const u = (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a);
      const v = -(x - cx) * Math.sin(a) + (y - cy) * Math.cos(a);
      return Math.abs(u) < half && Math.abs(v) < half;
    });
    const [{ points }] = traceMask(mask, w, h);
    const poly = polygonize(points, 0.6);
    expect(poly.count).toBe(4);
    const expected: [number, number][] = [];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      expected.push([cx + su * half * Math.cos(a) - sv * half * Math.sin(a), cy + su * half * Math.sin(a) + sv * half * Math.cos(a)]);
    }
    for (let i = 0; i < 4; i++) {
      const x = poly.pos[i * 2], y = poly.pos[i * 2 + 1];
      const best = Math.min(...expected.map(([ex, ey]) => Math.hypot(ex - x, ey - y)));
      expect(best).toBeLessThan(0.6);
    }
  });

  it('does not collapse a 1px thin line', () => {
    const w = 40, h = 3;
    const m = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) m[w + x] = 1;
    const [{ points }] = traceMask(m, w, h);
    expect(polygonize(points, 2).count).toBeGreaterThanOrEqual(3);
  });

  it('approximates a circle with evenly spread vertices', () => {
    const w = 120, h = 120;
    const mask = digitize(w, h, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 40 ** 2);
    const [{ points }] = traceMask(mask, w, h);
    const poly = polygonize(points, 0.6);
    expect(poly.count).toBeGreaterThan(8);
    expect(poly.count).toBeLessThan(40);
    for (let i = 0; i < poly.count; i++) {
      expect(Math.abs(Math.hypot(poly.pos[i * 2] - 60, poly.pos[i * 2 + 1] - 60) - 40)).toBeLessThan(1.5);
    }
  });
});
