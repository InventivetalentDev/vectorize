import { DEFAULT_OPTIONS, type VectorizeOptions, type VectorizeResult } from './core';
import { Engine } from './engine';
import { drawSample } from './sample';

const STORAGE_KEY = 'vectorize.options.v1';
const STAGE_MARGIN = 24;
/** Inputs larger than this are downscaled on load (before any option applies). */
const HARD_MAX_INPUT = 4096;

const PRESETS: Record<string, Partial<VectorizeOptions>> = {
  logo: { mode: 'auto', colors: 8, blur: 0, minArea: 8, simplify: 0.5, smoothing: 0.5, cornerThreshold: 45, upscale: 0, layering: 'stacked' },
  photo: { mode: 'auto', colors: 24, blur: 1, minArea: 24, simplify: 1, smoothing: 1, cornerThreshold: 80, upscale: 1, layering: 'stacked' },
  sketch: { mode: 'grayscale', colors: 6, blur: 1, minArea: 12, simplify: 0.8, smoothing: 0.8, cornerThreshold: 60, upscale: 0, layering: 'stacked' },
  lineart: { mode: 'bw', threshold: 128, blur: 0, minArea: 4, simplify: 0.5, smoothing: 0.5, cornerThreshold: 50, upscale: 0, layering: 'stacked' },
  pixel: { mode: 'auto', colors: 32, blur: 0, minArea: 0, simplify: 0, smoothing: 0, maxSize: 0, precision: 0, upscale: 1, layering: 'stacked' },
};

type View = 'vector' | 'split' | 'original';

// ---------- state ----------
let options: VectorizeOptions = loadOptions();
let result: VectorizeResult | null = null;
let hasImage = false;
let imageName = 'image';
let imageSize = { w: 0, h: 0 };
let originalUrl: string | null = null;
let vectorUrl: string | null = null;
let zoom = 1;
let view: View = 'vector';
let split = 0.5;
let runTimer = 0;
let detectForPalette = false;

// ---------- elements ----------
const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};
const viewport = $('#viewport');
const stage = $('#stage');
const imgOriginal = $<HTMLImageElement>('#img-original');
const imgVector = $<HTMLImageElement>('#img-vector');
const divider = $('#divider');
const emptyState = $('#empty');
const statusEl = $('#status');
const statsEl = $('#stats');
const zoomLevel = $('#zoom-level');
const paletteEl = $('#palette');
const fileInput = $<HTMLInputElement>('#file');
const dropOverlay = $('#drop-overlay');
const presetSelect = $<HTMLSelectElement>('#preset');
const btnDownload = $<HTMLButtonElement>('#btn-download');
const btnCopy = $<HTMLButtonElement>('#btn-copy');
const btnShowAll = $<HTMLButtonElement>('#btn-palette-showall');

const engine = new Engine({
  onProgress: (stage) => setStatus(`Processing… ${stage}`, 'busy'),
  onResult: (res) => onResult(res),
  onError: (message) => setStatus(`Error: ${message}`, 'error'),
});

// ---------- options <-> controls ----------
function loadOptions(): VectorizeOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<VectorizeOptions>;
      const merged = { ...DEFAULT_OPTIONS, ...saved, hidden: [] };
      // Only keep saved values of the expected type; anything else falls back.
      for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof VectorizeOptions)[]) {
        const def = DEFAULT_OPTIONS[key];
        const val = merged[key];
        const ok = Array.isArray(def) ? Array.isArray(val) : typeof val === typeof def && (typeof val !== 'number' || Number.isFinite(val));
        if (!ok) (merged as unknown as Record<string, unknown>)[key] = def;
      }
      return merged;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { ...DEFAULT_OPTIONS };
}

function saveOptions(): void {
  try {
    const { hidden: _hidden, ...rest } = options;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    /* storage may be unavailable */
  }
}

type OptEl = HTMLInputElement | HTMLSelectElement;
const optEls = Array.from(document.querySelectorAll<OptEl>('[data-opt]'));

function readControl(el: OptEl): void {
  const key = el.dataset.opt as keyof VectorizeOptions;
  const o = options as unknown as Record<string, unknown>;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') o[key] = el.checked;
  else if (el instanceof HTMLInputElement && el.type === 'radio') {
    if (el.checked) o[key] = el.value;
  } else if ((el instanceof HTMLInputElement && el.type === 'range') || el.dataset.type === 'number') o[key] = Number(el.value);
  else o[key] = el.value;
}

function writeControls(): void {
  const o = options as unknown as Record<string, unknown>;
  for (const el of optEls) {
    const key = el.dataset.opt as keyof VectorizeOptions;
    const v = o[key];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else if (el instanceof HTMLInputElement && el.type === 'radio') el.checked = el.value === String(v);
    else el.value = String(v);
  }
  for (const out of document.querySelectorAll<HTMLOutputElement>('[data-out]')) {
    const key = out.dataset.out as keyof VectorizeOptions;
    const v = o[key];
    out.textContent = key === 'maxSize' && v === 0 ? 'original' : key === 'upscale' ? (v === 0 ? 'auto' : `${v}×`) : String(v);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-show-mode]')) {
    el.hidden = !el.dataset.showMode!.split(' ').includes(options.mode);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-show-layering]')) {
    el.hidden = !el.dataset.showLayering!.split(' ').includes(options.layering);
  }
  renderPalette();
}

for (const el of optEls) {
  el.addEventListener('input', () => {
    readControl(el);
    if (el.dataset.opt === 'mode' && options.mode === 'palette') options.hidden = [];
    presetSelect.value = '';
    writeControls();
    saveOptions();
    scheduleRun();
  });
}

presetSelect.addEventListener('change', () => {
  const preset = PRESETS[presetSelect.value];
  if (!preset) return;
  options = { ...options, ...preset, hidden: [] };
  writeControls();
  presetSelect.value = Object.keys(PRESETS).find((k) => PRESETS[k] === preset) ?? '';
  saveOptions();
  scheduleRun();
});

$('#btn-reset').addEventListener('click', () => {
  options = { ...DEFAULT_OPTIONS };
  presetSelect.value = '';
  writeControls();
  saveOptions();
  scheduleRun();
});

// ---------- palette ----------
function renderPalette(): void {
  paletteEl.innerHTML = '';
  let anyHidden = false;
  if (options.mode === 'palette') {
    options.palette.forEach((hex, i) => {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.setProperty('--c', hex);
      sw.title = hex;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = hex;
      input.addEventListener('input', () => {
        options.palette[i] = input.value;
        sw.style.setProperty('--c', input.value);
        sw.title = input.value;
        saveOptions();
        scheduleRun(250);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.title = 'Remove color';
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        options.palette.splice(i, 1);
        writeControls();
        saveOptions();
        scheduleRun();
      });
      sw.append(input, remove);
      paletteEl.append(sw);
    });
    if (options.palette.length === 0) {
      const note = document.createElement('span');
      note.className = 'empty-note';
      note.textContent = 'Add colors or pick them from the image.';
      paletteEl.append(note);
    }
  } else if (result) {
    const total = result.palette.reduce((s, p) => s + p.count, 0) || 1;
    for (const p of result.palette) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch' + (p.hidden ? ' hidden-color' : '');
      sw.style.setProperty('--c', p.color);
      sw.title = `${p.color} · ${((100 * p.count) / total).toFixed(1)}%` + (p.hidden ? ' (hidden)' : '');
      sw.addEventListener('click', () => {
        const set = new Set(options.hidden);
        if (set.has(p.color)) set.delete(p.color);
        else set.add(p.color);
        options.hidden = [...set];
        scheduleRun(0);
      });
      paletteEl.append(sw);
      anyHidden ||= p.hidden;
    }
  } else {
    const note = document.createElement('span');
    note.className = 'empty-note';
    note.textContent = 'Load an image to detect its colors.';
    paletteEl.append(note);
  }
  btnShowAll.hidden = !anyHidden;
}

btnShowAll.addEventListener('click', () => {
  options.hidden = [];
  scheduleRun(0);
});

$('#btn-palette-edit').addEventListener('click', () => {
  if (result) options.palette = result.palette.filter((p) => !p.hidden).map((p) => p.color);
  options.mode = 'palette';
  options.hidden = [];
  presetSelect.value = '';
  writeControls();
  saveOptions();
  scheduleRun();
});

$('#btn-palette-add').addEventListener('click', () => {
  options.palette.push(options.palette.length % 2 ? '#ffffff' : '#000000');
  writeControls();
  saveOptions();
  scheduleRun();
});

$('#btn-palette-detect').addEventListener('click', () => {
  if (!hasImage) return;
  // Run one detection pass in auto mode, then copy the result into the custom palette.
  detectForPalette = true;
  engine.run({ ...options, mode: 'auto', hidden: [] });
  setStatus('Detecting colors…', 'busy');
});

// ---------- running ----------
function scheduleRun(delay = 120): void {
  clearTimeout(runTimer);
  runTimer = window.setTimeout(run, delay);
}

function run(): void {
  if (!hasImage) return;
  detectForPalette = false;
  setStatus('Processing…', 'busy');
  engine.run({ ...options, palette: [...options.palette], hidden: [...options.hidden] });
}

function onResult(res: VectorizeResult): void {
  if (detectForPalette) {
    detectForPalette = false;
    options.palette = res.palette.map((p) => p.color);
    writeControls();
    saveOptions();
    run();
    return;
  }
  result = res;
  if (vectorUrl) URL.revokeObjectURL(vectorUrl);
  vectorUrl = URL.createObjectURL(new Blob([res.svg], { type: 'image/svg+xml' }));
  imgVector.src = vectorUrl;
  imageSize = { w: res.width, h: res.height };
  applyZoom();
  const ms = Object.values(res.timings).reduce((a, b) => a + b, 0);
  const kb = new Blob([res.svg]).size / 1024;
  const colors = res.palette.filter((p) => !p.hidden).length;
  const traced = res.scale > 1 ? ` (traced at ${res.scale}×)` : '';
  statsEl.textContent = `${res.width}×${res.height}${traced} · ${colors} colors · ${res.paths} shapes · ${res.points.toLocaleString()} points · ${kb.toFixed(1)} KB · ${ms.toFixed(0)} ms`;
  btnDownload.disabled = false;
  btnCopy.disabled = false;
  statsEl.dataset.runs = String(Number(statsEl.dataset.runs ?? 0) + 1);
  setStatus('');
  renderPalette();
}

function setStatus(text: string, kind: '' | 'busy' | 'error' = ''): void {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- image loading ----------
async function loadBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    let w = img.naturalWidth || 1024;
    let h = img.naturalHeight || 1024;
    const scale = Math.min(1, HARD_MAX_INPUT / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    setImage(data, name, url);
  } catch (err) {
    URL.revokeObjectURL(url);
    setStatus(`Could not load ${name}: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('not a supported image'));
    img.src = url;
  });
}

function setImage(data: ImageData, name: string, url: string): void {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  originalUrl = url;
  imgOriginal.src = url;
  imageName = name.replace(/\.[a-z0-9]+$/i, '') || 'image';
  imageSize = { w: data.width, h: data.height };
  hasImage = true;
  result = null;
  options.hidden = [];
  emptyState.hidden = true;
  stage.classList.add('ready');
  btnDownload.disabled = true;
  btnCopy.disabled = true;
  statsEl.textContent = `${data.width}×${data.height}`;
  engine.setImage(data);
  fitZoom();
  run();
}

function openPicker(): void {
  fileInput.value = '';
  fileInput.click();
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadBlob(f, f.name);
});
$('#btn-open').addEventListener('click', openPicker);
$('#btn-open-2').addEventListener('click', openPicker);

async function loadSample(): Promise<void> {
  const canvas = drawSample();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (blob) await loadBlob(blob, 'sample.png');
}
$('#btn-sample').addEventListener('click', () => void loadSample());
$('#btn-sample-2').addEventListener('click', () => void loadSample());

// drag & drop
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadBlob(f, f.name);
});

// paste
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        void loadBlob(f, f.name || 'pasted.png');
        return;
      }
    }
  }
});

// ---------- export ----------
btnDownload.addEventListener('click', () => {
  if (!result) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
  a.download = `${imageName}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

btnCopy.addEventListener('click', async () => {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.svg);
    setStatus('SVG copied to clipboard');
    setTimeout(() => statusEl.textContent === 'SVG copied to clipboard' && setStatus(''), 2000);
  } catch {
    setStatus('Clipboard not available', 'error');
  }
});

// ---------- view / zoom / pan ----------
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="view"]')) {
  radio.addEventListener('change', () => {
    if (radio.checked) setView(radio.value as View);
  });
}

function setView(v: View): void {
  view = v;
  stage.dataset.view = v;
  divider.hidden = v !== 'split';
  applySplit();
}

function applySplit(): void {
  if (view === 'split') {
    imgVector.style.clipPath = `inset(0 0 0 ${split * 100}%)`;
    divider.style.left = `${split * 100}%`;
  } else {
    imgVector.style.clipPath = '';
  }
}

function applyZoom(): void {
  stage.style.width = `${imageSize.w * zoom}px`;
  stage.style.height = `${imageSize.h * zoom}px`;
  stage.classList.toggle('pixelated', zoom >= 3);
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(z: number, anchor?: { x: number; y: number }): void {
  z = Math.min(64, Math.max(0.02, z));
  const rect = viewport.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : viewport.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : viewport.clientHeight / 2;
  const cx = (viewport.scrollLeft + ax - STAGE_MARGIN) / zoom;
  const cy = (viewport.scrollTop + ay - STAGE_MARGIN) / zoom;
  zoom = z;
  applyZoom();
  viewport.scrollLeft = cx * zoom + STAGE_MARGIN - ax;
  viewport.scrollTop = cy * zoom + STAGE_MARGIN - ay;
}

function fitZoom(): void {
  if (!imageSize.w) return;
  const z = Math.min(
    (viewport.clientWidth - STAGE_MARGIN * 2) / imageSize.w,
    (viewport.clientHeight - STAGE_MARGIN * 2) / imageSize.h,
  );
  zoom = Math.max(0.02, z);
  applyZoom();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom-fit').addEventListener('click', fitZoom);
$('#zoom-100').addEventListener('click', () => setZoom(1));

viewport.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls/pans
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);

let drag: { x: number; y: number; sl: number; st: number; split: boolean } | null = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const onDivider = divider.contains(e.target as Node);
  drag = { x: e.clientX, y: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop, split: onDivider };
  viewport.setPointerCapture(e.pointerId);
  if (!onDivider) viewport.classList.add('dragging');
});
viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.split) {
    const rect = stage.getBoundingClientRect();
    split = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    applySplit();
  } else {
    viewport.scrollLeft = drag.sl - (e.clientX - drag.x);
    viewport.scrollTop = drag.st - (e.clientY - drag.y);
  }
});
const endDrag = () => {
  drag = null;
  viewport.classList.remove('dragging');
};
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25);
  else if (e.key === '-') setZoom(zoom / 1.25);
  else if (e.key === '0') fitZoom();
  else if (e.key === '1') setZoom(1);
  else if (e.key === 'o' && !e.ctrlKey && !e.metaKey) openPicker();
});

// ---------- init ----------
writeControls();
setView('vector');
// Tell the inline boot check in index.html that the app is running.
(window as unknown as { __vectorizeBoot?: string }).__vectorizeBoot = 'ready';
try {
  sessionStorage.removeItem('vectorize.reloaded');
} catch {
  /* storage may be unavailable */
}
