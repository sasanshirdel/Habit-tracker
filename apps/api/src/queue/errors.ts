/**
 * Queue errors carry a stable `code` (ARCHITECTURE §5). The global exception filter (backlog
 * P1-05) maps them to the API error envelope; messages never contain payload values or
 * connection details.
 */
export class QueueUnavailableError extends Error {
  override readonly name = 'QueueUnavailableError';
  readonly code = 'QUEUE_UNAVAILABLE';

  constructor(reason: 'not_connected' | 'timeout') {
    super(`Queue is unavailable (${reason}).`);
  }
}

export class InvalidJobPayloadError extends Error {
  override readonly name = 'InvalidJobPayloadError';
  readonly code = 'INVALID_JOB_PAYLOAD';

  /** `fields` lists the offending paths only — never the rejected values. */
  constructor(
    readonly jobName: string,
    readonly fields: string[],
  ) {
    super(`Invalid payload for job "${jobName}" (fields: ${fields.join(', ') || '(root)'}).`);
  }
}

export class InvalidJobIdError extends Error {
  override readonly name = 'InvalidJobIdError';
  readonly code = 'INVALID_JOB_ID';

  constructor() {
    super('Invalid job id (1-128 chars of A-Z a-z 0-9 _ -, not purely numeric).');
  }
}
