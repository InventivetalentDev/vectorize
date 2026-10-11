import type { VectorizeOptions, VectorizeResult } from './core';
import type { WorkerRequest, WorkerResponse } from './worker';

export interface EngineEvents {
  onProgress?: (stage: string, fraction: number) => void;
  onResult?: (result: VectorizeResult, options: VectorizeOptions) => void;
  onError?: (message: string) => void;
}

/**
 * Runs the vectorizer in a Web Worker. Only one job runs at a time; a new
 * request while a job is running restarts the worker so sliders stay snappy.
 */
export class Engine {
  private worker: Worker | null = null;
  private image: ImageData | null = null;
  private busy = false;
  private nextId = 1;
  private currentId = 0;
  private currentOptions: VectorizeOptions | null = null;

  constructor(private events: EngineEvents) {}

  setImage(image: ImageData): void {
    this.image = image;
    this.restart();
  }

  run(options: VectorizeOptions): void {
    if (!this.image) return;
    if (this.busy || !this.worker) this.restart();
    const id = this.nextId++;
    this.currentId = id;
    this.currentOptions = options;
    this.busy = true;
    this.send({ type: 'run', id, options });
  }

  private restart(): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      this.busy = false;
      this.events.onError?.(ev.message || 'Worker error');
    };
    this.busy = false;
    if (this.image) {
      // Copy so the main thread keeps its own pixels for later restarts.
      const buffer = this.image.data.buffer.slice(0) as ArrayBuffer;
      this.send({ type: 'image', width: this.image.width, height: this.image.height, buffer }, [buffer]);
    }
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private handle(msg: WorkerResponse): void {
    if (msg.id !== this.currentId) return;
    if (msg.type === 'progress') {
      this.events.onProgress?.(msg.stage, msg.fraction);
    } else if (msg.type === 'result') {
      this.busy = false;
      this.events.onResult?.(msg.result, this.currentOptions!);
    } else {
      this.busy = false;
      this.events.onError?.(msg.message);
    }
  }
}
