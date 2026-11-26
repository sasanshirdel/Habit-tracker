import { signInCredentialsSchema, signUpCredentialsSchema } from '@habit/shared-validation';
import { describe, expect, it } from 'vitest';
import { schemaResolver } from './schema-resolver';

type Form = { email: string; password: string };
const options = { fields: {}, shouldUseNativeValidation: false } as const;

describe('schemaResolver (P2-09)', () => {
  it('returns the schema output on success', async () => {
    const resolve = schemaResolver<Form, Form>(signInCredentialsSchema);
    const result = await resolve(
      { email: ' Sara@Example.com ', password: 'x' },
      undefined,
      options,
    );
    expect(result).toEqual({ values: { email: 'sara@example.com', password: 'x' }, errors: {} });
  });

  it('maps the first issue per field to its code, never the password', async () => {
    const resolve = schemaResolver<Form, Form>(signUpCredentialsSchema);
    const result = await resolve({ email: 'nope', password: 'hunter2' }, undefined, options);
    expect(result.values).toEqual({});
    expect(result.errors).toEqual({
      email: { type: 'invalid_format', message: 'invalid_format' },
      password: { type: 'too_small', message: 'too_small' },
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
