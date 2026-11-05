// A stand-in for the `claude` CLI in stream-json mode, for tests of the chat panel: no Claude is started.
// Says what Claude Code says about shell commands (task_started, stop_task, task_notification), as measured on
// Claude Code 2.1.317. A message containing "fg" runs a command Claude waits for; "bg" one in the background.
// Every control request it gets is appended to FAKE_CLAUDE_LOG (one JSON line each).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

// a real PNG of noise (base64, about 1 MB): what a screenshot of a frame weighs
function noisePng(seed, w = 640, h = 400) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let s = seed * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; raw[i] = i % (w * 3 + 1) === 0 ? 0 : s >>> 24; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (o) => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(o)}\n`); };
const session = 'fake-session-0001';
const running = new Map(); // task id -> tool_use id (null: in the background)
const assistant = (content) => out({ type: 'assistant', message: { id: `msg_${Date.now()}`, role: 'assistant', model: 'fake', content, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: session });
const user = (content) => out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: session });
const result = () => out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });

out({ type: 'system', subtype: 'init', session_id: session, model: 'fake', tools: ['Bash'] });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'control_request') {
      log(m.request);
      if (m.request.subtype === 'stop_task' && running.has(m.request.task_id)) {
        const id = m.request.task_id, tu = running.get(id);
        running.delete(id);
        out({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status: 'killed', end_time: Date.now() }, session_id: session });
        out({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: tu || undefined, status: 'stopped', summary: 'stopped', session_id: session });
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        if (tu) {
          user([{ type: 'tool_result', tool_use_id: tu, content: 'Exit code 137\n\n[killed]', is_error: true }]);
          assistant([{ type: 'text', text: 'The command was stopped, so I carried on without it.' }]);
          result();
        }
      } else out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      continue;
    }
    if (m.type !== 'user') continue;
    const text = (m.message.content || []).map((b) => b.text || '').join(' ');
    if (/\bfg\b/.test(text)) {
      assistant([{ type: 'tool_use', id: 'toolu_fg1', name: 'Bash', input: { command: 'node long-job.js', description: 'Run the long job' } }]);
      setTimeout(() => {
        running.set('tfg1', 'toolu_fg1');
        out({ type: 'system', subtype: 'task_started', task_id: 'tfg1', tool_use_id: 'toolu_fg1', description: 'Run the long job', is_backgrounded: false, task_type: 'local_bash', session_id: session });
      }, 400);
    } else if (/\bbg\b/.test(text)) {
      const file = path.join(os.tmpdir(), 'fake-claude-tbg1.output');
      fs.writeFileSync(file, 'rendering 10%\n');
      assistant([{ type: 'tool_use', id: 'toolu_bg1', name: 'Bash', input: { command: 'node render.js', description: 'Render in the background', run_in_background: true } }]);
      running.set('tbg1', null);
      out({ type: 'system', subtype: 'task_started', task_id: 'tbg1', tool_use_id: 'toolu_bg1', description: 'Render in the background', is_backgrounded: true, task_type: 'local_bash', session_id: session });
      user([{ type: 'tool_result', tool_use_id: 'toolu_bg1', content: `Command running in background with ID: tbg1. Output is being written to: ${file}` }]);
      assistant([{ type: 'text', text: 'It is rendering in the background.' }]);
      result();
    } else if (/\blong\b/.test(text)) {
      // a long chat: 150 replies with Markdown and command output
      const md = Array.from({ length: 20 }, (_, k) => `- **Point ${k}**: some \`code\` and [a link](https://example.com/${k}) with more words to read`).join('\n');
      // every third one looked at a frame (a ~1 MB screenshot, as Claude's Read of a PNG returns it)
      for (let k = 0; k < 150; k++) {
        assistant([{ type: 'text', text: `## Step ${k}\n\n${md}` }, { type: 'tool_use', id: `toolu_l${k}`, name: k % 3 ? 'Bash' : 'Read', input: k % 3 ? { command: `vedit render ${k}`, description: `Render ${k}` } : { file_path: `frame-${k}.png` } }]);
        user([{ type: 'tool_result', tool_use_id: `toolu_l${k}`, content: k % 3 ? `frame ${k}\n`.repeat(400) : [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: noisePng(k) } }] }]);
      }
      result();
    } else if (/\bstream\b/.test(text)) {
      // a reply written word by word (what the panel redraws on)
      const id = `msg_stream_${Date.now()}`;
      out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: session });
      let k = 0, said = '';
      const tick = setInterval(() => {
        const w = `word${k} `;
        said += w;
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, session_id: session });
        if (++k >= 300) {
          clearInterval(tick);
          out({ type: 'assistant', message: { id, role: 'assistant', model: 'fake', content: [{ type: 'text', text: said }], usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: session });
          result();
        }
      }, 20);
    } else {
      assistant([{ type: 'text', text: 'Hello.' }]);
      result();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
