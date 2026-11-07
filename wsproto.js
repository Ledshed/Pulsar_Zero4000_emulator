'use strict';
/*
 * Minimal, defensive WebSocket (RFC 6455) server-side connection: text messages only, with hard limits.
 *
 *  - every client frame must be masked; RSV bits must be 0; unknown opcodes are rejected
 *  - control frames (close/ping/pong) must be ≤ 125 bytes and not fragmented
 *  - a message (one frame or several fragments) may be at most MAX_MESSAGE bytes and MAX_FRAGMENTS frames
 *  - data buffered while waiting for the rest of a frame is capped
 *  - at most RATE_MAX messages per second (a token bucket); a flood closes the connection
 * Any violation closes the connection with the matching status code (1002 protocol error, 1003 unsupported,
 * 1008 policy, 1009 too big).
 */
const crypto = require('crypto');

const MAX_MESSAGE = 64 * 1024;
const MAX_FRAGMENTS = 16;
const MAX_BUFFER = MAX_MESSAGE + 64;
const RATE_MAX = 400;      // messages per second, sustained
const RATE_BURST = 800;
const PARTIAL_TIMEOUT_MS = 10000; // a frame (or fragmented message) must be finished within this time

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  return Buffer.concat([head, payload]);
}

class WsConnection {
  constructor(sock, onText, onClose) {
    this.sock = sock;
    this.onText = onText;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frags = null;      // array of Buffers while a fragmented message is in progress
    this.fragBytes = 0;
    this.closed = false;
    this.tokens = RATE_BURST;
    this.lastRefill = Date.now();
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
  }

  finish() {
    clearTimeout(this.partialTimer);
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    this.onClose && this.onClose();
  }

  sendText(str) {
    if (this.closed || this.sock.destroyed) return;
    this.sock.write(encodeFrame(0x1, Buffer.from(str)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const r = Buffer.from(String(reason).slice(0, 100));
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this.sock.end(encodeFrame(0x8, p)); } catch (_) {}
    setTimeout(() => { try { this.sock.destroy(); } catch (_) {} }, 1000).unref();
  }

  // Close connections that start a frame / message and never finish it (slow-drip attacks).
  armPartialTimer() {
    const pending = this.buf.length > 0 || this.frags !== null;
    if (!pending) { clearTimeout(this.partialTimer); this.partialTimer = null; return; }
    if (!this.partialTimer) this.partialTimer = setTimeout(() => this.close(1008, 'incomplete message'), PARTIAL_TIMEOUT_MS);
  }

  onData(d) {
    if (this.closed) return;
    this.parse(d);
    if (!this.closed) this.armPartialTimer();
  }

  parse(d) {
    if (this.buf.length + d.length > MAX_BUFFER + 14) { this.close(1009, 'too big'); return; }
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (rsv) return this.close(1002, 'reserved bits');
      if (!masked) return this.close(1002, 'client frames must be masked');
      const control = op >= 0x8;
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(op)) return this.close(1002, 'bad opcode');
      if (control && (!fin || len > 125)) return this.close(1002, 'bad control frame');
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.close(1009, 'too big');
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return; // wait for the rest (bounded by MAX_BUFFER above)
      const mask = b.subarray(off, off + 4);
      const data = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { if (!this.sock.destroyed) this.sock.write(encodeFrame(0xa, data)); continue; }
      if (op === 0xa) continue;
      if (op === 0x2) return this.close(1003, 'text only');

      if (op === 0x1) {
        if (this.frags) return this.close(1002, 'new message inside a fragmented one');
        if (fin) { this.deliver(data); continue; }
        this.frags = [data]; this.fragBytes = len;
      } else { // continuation
        if (!this.frags) return this.close(1002, 'continuation without a start');
        this.frags.push(data); this.fragBytes += len;
        if (this.frags.length > MAX_FRAGMENTS) return this.close(1009, 'too many fragments');
        if (this.fragBytes > MAX_MESSAGE) return this.close(1009, 'too big');
        if (fin) { const msg = Buffer.concat(this.frags); this.frags = null; this.fragBytes = 0; this.deliver(msg); }
      }
    }
  }

  deliver(buf) {
    // token-bucket rate limit
    const now = Date.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + (now - this.lastRefill) * RATE_MAX / 1000);
    this.lastRefill = now;
    if (this.tokens < 1) return this.close(1008, 'too many messages');
    this.tokens -= 1;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return this.close(1007, 'invalid UTF-8'); }
    try { this.onText(text); } catch (e) { console.error('message handler error:', e.message); }
  }
}

module.exports = { WsConnection, acceptKey, encodeFrame, MAX_MESSAGE, MAX_FRAGMENTS, RATE_MAX };
