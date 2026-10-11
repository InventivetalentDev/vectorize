/** How the output palette is chosen. */
export type ColorMode = 'auto' | 'palette' | 'grayscale' | 'bw';

/**
 * How color regions are turned into shapes.
 * - `stacked`: every region is painted as its outline with holes filled,
 *   enclosing shapes first, with a 1px overlap into later shapes, so no seams
 *   can appear between neighbouring colors. Fewer path points overall.
 * - `cutout`: every color is traced as exactly its own pixels, so shapes never
 *   overlap. Useful for cutting/plotting; may show hairline seams.
 */
export type Layering = 'stacked' | 'cutout';

export interface VectorizeOptions {
  /** Downscale so that the longest side is at most this many pixels (0 = never). */
  maxSize: number;
  /** Pre-blur radius in pixels (0 = off). Helps with JPEG noise and dithering. */
  blur: number;
  /**
   * Trace at this multiple of the image resolution (bilinear interpolation
   * turns anti-aliasing into sub-pixel edge positions, which matters most for
   * text and thin strokes). 0 = automatic: 2x for images up to 1 megapixel.
   */
  upscale: number;

  mode: ColorMode;
  /** Number of colors for `auto` / `grayscale`. */
  colors: number;
  /** Hex colors used in `palette` mode. */
  palette: string[];
  /** Luminance threshold (0-255) for `bw` mode. */
  threshold: number;
  /** Pixels with alpha below this (0-255) are treated as transparent. */
  alphaThreshold: number;
  /** Make the border-connected region of the dominant border color transparent. */
  removeBackground: boolean;
  /** Hex colors of the detected palette that should be dropped from the output. */
  hidden: string[];

  /** Regions smaller than this many pixels are merged into their surroundings. */
  minArea: number;

  layering: Layering;
  /**
   * In `stacked` mode, how far (input pixels) each shape extends under the
   * shapes painted after it. Invisible at 1:1; raise it when the SVG will be
   * rendered much smaller, where anti-aliasing would otherwise open seams.
   */
  overlap: number;
  /** Path simplification tolerance in pixels (0 = keep every pixel corner). */
  simplify: number;
  /** Curve-fit tolerance in pixels (0 = straight polygons, no curves). */
  smoothing: number;
  /** Corners sharper than this angle (degrees) are kept sharp when smoothing. */
  cornerThreshold: number;

  /** Decimal places for coordinates in the SVG. */
  precision: number;
  /** Stroke width (same color as the fill) added in `cutout` mode to hide seams. 0 = none. */
  strokeWidth: number;
}

export const DEFAULT_OPTIONS: VectorizeOptions = {
  maxSize: 2048,
  blur: 0,
  upscale: 0,
  mode: 'auto',
  colors: 8,
  palette: ['#000000', '#ffffff'],
  threshold: 128,
  alphaThreshold: 128,
  removeBackground: false,
  hidden: [],
  minArea: 8,
  layering: 'stacked',
  overlap: 3,
  simplify: 0.5,
  smoothing: 0.5,
  cornerThreshold: 45,
  precision: 1,
  strokeWidth: 0,
};

/** A raster image in RGBA byte order, like `ImageData`. */
export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PaletteInfo {
  color: string;
  /** Number of pixels mapped to this color (before hiding/background removal). */
  count: number;
  hidden: boolean;
}

export interface VectorizeResult {
  svg: string;
  width: number;
  height: number;
  /** Resolution multiple the image was traced at. */
  scale: number;
  palette: PaletteInfo[];
  /** Number of closed sub-paths in the output. */
  paths: number;
  /** Total number of vertices (anchor points) in the output. */
  points: number;
  timings: Record<string, number>;
}

export type ProgressFn = (stage: string, fraction: number) => void;
