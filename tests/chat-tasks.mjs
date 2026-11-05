// A chat's background commands (server/chats.js): a Bash call Claude sends to the background shows as running,
// with the last line of its output file and a percentage; Claude Code saying it finished ends it; a turn Claude starts by
// itself (after the command finished) shows the chat as working again. No Claude is started.
//   node tests/chat-tasks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { WORK } from './lib/server.mjs';

process.env.JIMMY_DATA_DIR = path.join(WORK, 'chat-tasks-data');
const { ChatManager } = await import('../server/chats.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) failed++; };

const chats = new ChatManager({ port: 0, emit: () => {} });
const s = { projectId: 'p1', key: 'k', running: true, busy: false, log: [], pending: new Map() };
chats.sessions.set('p1', s);
const out = path.join(WORK, 'chat-tasks', 'tasks', 'b1x2y3.output');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '');

const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const user = (content) => ({ type: 'user', message: { role: 'user', content } });

s.busy = true;
chats.onMessage(s, assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'render.sh', description: 'Render the B-roll', run_in_background: true } }]));
chats.onMessage(s, user([{ type: 'tool_result', tool_use_id: 'tu1', content: `Command running in background with ID: b1x2y3. Output is being written to: ${out}` }]));
chats.onMessage(s, { type: 'result', subtype: 'success', is_error: false, usage: {} });
let info = chats.info('p1');
ok(!info.busy, 'the reply ended');
ok(info.tasks.length === 1 && info.tasks[0].desc === 'Render the B-roll', 'the background command shows as running');

fs.appendFileSync(out, 'frame 10\nframe 20\r 42% done\r');
await sleep(2600);
info = chats.info('p1');
ok(info.tasks[0].last === '42% done' && Math.abs(info.tasks[0].pct - 0.42) < 1e-9, `its last line and percentage (${info.tasks[0].last}, ${info.tasks[0].pct})`);

chats.onMessage(s, user('<task-notification>\n<task-id>b1x2y3</task-id>\n<status>completed</status>\n</task-notification>'));
ok(chats.info('p1').tasks.length === 0, 'the task-notification ends it');
chats.onMessage(s, assistant([{ type: 'text', text: 'The render finished.' }]));
ok(chats.info('p1').busy, 'Claude carrying on by itself shows as working');

// as Claude Code sends it on stdout now (messages as captured from claude 2.1.316)
const bash = (id, tid, running = [tid]) => {
  chats.onMessage(s, assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', description: tid, run_in_background: true } }]));
  chats.onMessage(s, { type: 'system', subtype: 'background_tasks_changed', tasks: running.map((t) => ({ task_id: t, task_type: 'local_bash', description: t })) });
  chats.onMessage(s, { type: 'system', subtype: 'task_started', task_id: tid, tool_use_id: id, is_backgrounded: true, task_type: 'local_bash' });
  chats.onMessage(s, user([{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${tid}. Output is being written to: ${out}. You will be notified when it completes.` }]));
};
bash('tu5', 'bnw2vbzmc');
chats.onMessage(s, { type: 'result', subtype: 'success', is_error: false, usage: {} });
ok(chats.info('p1').tasks.length === 1, 'a command shows as running after the reply ended');
chats.onMessage(s, { type: 'system', subtype: 'task_updated', task_id: 'bnw2vbzmc', patch: { status: 'completed' } });
chats.onMessage(s, { type: 'system', subtype: 'task_notification', task_id: 'bnw2vbzmc', tool_use_id: 'tu5', status: 'completed', output_file: out, summary: 'Background command "x" completed (exit code 0)' });
ok(chats.info('p1').tasks.length === 0, 'the task_notification event ends it');
bash('tu6', 'keeps1');
bash('tu7', 'goes2', ['keeps1', 'goes2']);
chats.onMessage(s, { type: 'system', subtype: 'task_notification', task_id: 'other', status: 'completed' });
ok(chats.info('p1').tasks.length === 2, "another task's event leaves them running");
chats.onMessage(s, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'keeps1', task_type: 'local_bash' }] });
ok(chats.info('p1').tasks.length === 1 && chats.info('p1').tasks[0].desc === 'keeps1', 'the list of what still runs ends the one that left it');
chats.onMessage(s, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
ok(chats.info('p1').tasks.length === 0, '…and an empty list ends the rest');

// Claude Code's own housekeeping note: Claude answers it, but that is no reply for anyone to be told about
const emitted = [];
const noted = new ChatManager({ port: 0, emit: (id, m) => emitted.push(m) });
const q = { projectId: 'p2', key: 'k2', running: true, busy: false, log: [], pending: new Map() };
noted.sessions.set('p2', q);
const expired = '<task-notification>\n<task-id>bguyfvzxm</task-id>\n<summary>Monitor event: "x"</summary>\n<event>[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>';
noted.onMessage(q, { type: 'user', message: { role: 'user', content: expired } });
noted.onMessage(q, assistant([{ type: 'text', text: 'Nothing is needed.' }]));
ok(!noted.info('p2').busy, "the answer to a housekeeping note doesn't show the chat as working");
noted.onMessage(q, { type: 'result', subtype: 'success', is_error: false, usage: {} });
ok(!emitted.some((m) => m.type === 'chat-notice'), '…and raises no message in the editor');
noted.onMessage(q, user('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>'));
noted.onMessage(q, assistant([{ type: 'text', text: 'The render finished.' }]));
ok(noted.info('p2').busy, 'a finished command still wakes the chat');
noted.onMessage(q, { type: 'result', subtype: 'success', is_error: false, usage: {} });
ok(emitted.some((m) => m.type === 'chat-notice'), '…and says so');
noted.onMessage(q, user(expired));
noted.onMessage(q, assistant([{ type: 'tool_use', id: 'tu9', name: 'Read', input: {} }]));
ok(noted.info('p2').busy, 'if Claude does real work after a note, it shows');
noted.onMessage(q, { type: 'result', subtype: 'success', is_error: false, usage: {} });
noted.stop(q);

// stopped by Claude
chats.onMessage(s, assistant([{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'sleep 100', run_in_background: true } }]));
chats.onMessage(s, user([{ type: 'tool_result', tool_use_id: 'tu2', content: 'Command running in background with ID: zz9.' }]));
ok(chats.info('p1').tasks.length === 1 && chats.info('p1').tasks[0].desc === 'sleep 100', 'a second one, without an output file');
chats.onMessage(s, assistant([{ type: 'tool_use', id: 'tu3', name: 'KillShell', input: { shell_id: 'zz9' } }]));
ok(chats.info('p1').tasks.length === 0, 'stopped by Claude');
// a plain (foreground) command is not a background task
chats.onMessage(s, assistant([{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: 'ls' } }]));
chats.onMessage(s, user([{ type: 'tool_result', tool_use_id: 'tu4', content: 'a.txt' }]));
ok(chats.info('p1').tasks.length === 0, 'a foreground command is not listed');

chats.stop(s);
fs.rmSync(path.join(WORK, 'chat-tasks'), { recursive: true, force: true });
fs.rmSync(process.env.JIMMY_DATA_DIR, { recursive: true, force: true });
console.log(failed ? `chat-tasks: ${failed} failed` : 'chat-tasks: all checks passed');
process.exit(failed ? 1 : 0);
