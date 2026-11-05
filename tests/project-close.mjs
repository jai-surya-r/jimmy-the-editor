// Closing a project (the X on its tab): GET /work lists what it still has running, POST /close stops it and the
// server lets go of it; a project another editor window has open keeps going. Also: the export list is shared
// between callers and asked for afresh with ?fresh.
//   node tests/project-close.mjs
import { startServer, openGolden, api, PORT } from './lib/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const srv = await startServer();
let ws = null;
try {
  const { id } = await openGolden();
  // another editor window with the project open
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: 'hello', clientId: 'other' }));
  ws.send(JSON.stringify({ type: 'subscribe', projectId: id }));
  await sleep(300);

  const { job } = await api('POST', `/api/p/${id}/render`, { sequenceId: 's_cuts', quality: 'high', addVersion: false, name: `close-test-${Date.now()}` });
  await sleep(500);
  let w = await api('GET', `/api/p/${id}/work?client=me`);
  ok(w.exports === 1, `the running export is listed (${JSON.stringify(w)})`);
  ok(w.others, 'another window has the project open');
  let r = await api('POST', `/api/p/${id}/close`, { client: 'me' });
  ok(!r.closed, '…so closing this tab stops nothing');
  ok((await api('GET', '/api/jobs')).jobs.find((j) => j.id === job.id)?.status !== 'canceled', '…and the export goes on');

  ws.send(JSON.stringify({ type: 'unsubscribe', projectId: id }));
  await sleep(300);
  w = await api('GET', `/api/p/${id}/work?client=me`);
  ok(!w.others, 'no other window now');
  r = await api('POST', `/api/p/${id}/close`, { client: 'me' });
  ok(r.closed, 'closing shuts the project down');
  ok((await api('GET', '/api/jobs')).jobs.find((j) => j.id === job.id)?.status === 'canceled', 'its export was stopped');
  w = await api('GET', `/api/p/${id}/work?client=me`);
  ok(!w.exports && !w.proxies && !w.graphics && !w.chats, `nothing left running (${JSON.stringify(w)})`);

  const p = await api('GET', `/api/p/${id}`);
  ok(p.doc?.sequences?.length > 0, 'it opens again');
  const a = await api('GET', `/api/p/${id}/exports`);
  const b = await api('GET', `/api/p/${id}/exports?fresh=1`);
  ok(Array.isArray(a.files) && Array.isArray(b.files), `the export list answers (${b.files.length} files)`);
  const { job: j2 } = await api('POST', `/api/p/${id}/render`, { sequenceId: 's_text', quality: 'draft', addVersion: false, wait: true, name: `close-test-2-${Date.now()}` });
  ok(j2.status === 'done', 'and exports again after closing');
} catch (err) {
  console.log('  FAIL ', err.message);
  failed++;
} finally {
  ws?.close();
  await srv.stop();
}
console.log(failed ? `project-close: ${failed} failed` : 'project-close: all checks passed');
process.exit(failed ? 1 : 0);
