# Vectorize

Convert raster images (PNG, JPG, WebP, GIF, BMP…) into clean, compact SVG, entirely in your browser. Nothing is uploaded anywhere.

Drop an image, tune the palette and the shape controls, watch the result update live, then download or copy the SVG.

## Features

- **Palette control**: automatic color detection (k-means in CIELAB), a custom palette you edit swatch by swatch, grayscale levels, or black & white with a threshold. Click any detected color to leave it out of the output; one checkbox removes a border-connected background.
- **Clean shapes**: anti-aliasing fringes are detected and removed instead of becoming halos; specks below a chosen size are merged away; straight edges stay straight and true corners are reconstructed exactly rather than snapped to pixels; curves are least-squares fitted cubic Béziers that join smoothly.
- **Two layering modes**: *stacked* paints every region as its filled outline, enclosing shapes first and overlapping by a pixel, so there are never hairline seams and shared edges are traced only once (smaller files). *Cutout* gives every color exactly its own region, for cutting plotters and laser work, with an optional seam stroke.
- **Presets** for logos/flat art, photos, grayscale sketches, line art and pixel-exact tracing, plus full manual control: color count, despeckle size, simplification, smoothing, corner angle, pre-blur, output size and precision.
- **Workflow niceties**: drag & drop, paste from the clipboard, split view against the original, zoom and pan, live size/point statistics, settings remembered between visits.
- Processing runs in a Web Worker, so the UI stays responsive while sliders are dragged.

## Using it

```sh
npm install
npm run dev        # http://localhost:5173
```

or build the static site with `npm run build` and serve `dist/` from anywhere (the build uses relative paths, so it works in a sub-folder).

### Deploying to Cloudflare Workers

The app ships as an assets-only Worker (`wrangler.jsonc` points at `dist/`). Either:

- run `npm run deploy` locally after a one-time `npx wrangler login`, or
- connect the repository to **Workers Builds** in the Cloudflare dashboard (build command `npm run build`, deploy command `npx wrangler deploy`) so every push to `main` deploys, or
- add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the included GitHub Actions workflow then deploys on every push to `main`.

Keyboard: `O` opens a file, `+`/`-` zoom, `0` fits to window, `1` is 1:1, `Ctrl`/`Cmd`+wheel zooms around the cursor, dragging pans.

## How it works

The engine lives in `src/core/` and has no DOM dependencies, so it can also be used from Node or another UI:

```ts
import { vectorize } from './src/core';
const { svg, palette, paths, points } = vectorize({ data, width, height }, { colors: 8 });
```

Pipeline, in order:

1. **Preprocess** (`image.ts`): optional area-averaging downscale, a bilinear 2× (or 3×) upscale that turns anti-aliasing into sub-pixel edge positions (automatic for images up to 1 megapixel; this is what keeps text and thin strokes faithful), and a premultiplied box blur.
2. **Quantize** (`quantize.ts`): k-means++ in CIELAB on a pixel sample, then a memoised nearest-color assignment. Clusters whose color lies between two others *and* whose pixels sit spatially between those colors are anti-aliasing fringes; they are dissolved and their pixels re-assigned.
3. **Clean up** (`despeckle.ts`): regions smaller than the despeckle size are merged into the color that surrounds them most; optionally the border-connected background is made transparent.
4. **Layer** (`layers.ts`): for stacked output, connected regions are labelled, each one is dilated by the overlap distance into the regions painted after it (without ever merging two regions of the same color), and painting order is the scan order of each region's top-left pixel, which guarantees that enclosing shapes come first.
5. **Trace** (`trace.ts`): every color mask is turned into closed contours along pixel edges (8-connected regions, holes counter-clockwise), with collinear vertices dropped.
6. **Polygonize** (`simplify.ts`): contours are split at their four extreme points and recursively at the vertex farthest from the least-squares line of each arc until all pixels sit within the simplification tolerance (on top of the inherent ±0.5 px staircase noise); vertices are placed at the intersections of consecutive fitted lines. Each segment is classified as straight or curved and each vertex as corner or rounded from the pixels themselves.
7. **Fit** (`fit.ts`, `path.ts`): between corners, cubic Béziers are least-squares fitted (Schneider's algorithm) to the midpoints of the contour's pixel edges, which sit on the true outline far more precisely than the pixel corners; tangents come from the polygon, pieces are split where the error exceeds the smoothing tolerance, and straight edges are emitted as lines.
8. **Write** (`svg.ts`): one `<path>` per color (per run of shapes in stacked mode), compact path data with implicit command repetition.

## Options

| Option | Meaning |
| --- | --- |
| `colors` | Number of colors for automatic / grayscale palettes (2–64). |
| `mode` | `auto`, `palette` (uses `palette: string[]` hex colors), `grayscale` or `bw` (uses `threshold`). |
| `hidden` | Hex colors of the detected palette to leave out. |
| `removeBackground` | Make the border-connected region of the dominant edge color transparent. |
| `alphaThreshold` | Pixels more transparent than this (0–255) are ignored. |
| `minArea` | Regions smaller than this many pixels are merged away. |
| `simplify` | Polygon tolerance in pixels on top of pixel noise; 0 keeps every pixel corner. |
| `smoothing` | Curve-fit tolerance in pixels; 0 outputs straight polygons. |
| `cornerThreshold` | Turns sharper than this (degrees) are corners, unless the pixels show a rounded shape. |
| `blur` | Pre-blur radius in pixels. |
| `layering` | `stacked` or `cutout`; `strokeWidth` adds a seam-hiding, non-scaling stroke in cutout mode. |
| `overlap` | Stacked mode: how far (input px, default 3) each shape extends under the shapes painted after it. Invisible at 1:1; set it to roughly the downscale factor when the SVG will be rendered much smaller, where renderers otherwise show hairline seams between anti-aliased neighbours. |
| `maxSize` | Downscale so the longest side is at most this (0 = original). |
| `upscale` | Trace at this resolution multiple: 1, 2 or 3; 0 = automatic (2× up to 1 MP). |
| `precision` | Decimal places in the SVG. |

## Development

```sh
npm test            # vitest unit tests (tracer area conservation, geometry accuracy, quantization, …)
npm run typecheck   # tsc
npm run build       # production build into dist/
```
