import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory.js';

// No database runs for these tests: vitest.config.ts points DATABASE_URL at a closed port.
// The "database up" path is covered by test/database.int.test.ts against real PostgreSQL.

describe('health endpoints (database unavailable)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/health (liveness)', () => {
    it('returns ok even when the database is down', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('does not advertise the server stack', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('is only served under the versioned prefix', async () => {
      await request(app.getHttpServer()).get('/health').expect(404);
    });
  });

  describe('GET /api/v1/health/ready (readiness)', () => {
    it('returns 503 when the database is down', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(res.body).toMatchObject({ status: 'error', checks: { database: 'down' } });
    });

    it('does not leak connection details or driver errors', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
      const body = JSON.stringify(res.body);
      for (const fragment of ['unreachable', '127.0.0.1', 'ECONNREFUSED', 'postgresql', 'stack']) {
        expect(body).not.toContain(fragment);
      }
    });
  });
});
