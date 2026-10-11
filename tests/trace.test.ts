import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/quantize';
import { polygonArea, traceMask } from '../src/core/trace';

function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length, w = rows[0].length;
  const m = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (m[y * w + x] = c === '#' ? 1 : 0)));
  return { m, w, h };
}

function totalArea(polys: number[][]): number {
  return polys.reduce((s, p) => s + polygonArea(p), 0);
}
const pts = (cs: { points: number[] }[]) => cs.map((c) => c.points);

describe('traceMask', () => {
  it('traces a single pixel as a clockwise square', () => {
    const { m, w, h } = mask(['...', '.#.', '...']);
    const cs = traceMask(m, w, h);
    expect(pts(cs)).toEqual([[1, 1, 2, 1, 2, 2, 1, 2]]);
    expect(cs[0].hole).toBe(false);
    expect(cs[0].inside).toBe(4);
    expect(polygonArea(cs[0].points)).toBe(1);
  });

  it('drops collinear vertices', () => {
    const { m, w, h } = mask(['####', '####']);
    const polys = pts(traceMask(m, w, h));
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(8);
    expect(polygonArea(polys[0])).toBe(8);
  });

  it('traces holes counter-clockwise', () => {
    const { m, w, h } = mask(['###', '#.#', '###']);
    const cs = traceMask(m, w, h);
    expect(cs).toHaveLength(2);
    const areas = pts(cs).map(polygonArea).sort((a, b) => a - b);
    expect(areas).toEqual([-1, 9]);
    const hole = cs.find((c) => c.hole)!;
    expect(hole.outside).toBe(4);
    expect(hole.inside).toBe(1);
  });

  it('keeps diagonally touching pixels in one contour', () => {
    const { m, w, h } = mask(['#.', '.#']);
    const polys = pts(traceMask(m, w, h));
    expect(polys).toHaveLength(1);
    expect(polygonArea(polys[0])).toBe(2);
  });

  it('conserves area on random masks', () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 30; trial++) {
      const w = 1 + Math.floor(rand() * 40), h = 1 + Math.floor(rand() * 40);
      const m = new Uint8Array(w * h);
      const density = rand();
      let filled = 0;
      for (let i = 0; i < m.length; i++) {
        m[i] = rand() < density ? 1 : 0;
        filled += m[i];
      }
      const polys = pts(traceMask(m, w, h));
      expect(totalArea(polys)).toBe(filled);
      // every vertex must be an integer grid corner
      for (const p of polys) for (const v of p) expect(Number.isInteger(v)).toBe(true);
    }
  });
});
