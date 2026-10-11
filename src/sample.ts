/** Draws a demo image with flat shapes, text, thin lines, a gradient and some noise. */
export function drawSample(): HTMLCanvasElement {
  const w = 720, h = 480;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // blue rounded card
  ctx.fillStyle = '#3b6cf0';
  roundRect(ctx, 48, 56, 300, 220, 36);
  ctx.fill();

  // orange circle overlapping it
  ctx.fillStyle = '#ff8a3d';
  ctx.beginPath();
  ctx.arc(330, 200, 110, 0, Math.PI * 2);
  ctx.fill();

  // green star
  ctx.fillStyle = '#2fb871';
  star(ctx, 560, 150, 5, 90, 40);
  ctx.fill();

  // yellow triangle
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(470, 420);
  ctx.lineTo(680, 420);
  ctx.lineTo(575, 270);
  ctx.closePath();
  ctx.fill();

  // text
  ctx.fillStyle = '#1e2330';
  ctx.font = 'bold 72px system-ui, Helvetica, Arial, sans-serif';
  ctx.fillText('Vectorize', 48, 380);
  ctx.fillStyle = '#6b7280';
  ctx.font = '26px system-ui, Helvetica, Arial, sans-serif';
  ctx.fillText('png → svg', 52, 420);

  // thin strokes
  ctx.strokeStyle = '#1e2330';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(400, 40);
  ctx.lineTo(700, 110);
  ctx.stroke();
  ctx.strokeStyle = '#d9306b';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(120, 160, 50, 0, Math.PI * 2);
  ctx.stroke();

  // gradient bar
  const grad = ctx.createLinearGradient(400, 0, 700, 0);
  grad.addColorStop(0, '#d9306b');
  grad.addColorStop(1, '#3b6cf0');
  ctx.fillStyle = grad;
  roundRect(ctx, 400, 440, 300, 24, 12);
  ctx.fill();

  // a little noise so despeckle has something to do
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.fillStyle = 'rgba(30,35,48,0.6)';
  for (let i = 0; i < 60; i++) ctx.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), 1, 1);

  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, n: number, outer: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI) / n - Math.PI / 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
