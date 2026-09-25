import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8787');
ws.on('open', () => { ws.send(JSON.stringify({ cmd: 'save' })); setTimeout(() => process.exit(0), 3000); });
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
