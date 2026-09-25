// Worker thread: owns ffmpeg and feeds it two small raw inputs at a steady rate —
// the 160x144 game screen (stdin) and the 288x288 Jev panel (fd 3). ffmpeg upscales
// (nearest-neighbor) and lays them out at 1280x720. Independent of the main thread.
import { workerData, parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';

const { frameBuf, panelBuf, panelW, panelH, url, fps, audioBuf, audioPosBuf, audioRing } = workerData;
const audio = new Float32Array(audioBuf), audioPos = new Int32Array(audioPosBuf);
const RATE = 44151; // serverboy's native output rate (4194304 / 95)
const game = new Uint8Array(frameBuf), panel = new Uint8Array(panelBuf);

function start() {
  const rtmp = url.startsWith('rtmp');
  const filter = [
    `[0:v]scale=640:576:flags=neighbor[g]`,
    `[1:v]scale=${panelW * 2}:${panelH * 2}:flags=neighbor[p]`,
    `color=c=0x151514:s=1280x720:r=${fps}[bg]`,
    `[bg][g]overlay=24:72:shortest=1[a]`,
    `[a][p]overlay=680:72:shortest=1,format=yuv420p[v]`,
    `[2:a]aresample=44100,highpass=f=20,volume=0.9[au]`,
  ].join(';');
  const args = [
    '-loglevel', 'warning', '-stats_period', '10', '-stats', '-nostdin', '-fflags', '+nobuffer',
    '-thread_queue_size', '512', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '160x144', '-framerate', String(fps), '-i', 'pipe:0',
    '-thread_queue_size', '512', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${panelW}x${panelH}`, '-framerate', String(fps), '-i', 'pipe:3',
    '-thread_queue_size', '512', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:4',
    '-filter_complex', filter, '-map', '[v]', '-map', '[au]',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', '3000k', '-minrate', '3000k', '-maxrate', '3000k', '-bufsize', '3000k', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k',
    ...(rtmp ? ['-f', 'flv'] : ['-y']), url,
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const gameIn = ff.stdin, panelIn = ff.stdio[3], audioIn = ff.stdio[4];
  audioIn.on('error', () => {});
  ff.stderr.on('data', (d) => parentPort.postMessage({ type: 'log', msg: String(d).replace(/\r/g, '').trim() }));
  gameIn.on('error', () => {});
  panelIn.on('error', () => {});
  let stopped = false;
  ff.on('exit', (code) => {
    stopped = true;
    parentPort.postMessage({ type: 'log', msg: `ffmpeg exited (${code}); restarting in 5s` });
    setTimeout(start, 5000);
  });
  // Wall-clock pacing for BOTH video and audio from one clock, so ffmpeg sees a steady real-time feed.
  const t0 = Date.now();
  let sent = 0, sentSamples = 0, rpos = Atomics.load(audioPos, 0);
  let lastTick = Date.now();
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastTick > 300) parentPort.postMessage({ type: 'log', msg: `feeder stalled ${now - lastTick}ms` });
    lastTick = now;
    const due = Math.floor(((now - t0) * fps) / 1000);
    while (sent < due) { // one frame per slot; repeat the current frame if the game is paused
      if (gameIn.writableLength > 160 * 144 * 4 * fps) { sent = due; break; }
      gameIn.write(Buffer.from(game));
      panelIn.write(Buffer.from(panel));
      sent++;
    }
    const dueS = Math.floor(((now - t0) * RATE) / 1000) - sentSamples;
    if (dueS > 0) {
      const wpos = Atomics.load(audioPos, 0);
      if (wpos - rpos > RATE / 2) rpos = wpos - Math.floor(RATE / 4); // emulator ran ahead: keep latency low
      const avail = Math.max(0, Math.min(wpos - rpos, dueS));
      const out = Buffer.alloc(dueS * 4);
      for (let i = 0; i < avail; i++) {
        const j = ((rpos + i) % audioRing) * 2;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[j] * 0.8 * 32767))), i * 4);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[j + 1] * 0.8 * 32767))), i * 4 + 2);
      }
      rpos += avail; // missing samples (game paused on a Jev call) stay silent
      sentSamples += dueS;
      if (audioIn.writableLength < RATE * 4) audioIn.write(out);
    }
    setTimeout(tick, 5);
  };
  tick();
  parentPort.postMessage({ type: 'log', msg: `streaming → ${url.replace(/\/live2\/.*/, '/live2/<key>')}` });
}
start();
parentPort.on('message', (m) => { if (m === 'stop') process.exit(0); });
