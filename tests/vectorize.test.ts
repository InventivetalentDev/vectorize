import { describe, expect, it } from 'vitest';
import { PathBuilder } from '../src/core/path';
import { vectorize } from '../src/core/vectorize';
import type { RasterImage } from '../src/core/types';

function sample(): RasterImage {
  const w = 64, h = 48;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const inCircle = (x - 32) ** 2 + (y - 24) ** 2 < 15 ** 2;
      const inBar = y >= 40 && y < 44 && x >= 8 && x < 56;
      const [r, g, b] = inCircle ? [220, 40, 40] : inBar ? [20, 20, 200] : [255, 255, 255];
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  return { data, width: w, height: h };
}

describe('vectorize', () => {
  it('produces an SVG with one path per color', () => {
    const res = vectorize(sample(), { colors: 4, minArea: 0, simplify: 0, smoothing: 0 });
    expect(res.width).toBe(64);
    expect(res.height).toBe(48);
    expect(res.palette.length).toBe(3);
    expect(res.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"')).toBe(true);
    expect((res.svg.match(/<path /g) ?? []).length).toBe(3);
    // stacked: background rect (holes filled) + circle + bar
    expect(res.paths).toBe(3);
    const cut = vectorize(sample(), { colors: 4, minArea: 0, simplify: 0, smoothing: 0, layering: 'cutout' });
    // cutout: white rect with 2 holes + circle + bar
    expect(cut.paths).toBe(5);
    expect(res.svg).toContain('fill="#ffffff"');
    expect(res.svg).toContain('fill="#dc2828"');
  });

  it('smoothing emits curves and simplification reduces points', () => {
    const img = sample();
    const raw = vectorize(img, { colors: 4, simplify: 0, smoothing: 0 });
    const simple = vectorize(img, { colors: 4, simplify: 1, smoothing: 1 });
    expect(simple.points).toBeLessThan(raw.points);
    expect(simple.svg).toContain('C');
    expect(raw.svg).not.toContain('C');
  });

  it('cutout mode adds a seam stroke when requested', () => {
    const res = vectorize(sample(), { colors: 4, layering: 'cutout', strokeWidth: 0.5 });
    expect(res.svg).toContain('stroke-width="0.5"');
    expect(res.svg).toContain('stroke="#ffffff"');
  });

  it('hidden colors are left out', () => {
    const res = vectorize(sample(), { colors: 4, hidden: ['#ffffff'] });
    expect(res.svg).not.toContain('fill="#ffffff"');
    expect(res.palette.find((p) => p.color === '#ffffff')?.hidden).toBe(true);
  });

  it('downscales to maxSize', () => {
    const res = vectorize(sample(), { maxSize: 32, colors: 4 });
    expect(res.width).toBe(32);
    expect(res.height).toBe(24);
  });
});

describe('PathBuilder', () => {
  it('writes compact path data', () => {
    const pb = new PathBuilder(1);
    pb.moveTo(1, 2);
    pb.lineTo(3.25, -4);
    pb.lineTo(5, 6);
    pb.close();
    expect(pb.toString()).toBe('M1 2L3.3-4 5 6Z');
  });
});
