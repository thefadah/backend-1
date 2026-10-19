import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSecurityPlugins, rateLimitCorsPreflight } from '../security';

describe('CORS & security headers (Issue #28)', () => {
  beforeEach(() => {
    process.env.CORS_ORIGINS = 'http://localhost:5173';
    process.env.CORS_CREDENTIALS = 'true';
  });

  it('emits CORS headers for an allowed origin', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    app.get('/ping', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['x-frame-options']?.toString().toLowerCase()).toContain('deny');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('handles preflight OPTIONS for allowed origins', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/users/profile',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });

    expect([204, 200]).toContain(res.statusCode);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rate-limits excessive preflight requests', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    app.addHook('onRequest', async (req, reply) => {
      // pin IP for inject-based tests
      Object.defineProperty(req, 'ip', { value: '203.0.113.10' });
      await rateLimitCorsPreflight(req, reply);
    });
    app.options('/x', async (_req, reply) => reply.code(204).send());
    await app.ready();

    let limited = false;
    for (let i = 0; i < 70; i++) {
      const res = await app.inject({ method: 'OPTIONS', url: '/x' });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('sets X-Content-Type-Options: nosniff on all responses (#251)', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    app.get('/api/test', async () => ({ status: 'ok' }));
    app.get('/api/error', async () => {
      throw new Error('boom');
    });
    await app.ready();

    const okRes = await app.inject({ method: 'GET', url: '/api/test' });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers['x-content-type-options']).toBe('nosniff');

    const notFoundRes = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.headers['x-content-type-options']).toBe('nosniff');

    const errorRes = await app.inject({ method: 'GET', url: '/api/error' });
    expect(errorRes.statusCode).toBe(500);
    expect(errorRes.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY by default and handles allowed embedding scenarios (#252)', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    app.get('/api/test', async () => ({ status: 'ok' }));
    app.get('/embed/widget', async () => ({ embedded: true }));
    await app.ready();

    // Default response: DENY
    const defaultRes = await app.inject({ method: 'GET', url: '/api/test' });
    expect(defaultRes.headers['x-frame-options']).toBe('DENY');

    // Allowed embedding scenario: /embed path
    const embedRes = await app.inject({ method: 'GET', url: '/embed/widget' });
    expect(embedRes.headers['x-frame-options']).toBe('SAMEORIGIN');

    // Allowed embedding scenario: x-allow-embed header
    const headerEmbedRes = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { 'x-allow-embed': 'true' },
    });
    expect(headerEmbedRes.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

