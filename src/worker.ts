/// <reference lib="webworker" />
import { PREPARE_KEYS, prepare, trace, type Prepared, type RasterImage, type VectorizeOptions, type VectorizeResult } from './core';

export type WorkerRequest =
  | { type: 'image'; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'run'; id: number; options: VectorizeOptions };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'result'; id: number; result: VectorizeResult }
  | { type: 'error'; id: number; message: string };

let image: RasterImage | null = null;
let cache: { key: string; prepared: Prepared } | null = null;

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'image') {
    image = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
    cache = null;
    return;
  }
  if (msg.type === 'run') {
    const { id, options } = msg;
    if (!image) {
      post({ type: 'error', id, message: 'No image loaded' });
      return;
    }
    try {
      const progress = (stage: string, fraction: number) => post({ type: 'progress', id, stage, fraction });
      const key = JSON.stringify(PREPARE_KEYS.map((k) => options[k]));
      let prepared: Prepared;
      if (cache && cache.key === key) {
        prepared = cache.prepared;
      } else {
        prepared = prepare(image, options, progress);
        cache = { key, prepared };
      }
      const result = trace(prepared, options, progress);
      post({ type: 'result', id, result });
    } catch (err) {
      post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
