import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const Gameboy = require('serverboy');

export type Button = 'A' | 'B' | 'START' | 'SELECT' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** Thin wrapper over serverboy (GameBoy-Online core) with direct memory/ROM access and save states. */
export class Emulator {
  private gb: any;
  frames = 0;
  onFrame?: (screen: ArrayLike<number>, frame: number) => void;

  constructor(rom: Buffer) {
    this.gb = new Gameboy();
    this.gb.loadRom(rom);
  }

  /** Called for every stereo audio sample pair (≈44.15 kHz, floats in [-1,1]). */
  onAudio?: (l: number, r: number) => void;

  /** Hook the core's audio output (serverboy computes samples but never plays them). */
  enableAudioTap() {
    const core = this.core;
    const orig = core.outputAudio.bind(core);
    const self = this;
    core.outputAudio = function () {
      const l = (this.downsampleInput >>> 16) * this.downSampleInputDivider - 1;
      const r = (this.downsampleInput & 0xffff) * this.downSampleInputDivider - 1;
      self.onAudio?.(l, r);
      orig();
    };
  }

  get core(): any {
    return (Object.values(this.gb)[0] as any).gameboy;
  }

  /** Advance one frame, optionally holding buttons during it. */
  frame(hold: Button[] = []) {
    if (hold.length) this.gb.pressKeys(hold);
    this.gb.doFrame();
    this.frames++;
    this.onFrame?.(this.gb.getScreen(), this.frames);
  }

  wait(n: number) {
    for (let i = 0; i < n; i++) this.frame();
  }

  /** Tap a button: hold for `hold` frames then release for `release` frames. */
  press(b: Button, hold = 4, release = 8) {
    for (let i = 0; i < hold; i++) this.frame([b]);
    this.wait(release);
  }

  hold(b: Button, frames: number) {
    for (let i = 0; i < frames; i++) this.frame([b]);
  }

  get mem(): Uint8Array {
    return this.core.memory;
  }
  get rom(): Uint8Array {
    return this.core.ROM;
  }

  screen(): ArrayLike<number> {
    return this.gb.getScreen();
  }

  saveState(file: string) {
    fs.writeFileSync(file, JSON.stringify({ frames: this.frames, state: this.core.saveState() }));
  }

  loadState(file: string) {
    const { frames, state } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tap = this.core.outputAudio;
    this.core.saving(state);
    if (this.core.outputAudio !== tap && this.onAudio) this.enableAudioTap();
    this.frames = frames;
  }
}
