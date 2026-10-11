export interface SvgLayer {
  color: string;
  d: string;
}

export interface SvgOptions {
  /** Stroke width in the fill color, used to hide seams between shapes. */
  strokeWidth?: number;
  precision?: number;
}

export function buildSvg(width: number, height: number, layers: SvgLayer[], opts: SvgOptions = {}): string {
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  const stroke = opts.strokeWidth && opts.strokeWidth > 0 ? opts.strokeWidth : 0;
  // The seam stroke keeps its width on screen at any zoom, so it hides
  // anti-aliasing gaps even when the SVG is rendered much smaller.
  const strokeAttrs = stroke
    ? ` stroke-width="${formatNumber(stroke, opts.precision ?? 2)}" stroke-linejoin="round" vector-effect="non-scaling-stroke"`
    : '';
  out.push(`<g fill-rule="evenodd"${strokeAttrs}>`);
  for (const layer of layers) {
    if (!layer.d) continue;
    const strokeAttr = stroke ? ` stroke="${layer.color}"` : '';
    out.push(`<path fill="${layer.color}"${strokeAttr} d="${layer.d}"/>`);
  }
  out.push('</g>', '</svg>');
  return out.join('\n');
}

export function formatNumber(v: number, precision: number): string {
  let s = v.toFixed(precision);
  if (precision > 0) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}
