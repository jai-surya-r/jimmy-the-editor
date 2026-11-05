// REST + WebSocket client.
import { noteRequest, noteMessage } from './perf.js';

export const clientId = (crypto.randomUUID && crypto.randomUUID()) || `c${Math.random().toString(36).slice(2)}`;

export async function api(method, url, body) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  noteRequest(method, url, performance.now() - t0);
  if (!res.ok && res.status !== 409 && res.status !== 423) {
    throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  }
  return { status: res.status, ...(data || {}) };
}
export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);

// Upload a File to the project with progress callback (XHR has upload progress, fetch doesn't).
export function uploadFile(projectId, file, { folder, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ name: file.name });
    if (folder) qs.set('folder', folder);
    xhr.open('POST', `/api/p/${projectId}/upload?${qs}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

// One app-wide socket. Handlers receive every message; subscriptions survive reconnects.
class Socket {
  constructor() {
    this.handlers = new Set();
    this.subs = new Set();
    this.ws = null;
    this.connected = false;
    this.statusHandlers = new Set();
  }
  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      ws.send(JSON.stringify({ type: 'hello', clientId }));
      for (const id of this.subs) ws.send(JSON.stringify({ type: 'subscribe', projectId: id }));
      for (const fn of this.statusHandlers) fn(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const t = performance.now();
      for (const fn of this.handlers) fn(msg);
      noteMessage(msg.type, performance.now() - t, e.data.length);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) for (const fn of this.statusHandlers) fn(false);
      setTimeout(() => this.connect(), 1500);
    };
  }
  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  subscribe(projectId) {
    this.subs.add(projectId);
    this.send({ type: 'subscribe', projectId });
  }
  unsubscribe(projectId) {
    this.subs.delete(projectId);
    this.send({ type: 'unsubscribe', projectId });
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onStatus(fn) { this.statusHandlers.add(fn); return () => this.statusHandlers.delete(fn); }
}
export const socket = new Socket();

export const mediaUrl = (projectId, mediaId, kind, bust = '') => `/media/${projectId}/${mediaId}/${kind}${bust ? `?k=${bust}` : ''}`;
export const projectFileUrl = (projectId, rel) => `/api/p/${projectId}/file?path=${encodeURIComponent(rel)}`;
