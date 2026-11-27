import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../errors/api-exception.js';
import { Public, foundOr404, ownedBy, routeAuthPolicy } from './auth.metadata.js';

// Backlog P2-03 (ADR-0019): route markers and owner-scoping helpers.
describe('routeAuthPolicy', () => {
  @Controller('plain')
  class Plain {
    @Get() a(): void {}
    @Public() @Get('b') b(): void {}
    @Public({ session: 'optional' }) @Get('c') c(): void {}
  }
  @Public()
  @Controller('open')
  class Open {
    @Get() a(): void {}
    @Public({ session: 'optional' }) @Get('b') b(): void {}
  }
  const reflector = new Reflector();
  const policy = (cls: { prototype: object }, name: string) =>
    routeAuthPolicy(reflector, (cls.prototype as Record<string, () => void>)[name]!, cls as never);

  it('defaults to required (deny by default)', () => {
    expect(policy(Plain, 'a')).toBe('required');
  });
  it('honours route markers, the handler winning over the controller', () => {
    expect(policy(Plain, 'b')).toBe('public');
    expect(policy(Plain, 'c')).toBe('optional');
    expect(policy(Open, 'a')).toBe('public');
    expect(policy(Open, 'b')).toBe('optional');
  });
});

describe('owner scoping', () => {
  const me = { userId: 'u-1', sessionId: 's-1' };
  it('ownedBy scopes a query to the signed-in user', () => {
    expect(ownedBy(me)).toEqual({ userId: 'u-1' });
  });
  it('foundOr404 hides missing and foreign rows behind the same 404', () => {
    expect(foundOr404({ id: 1 })).toEqual({ id: 1 });
    expect(foundOr404(0)).toBe(0);
    for (const missing of [null, undefined]) {
      try {
        foundOr404(missing);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiException);
        expect((error as ApiException).code).toBe('NOT_FOUND');
        expect((error as ApiException).getStatus()).toBe(404);
      }
    }
  });
});
