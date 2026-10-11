/** Color helpers: hex parsing/formatting and sRGB <-> CIELAB conversion. */

export type RGB = [number, number, number];

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(r: number, g: number, b: number): string {
  const n = (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
  return '#' + n.toString(16).padStart(6, '0');
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Rec. 709 luma of an sRGB color, 0-255. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// sRGB byte -> linear light lookup table.
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** Writes L*, a*, b* of an sRGB color into `out` at offset `o`. */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const R = LINEAR[r], G = LINEAR[g], B = LINEAR[b];
  // D65 reference white, normalised so that Xn = Yn = Zn = 1.
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

function gamma(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp255(v * 255);
}

export function labToRgb(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const fx3 = fx * fx * fx, fz3 = fz * fz * fz;
  const xr = fx3 > EPS ? fx3 : (116 * fx - 16) / KAPPA;
  const yr = L > KAPPA * EPS ? fy * fy * fy : L / KAPPA;
  const zr = fz3 > EPS ? fz3 : (116 * fz - 16) / KAPPA;
  const X = xr * 0.95047, Y = yr, Z = zr * 1.08883;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [gamma(R), gamma(G), gamma(B)];
}
