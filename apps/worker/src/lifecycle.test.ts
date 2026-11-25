import { describe, expect, it, vi } from 'vitest';
import { errorName, installShutdownHandlers, type ProcessLike } from './lifecycle.js';

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  const exit = vi.fn<(code: number) => void>();
  const proc: ProcessLike & { exit: typeof exit } = {
    on: (event, listener) => listeners.set(event, listener),
    exit,
  };
  return { proc, emit: (signal: 'SIGTERM' | 'SIGINT') => listeners.get(signal)?.() };
}

const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('installShutdownHandlers', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'drains on %s and exits 0 only after shutdown completes',
    async (signal) => {
      let finish: () => void = () => {};
      const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      const { proc, emit } = fakeProcess();
      installShutdownHandlers(shutdown, proc, logger());

      emit(signal);
      expect(shutdown).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(proc.exit).not.toHaveBeenCalled(); // still draining

      finish();
      await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    },
  );

  it('exits 1 immediately on a second signal while draining', () => {
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { proc, emit } = fakeProcess();
    const log = logger();
    installShutdownHandlers(shutdown, proc, log);

    emit('SIGTERM');
    emit('SIGINT');
    expect(shutdown).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/again/));
  });

  it('exits 1 when shutdown fails, logging only the error code', async () => {
    const secret = Object.assign(new Error('redis://user:pw@10.0.0.5:6379 refused'), {
      code: 'ECONNREFUSED',
    });
    const { proc, emit } = fakeProcess();
    const log = logger();
    installShutdownHandlers(() => Promise.reject(secret), proc, log);

    emit('SIGTERM');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(1));
    expect(log.error).toHaveBeenCalledWith('Worker shutdown failed (ECONNREFUSED).');
  });
});

describe('errorName', () => {
  it('prefers a code, then the class name, never the message', () => {
    expect(errorName(Object.assign(new Error('pw=secret'), { code: 'E1' }))).toBe('E1');
    expect(errorName(new TypeError('pw=secret'))).toBe('TypeError');
    expect(errorName('pw=secret')).toBe('unknown');
  });
});
