import { Worker } from 'node:worker_threads';
import { PanelRenderer, PANEL_W, PANEL_H } from './panel.js';

const AUDIO_RING = 44100 * 4; // 4 seconds

/** Headless live stream: game screen + Jev panel → ffmpeg → RTMP (YouTube/Twitch) or a local file. */
export class Streamer {
  private frame = new SharedArrayBuffer(160 * 144 * 4);
  private panel = new SharedArrayBuffer(PANEL_W * PANEL_H * 4);
  private frameView = new Uint8Array(this.frame);
  private panelView = new Uint8Array(this.panel);
  private renderer: PanelRenderer;
  // audio ring: interleaved stereo float32, written by the main thread, read by the worker
  private audio = new SharedArrayBuffer(AUDIO_RING * 2 * 4);
  private audioView = new Float32Array(this.audio);
  private audioPos = new SharedArrayBuffer(4);
  private audioPosView = new Int32Array(this.audioPos);
  private wpos = 0;
  private worker: Worker;

  constructor(url: string, rom: Uint8Array, onLog: (msg: string) => void, fps = 30) {
    this.renderer = new PanelRenderer(rom);
    this.setPanel(['# JEV PLAYS POKEMON RED', '', 'starting...']);
    this.worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { frameBuf: this.frame, panelBuf: this.panel, panelW: PANEL_W, panelH: PANEL_H, url, fps, audioBuf: this.audio, audioPosBuf: this.audioPos, audioRing: AUDIO_RING },
    });
    this.worker.on('message', (m) => m.type === 'log' && onLog(m.msg));
    this.worker.on('error', (e: Error) => onLog(`stream worker error: ${e.message}`));
  }

  get cols() { return this.renderer.cols; }

  pushAudio(l: number, r: number) {
    const i = this.wpos % AUDIO_RING;
    this.audioView[i * 2] = l; this.audioView[i * 2 + 1] = r;
    this.wpos++;
    if ((this.wpos & 255) === 0) Atomics.store(this.audioPosView, 0, this.wpos);
  }

  pushFrame(rgba: ArrayLike<number>) {
    this.frameView.set(rgba as ArrayLike<number>);
  }

  setPanel(lines: string[]) {
    this.panelView.set(this.renderer.render(lines));
  }

  stop() { this.worker.postMessage('stop'); }
}

/** Word-wrap for the monospace panel. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      if ((line + ' ' + w).trim().length > width) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out;
}
