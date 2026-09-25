import fs from 'node:fs';

// Minimal .env loader (keeps Node 20 compatibility). Existing env vars win.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Accept the Vercel-prefixed name too (AI SDK reads AI_GATEWAY_API_KEY).
if (!process.env.AI_GATEWAY_API_KEY && process.env.VERCEL_AI_GATEWAY_API_KEY) process.env.AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_API_KEY;

// YouTube: just paste the stream key; the RTMP URL is derived.
if (!process.env.STREAM_URL && process.env.YOUTUBE_STREAM_KEY) process.env.STREAM_URL = `rtmp://a.rtmp.youtube.com/live2/${process.env.YOUTUBE_STREAM_KEY}`;
