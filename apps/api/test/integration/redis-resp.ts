import { connect, type Socket } from 'node:net';

// Minimal RESP2 client used ONLY by the integration test harness to verify the Redis service
// (backlog P1-02). It deliberately avoids adding a Redis client dependency before P1-03, which
// introduces ioredis/BullMQ (ADR-0001) for application code. Not for production use: no TLS,
// no pipelining guarantees beyond one-command-at-a-time, no reconnects.

export type RespValue = string | number | null | RespValue[] | RespError;

export class RespError extends Error {
  override readonly name = 'RespError';
}

/** Result of parsing a buffer: the value plus bytes consumed, or `undefined` if incomplete. */
export type ParseResult = { value: RespValue; length: number } | undefined;

/**
 * Parses one RESP2 reply starting at `offset`. Returns `undefined` when the buffer does not yet
 * hold a complete reply. Throws on a malformed reply.
 */
export function parseResp(buf: Buffer, offset = 0): ParseResult {
  if (offset >= buf.length) return undefined;
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) return undefined;
  const type = String.fromCharCode(buf[offset] as number);
  const line = buf.toString('utf8', offset + 1, lineEnd);
  const headerLength = lineEnd + 2 - offset;

  switch (type) {
    case '+':
      return { value: line, length: headerLength };
    case '-':
      return { value: new RespError(line), length: headerLength };
    case ':':
      return { value: Number(line), length: headerLength };
    case '$': {
      const size = Number(line);
      if (!Number.isInteger(size) || size < -1) throw new Error(`Malformed bulk length: ${line}`);
      if (size === -1) return { value: null, length: headerLength };
      const start = lineEnd + 2;
      if (buf.length < start + size + 2) return undefined;
      return { value: buf.toString('utf8', start, start + size), length: headerLength + size + 2 };
    }
    case '*': {
      const count = Number(line);
      if (!Number.isInteger(count) || count < -1)
        throw new Error(`Malformed array length: ${line}`);
      if (count === -1) return { value: null, length: headerLength };
      const items: RespValue[] = [];
      let consumed = headerLength;
      for (let i = 0; i < count; i += 1) {
        const item = parseResp(buf, offset + consumed);
        if (!item) return undefined;
        items.push(item.value);
        consumed += item.length;
      }
      return { value: items, length: consumed };
    }
    default:
      throw new Error(`Unsupported RESP type byte: ${JSON.stringify(type)}`);
  }
}

/** Encodes a command as a RESP2 array of bulk strings. */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

export class RespClient {
  private buffer = Buffer.alloc(0);
  private readonly pending: { resolve: (v: RespValue) => void; reject: (e: Error) => void }[] = [];

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => this.failAll(new Error('Redis connection closed')));
  }

  /** Connects to a `redis://[user:pass@]host[:port][/db]` URL, authenticating/selecting as needed. */
  static async connect(redisUrl: string, timeoutMs = 5_000): Promise<RespClient> {
    const url = new URL(redisUrl);
    if (url.protocol !== 'redis:') {
      throw new Error(`Only redis:// URLs are supported by the test harness (got ${url.protocol})`);
    }
    const port = url.port ? Number(url.port) : 6379;
    const host = url.hostname || '127.0.0.1';
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Timed out connecting to Redis at ${host}:${port}`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const client = new RespClient(socket);
    const password = decodeURIComponent(url.password);
    if (password) {
      const user = decodeURIComponent(url.username);
      await client.commandOk(user ? ['AUTH', user, password] : ['AUTH', password]);
    }
    const db = url.pathname.replace(/^\//, '');
    if (db) await client.commandOk(['SELECT', db]);
    return client;
  }

  /** Sends one command and resolves with its reply (a Redis error reply rejects). */
  command(args: readonly string[]): Promise<RespValue> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        resolve: (v) => (v instanceof RespError ? reject(v) : resolve(v)),
        reject,
      });
      this.socket.write(encodeCommand(args));
    });
  }

  private async commandOk(args: readonly string[]): Promise<void> {
    const reply = await this.command(args);
    if (reply !== 'OK') throw new Error(`Unexpected reply to ${args[0]}: ${String(reply)}`);
  }

  async quit(): Promise<void> {
    try {
      await this.command(['QUIT']);
    } catch {
      // Connection already gone — nothing to do.
    }
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const parsed = parseResp(this.buffer);
        if (!parsed) return;
        this.buffer = this.buffer.subarray(parsed.length);
        this.pending.shift()?.resolve(parsed.value);
      }
    } catch (err) {
      this.failAll(err as Error);
      this.socket.destroy();
    }
  }

  private failAll(err: Error): void {
    while (this.pending.length > 0) this.pending.shift()?.reject(err);
  }
}
