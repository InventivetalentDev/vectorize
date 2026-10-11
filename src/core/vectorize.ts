import { toHex, type RGB } from './color';
import { despeckle, removeBackground } from './despeckle';
import { blur, downscale, opaqueMask, upscale } from './image';
import { dilationLists, labelComponents, labelMask } from './layers';
import { appendContour, PathBuilder } from './path';
import { quantize, TRANSPARENT } from './quantize';
import { polygonize } from './simplify';
import { buildSvg, type SvgLayer } from './svg';
import { traceMask, type Contour } from './trace';
import {
  DEFAULT_OPTIONS,
  type PaletteInfo,
  type ProgressFn,
  type RasterImage,
  type VectorizeOptions,
  type VectorizeResult,
} from './types';

/** Everything the tracing stage needs; produced by {@link prepare}. */
export interface Prepared {
  /** Working resolution (already multiplied by `scale`). */
  width: number;
  height: number;
  /** Resolution multiple relative to the input image. */
  scale: number;
  /** Palette index per pixel (TRANSPARENT for dropped pixels). */
  index: Uint8Array;
  palette: RGB[];
  info: PaletteInfo[];
  timings: Record<string, number>;
}

/** Option keys that influence {@link prepare}. Anything else only affects {@link trace}. */
export const PREPARE_KEYS: (keyof VectorizeOptions)[] = [
  'maxSize',
  'blur',
  'upscale',
  'mode',
  'colors',
  'palette',
  'threshold',
  'alphaThreshold',
  'removeBackground',
  'hidden',
  'minArea',
];

const noop: ProgressFn = () => {};
/** Images up to this many pixels are traced at 2x when `upscale` is automatic. */
const AUTO_UPSCALE_MAX_PIXELS = 1024 * 1024;

/** Resize, blur, quantize and clean up the image. */
export function prepare(image: RasterImage, options: Partial<VectorizeOptions> = {}, progress: ProgressFn = noop): Prepared {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const timings: Record<string, number> = {};
  let t = now();

  progress('resize', 0);
  let img = downscale(image, o.maxSize);
  const scale = o.upscale > 0 ? Math.round(o.upscale) : img.width * img.height <= AUTO_UPSCALE_MAX_PIXELS ? 2 : 1;
  if (scale > 1) img = upscale(img, scale);
  if (o.blur > 0) img = blur(img, o.blur * scale);
  const { width, height } = img;
  timings.preprocess = now() - t;
  t = now();

  progress('quantize', 0.1);
  const opaque = opaqueMask(img, o.alphaThreshold);
  const q = quantize(img, opaque, { mode: o.mode, colors: o.colors, palette: o.palette, threshold: o.threshold });
  timings.quantize = now() - t;
  t = now();

  const hiddenSet = new Set(o.hidden.map((h) => h.toLowerCase()));
  const info: PaletteInfo[] = q.palette.map((c, i) => {
    const color = toHex(c[0], c[1], c[2]);
    return { color, count: q.counts[i], hidden: hiddenSet.has(color) };
  });
  const hiddenIdx = new Uint8Array(256);
  let anyHidden = false;
  info.forEach((p, i) => {
    if (p.hidden) {
      hiddenIdx[i] = 1;
      anyHidden = true;
    }
  });
  const index = q.index;
  if (anyHidden) {
    for (let i = 0; i < index.length; i++) if (index[i] !== TRANSPARENT && hiddenIdx[index[i]]) index[i] = TRANSPARENT;
  }

  progress('cleanup', 0.3);
  despeckle(index, width, height, o.minArea * scale * scale);
  if (o.removeBackground) removeBackground(index, width, height);
  timings.cleanup = now() - t;

  return { width, height, scale, index, palette: q.palette, info, timings };
}

interface Shape {
  color: number;
  top: number;
  left: number;
  outer: Contour;
  holes: Contour[];
}

/** Trace a prepared image into SVG. */
export function trace(prep: Prepared, options: Partial<VectorizeOptions> = {}, progress: ProgressFn = noop): VectorizeResult {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, index, scale } = prep;
  const n = width * height;
  const t = now();
  const k = prep.palette.length;

  const counts = new Int32Array(k);
  for (let i = 0; i < n; i++) if (index[i] !== TRANSPARENT) counts[index[i]]++;
  const colors: number[] = [];
  for (let i = 0; i < k; i++) if (counts[i] > 0) colors.push(i);
  colors.sort((a, b) => counts[b] - counts[a] || a - b);

  // Tolerances are given in input pixels; the engine works in scaled pixels.
  const style = { smoothing: o.smoothing * scale, cornerThreshold: o.cornerThreshold };
  const simplify = o.simplify * scale;
  const mask = new Uint8Array(n);
  let paths = 0, points = 0;
  const layers: SvgLayer[] = [];

  const emit = (pb: PathBuilder, c: Contour): void => {
    const poly = polygonize(c.points, simplify);
    if (poly.count < 3) return;
    const written = appendContour(pb, c.points, poly, style);
    if (written > 0) {
      paths++;
      points += written;
    }
  };

  if (o.layering === 'cutout') {
    for (let r = 0; r < colors.length; r++) {
      progress('trace', 0.4 + (0.6 * r) / colors.length);
      const idx = colors[r];
      for (let i = 0; i < n; i++) mask[i] = index[i] === idx ? 1 : 0;
      const pb = new PathBuilder(o.precision, scale);
      for (const c of traceMask(mask, width, height)) emit(pb, c);
      layers.push({ color: hex(prep.palette[idx]), d: pb.toString() });
    }
  } else {
    // Stacked: every connected region is painted as its outer outline with the
    // holes filled, parents before the shapes they enclose, each shape dilated
    // by one pixel into the shapes painted after it. Holes that contain
    // transparent pixels are kept so transparency survives.
    progress('label', 0.35);
    const { labels } = labelComponents(index, width, height);
    const dil = dilationLists(index, labels, width, height, k);
    let hasTransparent = false;
    for (let i = 0; i < n && !hasTransparent; i++) hasTransparent = index[i] === TRANSPARENT;
    const maskLabels = hasTransparent ? new Int32Array(n) : null;
    const stack = new Int32Array(n);
    const stamp = hasTransparent ? new Int32Array(n) : null;
    let gen = 0;

    const holeHasTransparent = (c: Contour): boolean => {
      if (c.outside < 0) return false;
      gen++;
      let sp = 0;
      stack[sp++] = c.outside;
      stamp![c.outside] = gen;
      while (sp > 0) {
        const p = stack[--sp];
        if (index[p] === TRANSPARENT) return true;
        const x = p % width;
        const y = (p - x) / width;
        const nb = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
        for (const q of nb) {
          if (q >= 0 && mask[q] === 0 && stamp![q] !== gen) {
            stamp![q] = gen;
            stack[sp++] = q;
          }
        }
      }
      return false;
    };

    const shapes: Shape[] = [];
    for (let r = 0; r < colors.length; r++) {
      progress('trace', 0.4 + (0.5 * r) / colors.length);
      const idx = colors[r];
      for (let i = 0; i < n; i++) mask[i] = index[i] === idx ? 1 : 0;
      for (let i = dil.offsets[idx]; i < dil.offsets[idx + 1]; i++) mask[dil.pixels[i]] = 1;
      const contours = traceMask(mask, width, height);
      if (maskLabels) {
        labelMask(mask, width, height, maskLabels, stack);
        const byLabel = new Map<number, Shape>();
        for (const c of contours) {
          if (c.hole) continue;
          const s: Shape = { color: idx, top: c.points[1], left: c.points[0], outer: c, holes: [] };
          byLabel.set(maskLabels[c.inside], s);
          shapes.push(s);
        }
        for (const c of contours) {
          if (!c.hole || !holeHasTransparent(c)) continue;
          byLabel.get(maskLabels[c.inside])?.holes.push(c);
        }
      } else {
        for (const c of contours) {
          if (!c.hole) shapes.push({ color: idx, top: c.points[1], left: c.points[0], outer: c, holes: [] });
        }
      }
    }

    progress('assemble', 0.9);
    shapes.sort((a, b) => a.top - b.top || a.left - b.left);
    let pb: PathBuilder | null = null;
    let current = -1;
    for (const s of shapes) {
      if (s.color !== current) {
        if (pb) layers.push({ color: hex(prep.palette[current]), d: pb.toString() });
        pb = new PathBuilder(o.precision, scale);
        current = s.color;
      }
      emit(pb!, s.outer);
      for (const hole of s.holes) emit(pb!, hole);
    }
    if (pb) layers.push({ color: hex(prep.palette[current]), d: pb.toString() });
  }

  const outWidth = Math.round(width / scale), outHeight = Math.round(height / scale);
  const svg = buildSvg(outWidth, outHeight, layers, {
    strokeWidth: o.layering === 'cutout' ? o.strokeWidth : 0,
    precision: o.precision,
  });
  progress('done', 1);
  return {
    svg,
    width: outWidth,
    height: outHeight,
    scale,
    palette: prep.info,
    paths,
    points,
    timings: { ...prep.timings, trace: now() - t },
  };
}

/** One-shot convenience: {@link prepare} followed by {@link trace}. */
export function vectorize(image: RasterImage, options: Partial<VectorizeOptions> = {}, progress: ProgressFn = noop): VectorizeResult {
  return trace(prepare(image, options, progress), options, progress);
}

function hex(c: RGB): string {
  return toHex(c[0], c[1], c[2]);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
