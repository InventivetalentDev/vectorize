import type { RasterImage } from './types';

/**
 * Area-averaging downscale so that the longest side is at most `maxSize`.
 * Colors are alpha-weighted so transparent pixels don't bleed dark fringes.
 */
export function downscale(img: RasterImage, maxSize: number): RasterImage {
  const { width: w, height: h, data } = img;
  if (maxSize <= 0 || Math.max(w, h) <= maxSize) return img;
  const scale = maxSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);

  const xs = new Int32Array(nw + 1);
  for (let i = 0; i <= nw; i++) xs[i] = Math.floor((i * w) / nw);
  xs[nw] = w;
  const ys = new Int32Array(nh + 1);
  for (let i = 0; i <= nh; i++) ys[i] = Math.floor((i * h) / nh);
  ys[nh] = h;

  for (let y = 0; y < nh; y++) {
    const y0 = ys[y], y1 = ys[y + 1];
    for (let x = 0; x < nw; x++) {
      const x0 = xs[x], x1 = xs[x + 1];
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          const a = data[p + 3];
          sr += data[p] * a;
          sg += data[p + 1] * a;
          sb += data[p + 2] * a;
          sa += a;
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      if (sa > 0) {
        out[o] = sr / sa;
        out[o + 1] = sg / sa;
        out[o + 2] = sb / sa;
      }
      out[o + 3] = n > 0 ? sa / n : 0;
    }
  }
  return { data: out, width: nw, height: nh };
}

/**
 * Separable box blur (applied twice, i.e. a triangle kernel) on premultiplied
 * color so that transparent areas don't darken edges.
 */
export function blur(img: RasterImage, radius: number): RasterImage {
  const r = Math.round(radius);
  if (r <= 0) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const premul = new Float32Array(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3] / 255;
    premul[p] = data[p] * a;
    premul[p + 1] = data[p + 1] * a;
    premul[p + 2] = data[p + 2] * a;
    premul[p + 3] = data[p + 3];
  }
  const chan = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < n; i++) chan[i] = premul[i * 4 + c];
    for (let pass = 0; pass < 2; pass++) {
      boxBlurH(chan, tmp, w, h, r);
      boxBlurV(tmp, chan, w, h, r);
    }
    for (let i = 0; i < n; i++) premul[i * 4 + c] = chan[i];
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = premul[p + 3];
    if (a > 0) {
      const inv = 255 / a;
      out[p] = premul[p] * inv;
      out[p + 1] = premul[p + 1] * inv;
      out[p + 2] = premul[p + 2] * inv;
    }
    out[p + 3] = a;
  }
  return { data: out, width: w, height: h };
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let hi = Math.min(r, w - 1);
    for (let x = 0; x <= hi; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r;
      hi = x + r;
      const count = Math.min(hi, w - 1) - Math.max(lo, 0) + 1;
      dst[row + x] = sum / count;
      if (lo >= 0) sum -= src[row + lo];
      if (hi + 1 < w) sum += src[row + hi + 1];
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let hi = Math.min(r, h - 1);
    for (let y = 0; y <= hi; y++) sum += src[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r;
      hi = y + r;
      const count = Math.min(hi, h - 1) - Math.max(lo, 0) + 1;
      dst[y * w + x] = sum / count;
      if (lo >= 0) sum -= src[lo * w + x];
      if (hi + 1 < h) sum += src[(hi + 1) * w + x];
    }
  }
}

/** 1 for every pixel whose alpha is at least `alphaThreshold`, else 0. */
export function opaqueMask(img: RasterImage, alphaThreshold: number): Uint8Array {
  const n = img.width * img.height;
  const mask = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, p = 3; i < n; i++, p += 4) mask[i] = d[p] >= alphaThreshold ? 1 : 0;
  return mask;
}
