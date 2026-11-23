import { describe, expect, it } from 'vitest';
import { encodeCommand, parseResp, RespError } from './integration/redis-resp.js';
import { throwawayKeyPrefix } from './integration/redis-keys.js';

// Unit tests for the integration harness' minimal RESP2 codec (no Redis needed).
const b = (s: string) => Buffer.from(s, 'utf8');

describe('RESP2 codec (integration test harness)', () => {
  it('encodes commands as arrays of bulk strings (byte lengths, not char lengths)', () => {
    expect(encodeCommand(['SET', 'k', 'سلام']).toString('utf8')).toBe(
      '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$8\r\nسلام\r\n',
    );
  });

  it('parses simple strings, errors, integers and nulls', () => {
    expect(parseResp(b('+PONG\r\n'))).toEqual({ value: 'PONG', length: 7 });
    expect(parseResp(b(':42\r\n'))).toEqual({ value: 42, length: 5 });
    expect(parseResp(b('$-1\r\n'))).toEqual({ value: null, length: 5 });
    const err = parseResp(b('-ERR boom\r\n'));
    expect(err?.value).toBeInstanceOf(RespError);
    expect((err?.value as RespError).message).toBe('ERR boom');
  });

  it('parses multi-byte bulk strings and nested arrays', () => {
    const bulk = b('$8\r\nسلام\r\n');
    expect(parseResp(bulk)).toEqual({ value: 'سلام', length: bulk.length });
    const arr = b('*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n');
    expect(parseResp(arr)).toEqual({ value: ['0', ['a', 'b']], length: arr.length });
  });

  it('returns undefined for incomplete replies (so the client waits for more data)', () => {
    expect(parseResp(b('+PON'))).toBeUndefined();
    expect(parseResp(b('$5\r\nhel'))).toBeUndefined();
    expect(parseResp(b('*2\r\n:1\r\n'))).toBeUndefined();
  });

  it('parses consecutive replies using the returned length', () => {
    const buf = b('+OK\r\n:7\r\n');
    const first = parseResp(buf);
    expect(first?.value).toBe('OK');
    expect(parseResp(buf, first?.length)?.value).toBe(7);
  });

  it('rejects malformed replies', () => {
    expect(() => parseResp(b('?what\r\n'))).toThrow(/Unsupported RESP type/);
    expect(() => parseResp(b('$abc\r\n'))).toThrow(/Malformed bulk length/);
  });

  it('generates isolated key prefixes inside the integration namespace', () => {
    const a = throwawayKeyPrefix();
    expect(a).toMatch(/^habit:it:[a-z0-9]+_[a-z0-9]+:$/);
    expect(throwawayKeyPrefix()).not.toBe(a);
  });
});
