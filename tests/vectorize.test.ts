import { describe, expect, it } from 'vitest';
import { PathBuilder } from '../src/core/path';
import { vectorize } from '../src/core/vectorize';
import { mulberry32 } from '../src/core/quantize';
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

describe('upscale', () => {
  function aaCircle(w: number, h: number, cx: number, cy: number, r: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let cov = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if ((x + (sx + 0.5) / 4 - cx) ** 2 + (y + (sy + 0.5) / 4 - cy) ** 2 < r * r) cov++;
        cov /= 16;
        const p = (y * w + x) * 4;
        data[p] = Math.round(255 * (1 - cov));
        data[p + 1] = Math.round(255 * (1 - cov));
        data[p + 2] = Math.round(255 * (1 - cov) + 40 * cov);
        data[p + 3] = 255;
      }
    return { data, width: w, height: h };
  }

  it('keeps the output size and places edges more precisely', () => {
    const img = aaCircle(60, 60, 30.3, 29.6, 14);
    const one = vectorize(img, { colors: 2, minArea: 0, simplify: 0, smoothing: 0, precision: 3, upscale: 1 });
    const two = vectorize(img, { colors: 2, minArea: 0, simplify: 0, smoothing: 0, precision: 3, upscale: 2 });
    expect(two.width).toBe(60);
    expect(two.height).toBe(60);
    expect(two.scale).toBe(2);
    expect(one.scale).toBe(1);
    // Polygon vertices of the dark shape: the 2x trace lands on half-pixels.
    const vertices = (svg: string) => {
      const d = /fill="#(?![c-f][0-9a-f])[0-9a-f]{6}" d="([^"]+)"/.exec(svg)![1];
      return (d.match(/-?\d+\.?\d*/g) ?? []).map(Number);
    };
    const dev = (svg: string) => {
      const v = vertices(svg);
      let max = 0;
      for (let i = 0; i < v.length; i += 2) max = Math.max(max, Math.abs(Math.hypot(v[i] - 30.3, v[i + 1] - 29.6) - 14));
      return max;
    };
    expect(dev(two.svg)).toBeLessThan(dev(one.svg));
    expect(dev(two.svg)).toBeLessThan(0.6);
  });

  it('is automatic for small images only', () => {
    const img = aaCircle(40, 40, 20, 20, 10);
    expect(vectorize(img, { colors: 2 }).scale).toBe(2);
    expect(vectorize(img, { colors: 2, maxSize: 0, upscale: 3 }).scale).toBe(3);
  });
});

describe('overlap', () => {
  function halves(w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const left = x < w / 2;
        data[p] = left ? 220 : 30;
        data[p + 1] = 40;
        data[p + 2] = left ? 40 : 200;
        data[p + 3] = 255;
      }
    return { data, width: w, height: h };
  }

  it('extends earlier shapes under later ones by the requested distance', () => {
    const img = halves(40, 20);
    const xs = (overlap: number) => {
      const res = vectorize(img, { colors: 2, minArea: 0, simplify: 0, smoothing: 0, upscale: 1, overlap, precision: 0 });
      const d = /fill="#dc2828" d="([^"]+)"/.exec(res.svg)![1];
      return (d.match(/-?\d+/g) ?? []).map(Number).filter((_, i) => i % 2 === 0);
    };
    expect(Math.max(...xs(0))).toBe(20);
    expect(Math.max(...xs(1))).toBe(21);
    expect(Math.max(...xs(4))).toBe(24);
  });
});

describe('stacked painting order', () => {
  /** Paints an exact-mode (lines only) SVG the way a renderer would: paths in order, evenodd, sampled at pixel centres. */
  function rasterize(svg: string, w: number, h: number): string[] {
    const out = new Array<string>(w * h).fill('');
    for (const m of svg.matchAll(/<path fill="(#[0-9a-f]{6})" d="([^"]+)"/g)) {
      const polys: number[][] = [];
      for (const sub of m[2].split('M').filter(Boolean)) polys.push((sub.match(/-?\d+\.?\d*/g) ?? []).map(Number));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = x + 0.5, py = y + 0.5;
          let crossings = 0;
          for (const p of polys) {
            for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
              const x0 = p[j], y0 = p[j + 1], x1 = p[i], y1 = p[i + 1];
              if (y0 > py !== y1 > py && px < x0 + ((py - y0) * (x1 - x0)) / (y1 - y0)) crossings++;
            }
          }
          if (crossings % 2 === 1) out[y * w + x] = m[1];
        }
      }
    }
    return out;
  }

  it('reproduces the quantized image exactly for any overlap', () => {
    const w = 48, h = 48;
    const data = new Uint8ClampedArray(w * h * 4);
    const rand = mulberry32(11);
    const colors = [
      [255, 255, 255],
      [200, 30, 30],
      [30, 60, 200],
      [30, 160, 60],
    ];
    // Random mosaic of small tiles plus a few single-pixel specks.
    const tiles: number[][] = [];
    for (let ty = 0; ty < 6; ty++) for (let tx = 0; tx < 6; tx++) tiles.push(colors[Math.floor(rand() * 4)]);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let c = tiles[Math.floor(y / 8) * 6 + Math.floor(x / 8)];
        if (rand() < 0.03) c = colors[Math.floor(rand() * 4)];
        const p = (y * w + x) * 4;
        data.set([c[0], c[1], c[2], 255], p);
      }
    const img = { data, width: w, height: h };
    const expected = vectorize(img, { colors: 4, minArea: 0, simplify: 0, smoothing: 0, upscale: 1, overlap: 0, precision: 0, layering: 'cutout' });
    const truth = rasterize(expected.svg, w, h);
    expect(truth.every((c) => c !== '')).toBe(true);
    for (const overlap of [0, 2, 6]) {
      const res = vectorize(img, { colors: 4, minArea: 0, simplify: 0, smoothing: 0, upscale: 1, overlap, precision: 0 });
      const painted = rasterize(res.svg, w, h);
      let wrong = 0;
      for (let i = 0; i < truth.length; i++) if (painted[i] !== truth[i]) wrong++;
      expect(wrong, `overlap ${overlap}`).toBe(0);
    }
  });
});
