// The Jimmy server in a process of its own (Electron's utility process), started by electron/main.js. Keeping it
// out of the app's main process means its work (saving projects, reading ffmpeg's output, planning renders, sending
// updates) never holds up the editor window's clicks, keys and drawing. Talks to the main process over
// process.parentPort: it says when it is ready (the editor's URL) and when the app should end; the main process
// asks it what is still running and tells it to shut down. Motion pages and the Recycle Bin go the other way
// (server/apphost.js).
const port = process.parentPort;
const send = (m) => port.postMessage(m);

try {
  const server = await import('../server/index.js');
  server.onExit(() => send({ t: 'exit' }));
  port.on('message', (e) => {
    const m = e.data;
    if (m?.t === 'busy') send({ t: 'busy', n: m.n, work: server.busyWork() });
    else if (m?.t === 'shutdown') server.shutdown();
    else if (m?.t === 'perfEvent') server.perflog?.event(m.kind, m.data || {});
  });
  const { url } = await server.ready;
  send({ t: 'ready', url });
} catch (err) {
  send({ t: 'failed', error: String(err?.stack || err) });
}
