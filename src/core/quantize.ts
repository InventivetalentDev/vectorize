import { luminance, parseHex, rgbToLab, type RGB } from './color';
import type { ColorMode, RasterImage } from './types';

/** Index value used for transparent / unassigned pixels. */
export const TRANSPARENT = 255;
/** Hard cap on palette size (index 255 is reserved). */
export const MAX_COLORS = 128;

export interface QuantizeOptions {
  mode: ColorMode;
  colors: number;
  palette: string[];
  threshold: number;
  /** Seed for the deterministic PRNG used by k-means. */
  seed?: number;
}

export interface Quantized {
  /** Palette colors as [r, g, b]. */
  palette: RGB[];
  /** Palette index per pixel, or TRANSPARENT. */
  index: Uint8Array;
  /** Pixel count per palette entry. */
  counts: Int32Array;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reduces the opaque pixels of `img` to a small palette.
 * `opaque[i]` must be 1 for pixels that take part, 0 for transparent ones.
 */
export function quantize(img: RasterImage, opaque: Uint8Array, opts: QuantizeOptions): Quantized {
  const n = img.width * img.height;
  const data = img.data;
  const index = new Uint8Array(n).fill(TRANSPARENT);

  if (opts.mode === 'bw') {
    const palette: RGB[] = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    const counts = new Int32Array(2);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (!opaque[i]) continue;
      const idx = luminance(data[p], data[p + 1], data[p + 2]) < opts.threshold ? 0 : 1;
      index[i] = idx;
      counts[idx]++;
    }
    return { palette, index, counts };
  }

  const gray = opts.mode === 'grayscale';
  let centroids: Float32Array;
  let k: number;
  let fixedPalette: RGB[] | null = null;

  if (opts.mode === 'palette') {
    const rgbs = opts.palette.map(parseHex).filter((c): c is RGB => c !== null).slice(0, MAX_COLORS);
    if (rgbs.length === 0) rgbs.push([0, 0, 0], [255, 255, 255]);
    fixedPalette = rgbs;
    k = rgbs.length;
    centroids = new Float32Array(k * 3);
    for (let i = 0; i < k; i++) rgbToLab(rgbs[i][0], rgbs[i][1], rgbs[i][2], centroids, i * 3);
  } else {
    const want = Math.max(1, Math.min(MAX_COLORS, Math.round(opts.colors)));
    const samples = collectSamples(img, opaque, gray, 65536, opts.seed ?? 1);
    const km = kmeans(samples.lab, samples.count, want, opts.seed ?? 1);
    centroids = km.centroids;
    k = km.k;
  }

  const assign = assignPixels(img, opaque, gray, centroids, k, index);
  let counts = assign.counts;
  let sums = assign.sums;

  if (fixedPalette) return { palette: fixedPalette, index, counts };

  // Anti-aliasing produces thin slivers of intermediate colors along every
  // edge; k-means happily spends clusters on them. Dissolve such clusters.
  for (let round = 0; round < 3; round++) {
    const dissolved = findFringeClusters(index, img.width, img.height, centroids, k, counts);
    if (dissolved.length === 0) break;
    const keepMask = new Uint8Array(k).fill(1);
    for (const c of dissolved) keepMask[c] = 0;
    // Compact the surviving centroids and remap indices.
    const remap = new Uint8Array(k).fill(TRANSPARENT);
    const next = new Float32Array(k * 3);
    let kk = 0;
    for (let j = 0; j < k; j++) {
      if (!keepMask[j]) continue;
      remap[j] = kk;
      next[kk * 3] = centroids[j * 3];
      next[kk * 3 + 1] = centroids[j * 3 + 1];
      next[kk * 3 + 2] = centroids[j * 3 + 2];
      kk++;
    }
    for (let i = 0; i < n; i++) {
      const v = index[i];
      if (v === TRANSPARENT) continue;
      index[i] = keepMask[v] ? remap[v] : TRANSPARENT;
    }
    const was = opaque;
    // Only the pixels of dissolved clusters need re-assigning; mark them.
    const todo = new Uint8Array(n);
    for (let i = 0; i < n; i++) todo[i] = was[i] && index[i] === TRANSPARENT ? 1 : 0;
    centroids = next.subarray(0, kk * 3);
    k = kk;
    assignPixels(img, todo, gray, centroids, k, index);
    const again = tally(img, opaque, gray, index, k);
    counts = again.counts;
    sums = again.sums;
  }

  // Palette = mean sRGB of each cluster's members; drop clusters that ended up empty.
  const remap = new Uint8Array(k).fill(TRANSPARENT);
  const palette: RGB[] = [];
  const outCounts: number[] = [];
  for (let j = 0; j < k; j++) {
    if (counts[j] === 0) continue;
    remap[j] = palette.length;
    palette.push([
      Math.round(sums[j * 3] / counts[j]),
      Math.round(sums[j * 3 + 1] / counts[j]),
      Math.round(sums[j * 3 + 2] / counts[j]),
    ]);
    outCounts.push(counts[j]);
  }
  if (palette.length !== k) {
    for (let i = 0; i < n; i++) if (index[i] !== TRANSPARENT) index[i] = remap[index[i]];
  }
  return { palette, index, counts: Int32Array.from(outCounts) };
}

/**
 * Assigns every pixel with `which[i] = 1` to its nearest centroid (in Lab),
 * memoised per exact RGB value. Returns per-cluster counts and sRGB sums for
 * the pixels it assigned.
 */
function assignPixels(
  img: RasterImage,
  which: Uint8Array,
  gray: boolean,
  centroids: Float32Array,
  k: number,
  index: Uint8Array,
): { counts: Int32Array; sums: Float64Array } {
  const n = img.width * img.height;
  const data = img.data;
  const CACHE_BITS = 16;
  const cacheKey = new Int32Array(1 << CACHE_BITS).fill(-1);
  const cacheVal = new Uint8Array(1 << CACHE_BITS);
  const lab = new Float32Array(3);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!which[i]) continue;
    let r = data[p], g = data[p + 1], b = data[p + 2];
    if (gray) r = g = b = Math.round(luminance(r, g, b));
    const key = (r << 16) | (g << 8) | b;
    const slot = (Math.imul(key, 0x9e3779b1) >>> (32 - CACHE_BITS)) & ((1 << CACHE_BITS) - 1);
    let idx: number;
    if (cacheKey[slot] === key) {
      idx = cacheVal[slot];
    } else {
      rgbToLab(r, g, b, lab, 0);
      idx = nearest(centroids, k, lab[0], lab[1], lab[2]);
      cacheKey[slot] = key;
      cacheVal[slot] = idx;
    }
    index[i] = idx;
    counts[idx]++;
    sums[idx * 3] += r;
    sums[idx * 3 + 1] += g;
    sums[idx * 3 + 2] += b;
  }
  return { counts, sums };
}

function tally(img: RasterImage, opaque: Uint8Array, gray: boolean, index: Uint8Array, k: number): { counts: Int32Array; sums: Float64Array } {
  const n = img.width * img.height;
  const data = img.data;
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!opaque[i]) continue;
    const idx = index[i];
    let r = data[p], g = data[p + 1], b = data[p + 2];
    if (gray) r = g = b = Math.round(luminance(r, g, b));
    counts[idx]++;
    sums[idx * 3] += r;
    sums[idx * 3 + 1] += g;
    sums[idx * 3 + 2] += b;
  }
  return { counts, sums };
}

/**
 * Finds clusters that are anti-aliasing artifacts: their color lies on the
 * line between two other clusters A and B, and most of their pixels sit
 * spatially between an A-ish and a B-ish neighbour. Returns their indices.
 */
function findFringeClusters(
  index: Uint8Array,
  w: number,
  h: number,
  centroids: Float32Array,
  k: number,
  counts: Int32Array,
): number[] {
  if (k < 3) return [];
  const n = w * h;
  // For every cluster, the pair (A, B) it most plausibly is a mix of.
  const pairA = new Int32Array(k).fill(-1);
  const pairB = new Int32Array(k).fill(-1);
  const tOf = new Float32Array(k * k); // tOf[c * k + x]: position of cluster x along c's A-B axis
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) continue;
    const cl = centroids[c * 3], ca = centroids[c * 3 + 1], cb = centroids[c * 3 + 2];
    let best = Infinity;
    for (let a = 0; a < k; a++) {
      if (a === c || counts[a] === 0) continue;
      for (let b = a + 1; b < k; b++) {
        if (b === c || counts[b] === 0) continue;
        const dx = centroids[b * 3] - centroids[a * 3];
        const dy = centroids[b * 3 + 1] - centroids[a * 3 + 1];
        const dz = centroids[b * 3 + 2] - centroids[a * 3 + 2];
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 === 0) continue;
        let t = ((cl - centroids[a * 3]) * dx + (ca - centroids[a * 3 + 1]) * dy + (cb - centroids[a * 3 + 2]) * dz) / len2;
        if (t < 0.05 || t > 0.95) continue;
        const ex = cl - (centroids[a * 3] + t * dx);
        const ey = ca - (centroids[a * 3 + 1] + t * dy);
        const ez = cb - (centroids[a * 3 + 2] + t * dz);
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const limit = Math.max(2.5, 0.12 * Math.sqrt(len2));
        // Prefer the pair whose axis it fits best, relative to the allowed slack.
        const score = d / limit;
        if (score < 1 && score < best) {
          best = score;
          pairA[c] = a;
          pairB[c] = b;
        }
      }
    }
    if (pairA[c] < 0) continue;
    const a = pairA[c], b = pairB[c];
    const dx = centroids[b * 3] - centroids[a * 3];
    const dy = centroids[b * 3 + 1] - centroids[a * 3 + 1];
    const dz = centroids[b * 3 + 2] - centroids[a * 3 + 2];
    const len2 = dx * dx + dy * dy + dz * dz;
    for (let x = 0; x < k; x++) {
      tOf[c * k + x] =
        ((centroids[x * 3] - centroids[a * 3]) * dx +
          (centroids[x * 3 + 1] - centroids[a * 3 + 1]) * dy +
          (centroids[x * 3 + 2] - centroids[a * 3 + 2]) * dz) /
        len2;
    }
  }

  const fringe = new Int32Array(k);
  for (let p = 0; p < n; p++) {
    const c = index[p];
    if (c === TRANSPARENT || pairA[c] < 0) continue;
    const tc = tOf[c * k + c];
    const x = p % w;
    const y = (p - x) / w;
    const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
    const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
    let lo = false, hi = false;
    for (let yy = y0; yy <= y1 && !(lo && hi); yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const q = index[yy * w + xx];
        if (q === TRANSPARENT || q === c) continue;
        const t = tOf[c * k + q];
        if (t < tc - 0.2) lo = true;
        else if (t > tc + 0.2) hi = true;
      }
    }
    if (lo && hi) fringe[c]++;
  }

  const out: number[] = [];
  for (let c = 0; c < k; c++) if (pairA[c] >= 0 && fringe[c] >= 0.5 * counts[c]) out.push(c);
  return out;
}

function nearest(centroids: Float32Array, k: number, L: number, a: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let j = 0, o = 0; j < k; j++, o += 3) {
    const dl = centroids[o] - L, da = centroids[o + 1] - a, db = centroids[o + 2] - b;
    const d = dl * dl + da * da + db * db;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

function collectSamples(
  img: RasterImage,
  opaque: Uint8Array,
  gray: boolean,
  limit: number,
  seed: number,
): { lab: Float32Array; count: number } {
  const n = img.width * img.height;
  const data = img.data;
  let opaqueCount = 0;
  for (let i = 0; i < n; i++) opaqueCount += opaque[i];
  const take = Math.min(limit, opaqueCount);
  const lab = new Float32Array(take * 3);
  let count = 0;
  if (take === opaqueCount) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (!opaque[i]) continue;
      pushSample(data, p, gray, lab, count++);
    }
  } else {
    // Random sample of the opaque pixels (without replacement via rejection).
    const rand = mulberry32(seed);
    const seen = new Uint8Array(n);
    let guard = 0;
    while (count < take && guard < take * 20) {
      guard++;
      const i = Math.floor(rand() * n);
      if (!opaque[i] || seen[i]) continue;
      seen[i] = 1;
      pushSample(data, i * 4, gray, lab, count++);
    }
  }
  return { lab, count };
}

function pushSample(data: Uint8ClampedArray, p: number, gray: boolean, lab: Float32Array, i: number): void {
  let r = data[p], g = data[p + 1], b = data[p + 2];
  if (gray) r = g = b = Math.round(luminance(r, g, b));
  rgbToLab(r, g, b, lab, i * 3);
}

/**
 * Lloyd's k-means with k-means++ seeding on `n` Lab samples.
 * May return fewer than `k` centroids when the input has fewer distinct colors.
 */
export function kmeans(samples: Float32Array, n: number, k: number, seed: number): { centroids: Float32Array; k: number } {
  if (n === 0) return { centroids: new Float32Array([50, 0, 0]), k: 1 };
  const rand = mulberry32(seed);
  const cent = new Float32Array(k * 3);
  const d2 = new Float32Array(n).fill(Infinity);
  let kk = 0;

  // k-means++ seeding
  {
    const first = Math.floor(rand() * n) * 3;
    cent[0] = samples[first];
    cent[1] = samples[first + 1];
    cent[2] = samples[first + 2];
    kk = 1;
    while (kk < k) {
      const co = (kk - 1) * 3;
      let total = 0;
      for (let i = 0, o = 0; i < n; i++, o += 3) {
        const dl = samples[o] - cent[co], da = samples[o + 1] - cent[co + 1], db = samples[o + 2] - cent[co + 2];
        const d = dl * dl + da * da + db * db;
        if (d < d2[i]) d2[i] = d;
        total += d2[i];
      }
      if (total <= 1e-6) break; // no more distinct colors
      let r = rand() * total;
      let pick = n - 1;
      for (let i = 0; i < n; i++) {
        r -= d2[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
      const po = pick * 3, no = kk * 3;
      cent[no] = samples[po];
      cent[no + 1] = samples[po + 1];
      cent[no + 2] = samples[po + 2];
      kk++;
    }
  }

  // Lloyd iterations
  const sums = new Float64Array(kk * 3);
  const counts = new Int32Array(kk);
  for (let iter = 0; iter < 40; iter++) {
    sums.fill(0);
    counts.fill(0);
    let farI = 0, farD = -1;
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const L = samples[o], a = samples[o + 1], b = samples[o + 2];
      let best = 0, bestD = Infinity;
      for (let j = 0, c = 0; j < kk; j++, c += 3) {
        const dl = cent[c] - L, da = cent[c + 1] - a, db = cent[c + 2] - b;
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (bestD > farD) {
        farD = bestD;
        farI = i;
      }
      counts[best]++;
      sums[best * 3] += L;
      sums[best * 3 + 1] += a;
      sums[best * 3 + 2] += b;
    }
    let maxShift = 0;
    for (let j = 0, c = 0; j < kk; j++, c += 3) {
      let nl: number, na: number, nb: number;
      if (counts[j] === 0) {
        // Re-seed an empty cluster at the sample farthest from its centroid.
        nl = samples[farI * 3];
        na = samples[farI * 3 + 1];
        nb = samples[farI * 3 + 2];
      } else {
        nl = sums[c] / counts[j];
        na = sums[c + 1] / counts[j];
        nb = sums[c + 2] / counts[j];
      }
      const dl = nl - cent[c], da = na - cent[c + 1], db = nb - cent[c + 2];
      maxShift = Math.max(maxShift, dl * dl + da * da + db * db);
      cent[c] = nl;
      cent[c + 1] = na;
      cent[c + 2] = nb;
    }
    if (maxShift < 0.01) break;
  }
  return { centroids: cent.subarray(0, kk * 3), k: kk };
}
