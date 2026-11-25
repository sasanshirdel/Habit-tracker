import type { RespClient } from './redis-resp.js';

/** Per-run key namespace, generated here only (never from input). Ends with `:`. */
export function throwawayKeyPrefix(): string {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `habit:it:${suffix}:`;
}

/** Deletes every key starting with `prefix` using SCAN (non-blocking, unlike KEYS). */
export async function deleteKeysWithPrefix(client: RespClient, prefix: string): Promise<number> {
  if (!prefix.startsWith('habit:it:')) {
    throw new Error(`Refusing to delete keys outside the integration namespace: ${prefix}`);
  }
  let cursor = '0';
  let deleted = 0;
  do {
    const reply = await client.command(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '500']);
    if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) {
      throw new Error('Unexpected SCAN reply');
    }
    cursor = String(reply[0]);
    const keys = reply[1].map(String);
    if (keys.length > 0) deleted += Number(await client.command(['DEL', ...keys]));
  } while (cursor !== '0');
  return deleted;
}
