import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { normalizePassword } from '@habit/shared-validation';
import { ApiException } from '../../common/errors/api-exception.js';
import { PASSWORD_HASH_PREFIX } from './identity.constants.js';

/**
 * Password hashing with Argon2id (backlog P2-02, ADR-0018) on Node's built-in `crypto.argon2`
 * (Node ≥ 24.7, OpenSSL's implementation) — no third-party or native dependency.
 *
 * Stored format: the standard PHC string
 * `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>` (unpadded standard base64), the
 * same format the reference implementation and the common libraries write, so hashes stay portable
 * and every hash records the parameters it was made with (old hashes keep verifying after the
 * parameters change; {@link PasswordVerification.needsRehash} tells login to upgrade them).
 */

/**
 * OWASP Password Storage Cheat Sheet (checked 2026-11-26): Argon2id with m=19 MiB, t=2, p=1 is
 * one of the equivalent minimum configurations. ≈ 25–35 ms per hash on the arm64 dev sandbox (see
 * ADR-0018); raise memory/passes here when production hardware is known — existing hashes are
 * upgraded at their owner's next sign-in.
 */
export const ARGON2ID_PARAMS = {
  /** Memory cost in KiB (19 MiB). */
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  /** Random salt per hash (RFC 9106 recommends 16 bytes). */
  saltBytes: 16,
  /** Derived key length (RFC 9106 recommends 32 bytes for password hashing). */
  hashBytes: 32,
} as const;

/**
 * Bounds accepted when *reading* a stored hash. A hash outside them is treated as corrupt (never
 * matches) instead of being computed, so a tampered row cannot make the API allocate gigabytes.
 */
const STORED_LIMITS = {
  maxMemoryKiB: 1_048_576, // 1 GiB
  maxPasses: 16,
  maxParallelism: 16,
  minSaltBytes: 8,
  maxSaltBytes: 64,
  minHashBytes: 16,
  maxHashBytes: 64,
} as const;

/**
 * At most this many Argon2 computations run at once per process (each holds `memoryKiB` of RAM
 * and a libuv thread pool slot that file-system and DNS work also need). Further requests wait in
 * a bounded queue; beyond it the API answers 503 `SERVICE_UNAVAILABLE` rather than queueing
 * unbounded memory-hard work (hash-flooding DoS). The per-address `auth` rate limit (ADR-0011)
 * keeps a single client far below these numbers.
 */
export const HASHING_CONCURRENCY = 2;
export const HASHING_MAX_QUEUED = 64;

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,10}),t=(\d{1,10}),p=(\d{1,10})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface Argon2idHash {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

/** Parses a stored PHC string; `null` for anything that is not a sane Argon2id v19 hash. */
export function parseArgon2idHash(phc: string): Argon2idHash | null {
  const match = PHC_PATTERN.exec(phc);
  if (!match) return null;
  const [, m, t, p, saltB64, hashB64] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const memoryKiB = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  const salt = decodeBase64(saltB64);
  const hash = decodeBase64(hashB64);
  if (!salt || !hash) return null;
  if (
    parallelism < 1 ||
    parallelism > STORED_LIMITS.maxParallelism ||
    passes < 1 ||
    passes > STORED_LIMITS.maxPasses ||
    memoryKiB < 8 * parallelism ||
    memoryKiB > STORED_LIMITS.maxMemoryKiB ||
    salt.length < STORED_LIMITS.minSaltBytes ||
    salt.length > STORED_LIMITS.maxSaltBytes ||
    hash.length < STORED_LIMITS.minHashBytes ||
    hash.length > STORED_LIMITS.maxHashBytes
  ) {
    return null;
  }
  return { memoryKiB, passes, parallelism, salt, hash };
}

/** Formats a PHC string (unpadded standard base64, as the reference implementation writes). */
export function formatArgon2idHash(value: Argon2idHash): string {
  return (
    `${PASSWORD_HASH_PREFIX}m=${value.memoryKiB},t=${value.passes},p=${value.parallelism}` +
    `$${b64(value.salt)}$${b64(value.hash)}`
  );
}

function b64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** Strict unpadded base64 decode: rejects encodings that do not round-trip. */
function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, 'base64');
  return b64(bytes) === value ? bytes : null;
}

function derive(
  password: string,
  salt: Buffer,
  params: { memoryKiB: number; passes: number; parallelism: number; hashBytes: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: params.memoryKiB,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: params.hashBytes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Thrown when the hashing queue is full; rendered as 503 `SERVICE_UNAVAILABLE`. */
export class PasswordHashingBusyError extends ApiException {
  constructor() {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'SERVICE_UNAVAILABLE',
      'Service temporarily unavailable.',
    );
  }
}

/** Minimal FIFO semaphore with a bounded wait queue. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueued) throw new PasswordHashingBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter (active count unchanged), else release it.
      if (next) next();
      else this.active--;
    }
  }
}

export interface PasswordVerification {
  /** The password matches the stored hash. */
  readonly valid: boolean;
  /** The hash was made with other parameters than {@link ARGON2ID_PARAMS}; re-hash on success. */
  readonly needsRehash: boolean;
}

/**
 * Hashes and verifies passwords. Inputs are NFKC-normalised here as well as at the API edge
 * (idempotent), so no caller can hash a non-canonical form by mistake.
 *
 * Verification does the same Argon2id work whether or not an account exists: callers pass
 * `null` for a missing account (or one without a password) and the password is checked against a
 * dummy hash with the current parameters, so response time does not reveal which addresses are
 * registered.
 */
@Injectable()
export class PasswordHasher implements OnModuleInit {
  private readonly limiter = new Semaphore(HASHING_CONCURRENCY, HASHING_MAX_QUEUED);
  private dummyHash: Promise<string> | undefined;

  /** Makes the dummy hash at startup, so the first unknown-address login is not slower. */
  async onModuleInit(): Promise<void> {
    await this.getDummyHash();
  }

  /** Hashes a password with the current parameters and a fresh random salt. */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(ARGON2ID_PARAMS.saltBytes);
    const hash = await this.limiter.run(() =>
      derive(normalizePassword(password), salt, ARGON2ID_PARAMS),
    );
    return formatArgon2idHash({
      memoryKiB: ARGON2ID_PARAMS.memoryKiB,
      passes: ARGON2ID_PARAMS.passes,
      parallelism: ARGON2ID_PARAMS.parallelism,
      salt,
      hash,
    });
  }

  /**
   * Checks `password` against `stored` (a PHC string), or against the dummy hash when `stored`
   * is `null`. A corrupt stored hash never matches; it is not computed if its parameters are out
   * of bounds.
   */
  async verify(password: string, stored: string | null): Promise<PasswordVerification> {
    const phc = stored ?? (await this.getDummyHash());
    const parsed = parseArgon2idHash(phc);
    if (!parsed) return { valid: false, needsRehash: false };
    const candidate = await this.limiter.run(() =>
      derive(normalizePassword(password), parsed.salt, {
        memoryKiB: parsed.memoryKiB,
        passes: parsed.passes,
        parallelism: parsed.parallelism,
        hashBytes: parsed.hash.length,
      }),
    );
    const matches = timingSafeEqual(candidate, parsed.hash);
    return {
      valid: stored !== null && matches,
      needsRehash:
        parsed.memoryKiB !== ARGON2ID_PARAMS.memoryKiB ||
        parsed.passes !== ARGON2ID_PARAMS.passes ||
        parsed.parallelism !== ARGON2ID_PARAMS.parallelism ||
        parsed.salt.length !== ARGON2ID_PARAMS.saltBytes ||
        parsed.hash.length !== ARGON2ID_PARAMS.hashBytes,
    };
  }

  /** A hash of a random, discarded password, made once per process with the current parameters. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }
}
