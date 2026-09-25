import { sym, CHARMAP } from '../game/symbols.js';

// Renders text panels with the Game Boy font read from the ROM (1bpp, 8x8, chars $80-$FF).
// rendered at 1x (ffmpeg scales it 2x with nearest-neighbor)
export const PANEL_W = 288, PANEL_H = 288;
const SCALE = 1, CELL = 8 * SCALE, LINE_H = 10;
const BG = [21, 21, 20], FG = [236, 236, 230], ACCENT = [124, 196, 155], DIM = [154, 154, 146];

const EXTRA: Record<string, number[]> = {
  '%': [0x62, 0x64, 0x08, 0x10, 0x26, 0x46, 0x00, 0x00],
  '>': [0x20, 0x10, 0x08, 0x04, 0x08, 0x10, 0x20, 0x00],
  '#': [0x24, 0x7e, 0x24, 0x24, 0x7e, 0x24, 0x00, 0x00],
  '|': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x00],
};

export class PanelRenderer {
  private glyph = new Map<string, number[]>();

  constructor(rom: Uint8Array) {
    const base = sym('FontGraphics');
    for (const [codeStr, ch] of Object.entries(CHARMAP)) {
      const code = +codeStr;
      if (code < 0x80 || ch.length !== 1 || this.glyph.has(ch)) continue;
      this.glyph.set(ch, Array.from(rom.subarray(base + (code - 0x80) * 8, base + (code - 0x80) * 8 + 8)));
    }
    for (const [ch, bits] of Object.entries(EXTRA)) this.glyph.set(ch, bits);
    this.glyph.set('→', this.glyph.get('▶') ?? EXTRA['>']);
  }

  get cols() { return Math.floor(PANEL_W / CELL); }

  /** Lines starting with "# " are headings (accent color); "~ " = dim. */
  render(lines: string[]): Uint8Array {
    const out = new Uint8Array(PANEL_W * PANEL_H * 4);
    for (let i = 0; i < out.length; i += 4) { out[i] = BG[0]; out[i + 1] = BG[1]; out[i + 2] = BG[2]; out[i + 3] = 255; }
    lines.slice(0, Math.floor(PANEL_H / LINE_H)).forEach((raw, row) => {
      let color = FG, text = raw;
      if (raw.startsWith('# ')) { color = ACCENT; text = raw.slice(2); }
      else if (raw.startsWith('~ ')) { color = DIM; text = raw.slice(2); }
      [...text].slice(0, this.cols).forEach((ch, col) => {
        const g = this.glyph.get(ch) ?? this.glyph.get(ch.toUpperCase());
        if (!g) return;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (!(g[y] & (0x80 >> x))) continue;
          for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
            const px = col * CELL + x * SCALE + sx, py = row * LINE_H + 1 + y * SCALE + sy;
            const o = (py * PANEL_W + px) * 4;
            out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2];
          }
        }
      });
    });
    return out;
  }
}
