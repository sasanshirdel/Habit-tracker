import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCONNECT_TIMEOUT_MS,
  drainWorkers,
  type DrainableWorker,
} from './worker-host.service.js';

const logger = () => ({ log: vi.fn(), warn: vi.fn() });

function fakeWorker(closeAfterMs: number | 'never' | 'reject'): DrainableWorker & {
  close: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'system',
    close: vi.fn(() => {
      if (closeAfterMs === 'never') return new Promise<void>(() => {});
      if (closeAfterMs === 'reject') return Promise.reject(new Error('boom'));
      return new Promise<void>((resolve) => setTimeout(resolve, closeAfterMs));
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('drainWorkers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for in-flight jobs and does not disconnect when they finish in time', async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(300), fakeWorker(800)];
    const log = logger();
    const result = drainWorkers(workers, 1_000, log);
    await vi.advanceTimersByTimeAsync(799);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting for the slower worker
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('drained');
    for (const w of workers) {
      expect(w.close).toHaveBeenCalledOnce();
      expect(w.disconnect).not.toHaveBeenCalled();
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('disconnects every worker once the timeout passes', async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(100), fakeWorker('never')];
    const log = logger();
    const result = drainWorkers(workers, 1_000, log);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('timed_out');
    for (const w of workers) expect(w.disconnect).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/did not drain within 1000 ms/));
  });

  it('still resolves when disconnecting hangs (Redis unreachable)', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker('never');
    worker.disconnect.mockReturnValue(new Promise<void>(() => {}));
    const log = logger();
    const result = drainWorkers([worker], 1_000, log);
    await vi.advanceTimersByTimeAsync(1_000 + DISCONNECT_TIMEOUT_MS);
    await expect(result).resolves.toBe('timed_out');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/did not close within/));
  });

  it('disconnects when closing fails', async () => {
    const workers = [fakeWorker('reject')];
    const log = logger();
    await expect(drainWorkers(workers, 1_000, log)).resolves.toBe('timed_out');
    expect(workers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/shutdown failed \(Error\)/));
  });

  it('is a no-op without workers', async () => {
    await expect(drainWorkers([], 1_000, logger())).resolves.toBe('drained');
  });
});
