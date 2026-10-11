import { describe, expect, it } from 'vitest';
import { PathBuilder, appendContour } from '../src/core/path';
import { polygonize } from '../src/core/simplify';
import { traceMask } from '../src/core/trace';

/** Samples an SVG path (M/L/C/Z, absolute) into points. */
function samplePath(d: string): [number, number][] {
  const tokens = d.replace(/[MLCZ]/g, ' $& ').trim().split(/\s+/);
  const pts: [number, number][] = [];
  let i = 0;
  let cur: [number, number] = [0, 0];
  let cmd = '';
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MLCZ]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z') continue;
    }
    if (cmd === 'M') {
      cur = [num(), num()];
      pts.push(cur);
      cmd = 'L';
    } else if (cmd === 'L') {
      const to: [number, number] = [num(), num()];
      for (let k = 1; k <= 8; k++) pts.push([cur[0] + ((to[0] - cur[0]) * k) / 8, cur[1] + ((to[1] - cur[1]) * k) / 8]);
      cur = to;
    } else if (cmd === 'C') {
      const c = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, it = 1 - t;
        pts.push([
          it ** 3 * cur[0] + 3 * t * it * it * c[0] + 3 * t * t * it * c[2] + t ** 3 * c[4],
          it ** 3 * cur[1] + 3 * t * it * it * c[1] + 3 * t * t * it * c[3] + t ** 3 * c[5],
        ]);
      }
      cur = [c[4], c[5]];
    } else {
      throw new Error(`unexpected token ${t} in ${d}`);
    }
  }
  return pts;
}

function digitize(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return m;
}

function tracePath(mask: Uint8Array, w: number, h: number, simplify: number, smoothing: number, corner = 45): string {
  const [c] = traceMask(mask, w, h);
  const pb = new PathBuilder(3);
  appendContour(pb, c.points, polygonize(c.points, simplify), { smoothing, cornerThreshold: corner });
  return pb.toString();
}

/** Largest distance of any sampled path point from the ideal outline. */
function maxDeviation(d: string, signedDistance: (x: number, y: number) => number): number {
  let max = 0;
  for (const [x, y] of samplePath(d)) max = Math.max(max, Math.abs(signedDistance(x, y)));
  return max;
}

describe('traced geometry', () => {
  it('reproduces a circle with a handful of smooth curves', () => {
    const w = 160, h = 160, R = 60;
    const mask = digitize(w, h, (x, y) => (x - 80) ** 2 + (y - 80) ** 2 < R * R);
    const d = tracePath(mask, w, h, 0.5, 0.5);
    expect((d.match(/C/g) ?? []).length).toBeLessThanOrEqual(2); // implicit repetition: one C per run
    expect(d).not.toContain('L');
    expect(maxDeviation(d, (x, y) => Math.hypot(x - 80, y - 80) - R)).toBeLessThan(1);
  });

  it('keeps the straight sides of a stadium straight and its ends round', () => {
    const w = 200, h = 60, r = 15;
    const inside = (x: number, y: number) => {
      const cx = Math.max(30, Math.min(170, x));
      return (x - cx) ** 2 + (y - 30) ** 2 < r * r;
    };
    const mask = digitize(w, h, inside);
    const d = tracePath(mask, w, h, 0.5, 0.5);
    expect(d).toContain('L');
    const dist = (x: number, y: number) => {
      const cx = Math.max(30, Math.min(170, x));
      return Math.hypot(x - cx, y - 30) - r;
    };
    expect(maxDeviation(d, dist)).toBeLessThan(0.9);
  });

  it('keeps the corners of a rotated square sharp', () => {
    const w = 120, h = 120, half = 30, a = (25 * Math.PI) / 180;
    const mask = digitize(w, h, (x, y) => {
      const u = (x - 60) * Math.cos(a) + (y - 60) * Math.sin(a);
      const v = -(x - 60) * Math.sin(a) + (y - 60) * Math.cos(a);
      return Math.abs(u) < half && Math.abs(v) < half;
    });
    const d = tracePath(mask, w, h, 0.5, 0.5);
    expect(d).not.toContain('C');
    expect((d.match(/[0-9.]+ [0-9.]+/g) ?? []).length).toBe(4);
    const dist = (x: number, y: number) => {
      const u = (x - 60) * Math.cos(a) + (y - 60) * Math.sin(a);
      const v = -(x - 60) * Math.sin(a) + (y - 60) * Math.cos(a);
      return Math.max(Math.abs(u), Math.abs(v)) - half;
    };
    expect(maxDeviation(d, dist)).toBeLessThan(0.6);
  });

  it('never balloons between the corners of a triangle', () => {
    const w = 200, h = 160;
    const A = [20, 140], B = [180, 140], C = [100, 20];
    const edge = (p: number[], q: number[], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const mask = digitize(w, h, (x, y) => edge(A, B, x, y) <= 0 && edge(B, C, x, y) <= 0 && edge(C, A, x, y) <= 0);
    const d = tracePath(mask, w, h, 0.5, 0.5);
    const lineDist = (p: number[], q: number[], x: number, y: number) => Math.abs(edge(p, q, x, y)) / Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dist = (x: number, y: number) => Math.min(lineDist(A, B, x, y), lineDist(B, C, x, y), lineDist(C, A, x, y));
    expect(maxDeviation(d, dist)).toBeLessThan(0.8);
  });
});
