import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance, FastifyServerOptions, RouteOptions } from 'fastify';
import jwt from 'jsonwebtoken';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyRoute, registerRateLimiting, RateLimitingOptions } from '../rateLimit';

// These tests exercise rate-limit bucketing, not database-backed JWT revocation.
vi.mock('../../utils/token-blacklist', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  isUserAuthVersionCurrent: vi.fn().mockResolvedValue(true),
}));

import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { globalErrorHandler } from '../../middleware/error-handler';
import { config } from '../../config/env';
import {
  MONITORING_PATHS,
  RATE_LIMIT_EXEMPTIONS,
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_RULES,
  RateLimitClass,
  RateLimitPolicy,
  parseTrustProxy,
  routeMatches,
} from '../../config/rate-limit';

// Small, distinct limits so each class is distinguishable in a test.
const POLICIES: Record<RateLimitClass, RateLimitPolicy> = {
  public: { max: 3, timeWindowMs: 60_000 },
  authenticated: { max: 5, timeWindowMs: 60_000 },
  sensitive: { max: 2, timeWindowMs: 60_000 },
  walletNonce: { max: 2, timeWindowMs: 3_600_000 },
  walletVerify: { max: 3, timeWindowMs: 3_600_000 },
};

const token = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@example.com`, role: 'user' }, config.JWT_SECRET);

const bearer = (userId: string) => ({ authorization: `Bearer ${token(userId)}` });

/** Builds a route descriptor for the classifier, without registering it. */
const route = (method: string | string[], url: string, extra: Partial<RouteOptions> = {}) =>
  ({ method, url, handler: async () => ({}), ...extra }) as RouteOptions;

/** The `src` directory of this package. */
const SRC_DIR = path.resolve(__dirname, '../..');

/** Source files under `dir`, excluding tests. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

let app: FastifyInstance;

async function buildApp(
  options: Partial<RateLimitingOptions> = {},
  serverOptions: FastifyServerOptions = {}
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false, ...serverOptions });
  instance.setErrorHandler(globalErrorHandler);

  await registerRateLimiting(instance, {
    enabled: true,
    store: 'memory',
    policies: POLICIES,
    rules: [{ method: 'POST', url: '/auth/login', class: 'sensitive' }],
    exemptions: [{ method: 'GET', url: '/health' }],
    ...options,
  });

  const ok = async () => ({ ok: true });
  instance.get('/health', ok);
  instance.get('/public', ok);
  instance.get('/other-public', ok);
  instance.get('/private', { preHandler: authMiddleware }, ok);
  instance.post('/auth/login', ok);

  await instance.ready();
  return instance;
}

/**
 * Builds an app with the real central exemptions, so the monitoring
 * endpoints are registered exactly as they are in production.
 */
async function buildMonitoringApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setErrorHandler(globalErrorHandler);

  await registerRateLimiting(instance, {
    enabled: true,
    store: 'memory',
    policies: POLICIES,
    rules: [{ method: 'POST', url: '/auth/login', class: 'sensitive' }],
    exemptions: RATE_LIMIT_EXEMPTIONS,
  });

  const ok = async () => ({ ok: true });
  instance.get(MONITORING_PATHS.health, ok);
  instance.get(MONITORING_PATHS.readiness, ok);
  instance.get(MONITORING_PATHS.metrics, ok);
  instance.get(MONITORING_PATHS.metricsJson, ok);
  instance.get('/public', ok);

  await instance.ready();
  return instance;
}

async function hit(
  url: string,
  times: number,
  opts: { method?: 'GET' | 'POST'; headers?: Record<string, string>; remoteAddress?: string } = {}
) {
  const responses = [];
  for (let i = 0; i < times; i++) {
    responses.push(
      await app.inject({
        method: opts.method ?? 'GET',
        url,
        headers: opts.headers,
        remoteAddress: opts.remoteAddress,
      })
    );
  }
  return responses;
}

afterEach(async () => {
  await app?.close();
});

describe('rate limiting middleware', () => {
  it('lets requests within the limit through with rate-limit headers', async () => {
    app = await buildApp();
    const responses = await hit('/public', 3);

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.headers['x-ratelimit-remaining'])).toEqual(['2', '1', '0']);
    for (const res of responses) {
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
      expect(res.json()).toEqual({ ok: true });
    }
  });

  it('returns 429 with rate-limit metadata once the limit is exceeded', async () => {
    app = await buildApp();
    await hit('/public', 3);
    const [blocked] = await hit('/public', 1);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    const reset = Number(blocked.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
    expect(Number(blocked.headers['retry-after'])).toBe(reset);

    const body = blocked.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error.details).toMatchObject({
      policy: 'public',
      limit: 3,
      windowMs: 60_000,
      retryAfterSeconds: reset,
    });
  });

  it('localizes the 429 message through the global error handler', async () => {
    app = await buildApp();
    await hit('/public', 3);
    const [blocked] = await hit('/public', 1, { headers: { 'accept-language': 'es' } });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.message).toBe(
      'Demasiadas solicitudes, inténtalo de nuevo más tarde'
    );
  });

  it('allows requests again once the window has elapsed', async () => {
    app = await buildApp({
      policies: { ...POLICIES, public: { max: 1, timeWindowMs: 200 } },
    });

    expect((await hit('/public', 2)).map((r) => r.statusCode)).toEqual([200, 429]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await hit('/public', 1))[0].statusCode).toBe(200);
  });

  it('never rate-limits exempt routes, even under heavy load', async () => {
    app = await buildApp();
    const responses = await hit('/health', 500);

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // Bypassed entirely: no counter, so no rate-limit headers at all.
    for (const res of responses) {
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    }

    // The auto-generated HEAD route for an exempt GET is exempt too.
    const head = await app.inject({ method: 'HEAD', url: '/health' });
    expect(head.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('keeps exempt routes available while the same client is limited elsewhere', async () => {
    app = await buildApp();
    await hit('/public', 4);

    const [health] = await hit('/health', 1);
    expect(health.statusCode).toBe(200);
  });

  it('enforces a distinct limit for each route class', async () => {
    app = await buildApp();
    const user = bearer('user-1');

    const publicRes = await hit('/public', 4);
    const privateRes = await hit('/private', 6, { headers: user });
    const sensitiveRes = await hit('/auth/login', 3, { method: 'POST' });

    expect(publicRes.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
    expect(privateRes.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 429]);
    expect(sensitiveRes.map((r) => r.statusCode)).toEqual([200, 200, 429]);

    expect(publicRes[0].headers['x-ratelimit-limit']).toBe('3');
    expect(privateRes[0].headers['x-ratelimit-limit']).toBe('5');
    expect(sensitiveRes[0].headers['x-ratelimit-limit']).toBe('2');

    expect(publicRes[3].json().error.details.policy).toBe('public');
    expect(privateRes[5].json().error.details.policy).toBe('authenticated');
    expect(sensitiveRes[2].json().error.details.policy).toBe('sensitive');
  });

  it('does not share one counter across routes', async () => {
    app = await buildApp();
    await hit('/auth/login', 3, { method: 'POST' });

    // Exhausting the sensitive route leaves public routes untouched, and two
    // routes of the same class keep separate counters.
    await hit('/public', 3);
    const [other] = await hit('/other-public', 1);
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('counts authenticated requests per user, not per IP', async () => {
    app = await buildApp();
    const alice = await hit('/private', 6, { headers: bearer('alice') });
    const bob = await hit('/private', 1, { headers: bearer('bob') });

    expect(alice[5].statusCode).toBe(429);
    // Same IP as alice, but a different user: separate bucket.
    expect(bob[0].statusCode).toBe(200);
    expect(bob[0].headers['x-ratelimit-remaining']).toBe('4');
  });

  it('follows the user across IPs', async () => {
    app = await buildApp();
    await hit('/public', 3, { headers: bearer('carol'), remoteAddress: '10.0.0.1' });
    const [fromNewIp] = await hit('/public', 1, {
      headers: bearer('carol'),
      remoteAddress: '10.0.0.2',
    });
    expect(fromNewIp.statusCode).toBe(429);
  });

  it('falls back to the IP when the token is invalid', async () => {
    app = await buildApp();
    const forged = jwt.sign({ userId: 'victim' }, 'not-the-secret');
    await hit('/public', 3, { headers: { authorization: `Bearer ${forged}` } });

    // A forged token cannot claim a user bucket; it shares the IP bucket.
    const [anonymous] = await hit('/public', 1);
    expect(anonymous.statusCode).toBe(429);
    const [victim] = await hit('/public', 1, { headers: bearer('victim') });
    expect(victim.statusCode).toBe(200);
  });

  it('rejects routes that configure their own limit inline', async () => {
    app = Fastify({ logger: false });
    await registerRateLimiting(app, { enabled: true, store: 'memory', policies: POLICIES });

    expect(() =>
      app.get('/inline', { config: { rateLimit: { max: 1 } } }, async () => ({}))
    ).toThrow(/assigned centrally/);
  });

  it('attaches nothing when disabled', async () => {
    app = await buildApp({ enabled: false });
    const responses = await hit('/public', 10);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses[0].headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('client IP behind a reverse proxy', () => {
  const PROXY = '10.0.0.10';

  it('buckets clients by the forwarded address when the proxy is trusted', async () => {
    app = await buildApp({}, { trustProxy: PROXY });

    const a = await hit('/public', 4, {
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const [b] = await hit('/public', 1, {
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(a[3].statusCode).toBe(429);
    // Same proxy, different real client: not lumped together.
    expect(b.statusCode).toBe(200);
  });

  it('uses the right-most untrusted hop, so clients cannot spoof their IP', async () => {
    app = await buildApp({}, { trustProxy: PROXY });

    // The client prepends fake addresses; the proxy appends the real one.
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/public',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` },
      });
      expect(res.statusCode).toBe(i < 3 ? 200 : 429);
    }
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    app = await buildApp();

    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(
        await app.inject({
          method: 'GET',
          url: '/public',
          remoteAddress: '203.0.113.50',
          headers: { 'x-forwarded-for': `198.51.100.${i}` },
        })
      );
    }
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
  });
});

describe('monitoring endpoints', () => {
  const MONITORING_URLS = Object.values(MONITORING_PATHS);

  it('classifies the monitoring endpoints as exempt in the central config', () => {
    const classify = (r: RouteOptions) =>
      classifyRoute(r, RATE_LIMIT_POLICIES, RATE_LIMIT_RULES, RATE_LIMIT_EXEMPTIONS);

    for (const url of MONITORING_URLS) {
      expect(classify(route('GET', url))).toBe('exempt');
    }
    // Fastify auto-registers HEAD for every GET; the probe must be exempt too.
    expect(classify(route('HEAD', MONITORING_PATHS.metrics))).toBe('exempt');
    expect(classify(route('HEAD', MONITORING_PATHS.metricsJson))).toBe('exempt');
  });

  it('never throttles monitoring traffic, however hard it is scraped', async () => {
    app = await buildMonitoringApp();

    for (const url of MONITORING_URLS) {
      const responses = await hit(url, 100);

      expect(responses.map((r) => r.statusCode)).toEqual(responses.map(() => 200));
      // Skipped entirely: no counter, so no rate-limit headers at all.
      for (const res of responses) {
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
        expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
      }
    }
  });

  it('exempts monitoring traffic coming from any client IP', async () => {
    app = await buildMonitoringApp();

    // A load balancer or a Prometheus replica may reach the API from any
    // address; none of them may be throttled by the probe.
    for (const url of MONITORING_URLS) {
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: 'GET',
          url,
          remoteAddress: `10.0.${i}.7`,
        });
        expect(res.statusCode).toBe(200);
      }

      // The exemption is not per-IP: one address polling in a tight loop is
      // exempt as well.
      const repeated = await hit(url, 20, { remoteAddress: '203.0.113.1' });
      expect(repeated.map((r) => r.statusCode)).toEqual(repeated.map(() => 200));
    }
  });

  it('does not consume the rate limit quota of a user route', async () => {
    app = await buildMonitoringApp();

    // Monitoring traffic between user requests must not eat the user's quota.
    await hit('/metrics', 50);
    await hit('/health', 50);

    const responses = await hit('/public', 3);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses[2].headers['x-ratelimit-remaining']).toBe('0');

    const [blocked] = await hit('/public', 1);
    expect(blocked.statusCode).toBe(429);
  });

  it('does not let monitoring traffic from one IP consume another client quota', async () => {
    app = await buildMonitoringApp();

    await app.inject({ method: 'GET', url: '/metrics', remoteAddress: '10.0.0.1' });

    // A user behind another address still gets the full quota.
    const responses = await hit('/public', 3, { remoteAddress: '203.0.113.9' });
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
  });

  it('keeps user routes limited while the monitoring endpoints stay available', async () => {
    app = await buildMonitoringApp();

    await hit('/public', 3);
    const [blocked] = await hit('/public', 1);
    expect(blocked.statusCode).toBe(429);

    // The limiter rejects the user request, never the probe.
    const [metrics] = await hit('/metrics', 1);
    expect(metrics.statusCode).toBe(200);
  });

  it('exempts every monitoring path declared in the central config', () => {
    // The exemption list is built from MONITORING_PATHS, so a path that is
    // served but not exempted would silently fall back to the default class.
    for (const probePath of Object.values(MONITORING_PATHS)) {
      expect(
        RATE_LIMIT_EXEMPTIONS.some((m) => routeMatches(m, 'GET', probePath)),
        `${probePath} is not rate-limit exempt`
      ).toBe(true);
    }
  });

  it('exempts every path the deployment probes', () => {
    // The probe paths are read from the deployment manifests, so the
    // exemption list cannot drift away from what the platform actually
    // calls: a 429 on a liveness probe restarts the pod, and a 429 on a
    // scrape raises a false "backend unavailable" alert.
    const infraDir = path.resolve(__dirname, '../../../infra');
    const manifests = [
      path.join(infraDir, 'kubernetes/rollout.yaml'),
      path.join(infraDir, 'kubernetes/servicemonitor.yaml'),
      path.join(infraDir, 'monitoring/prometheus.yml'),
    ];

    const probed = new Set<string>();
    for (const manifest of manifests) {
      const content = readFileSync(manifest, 'utf8');
      for (const match of content.matchAll(/^\s*(?:path|metrics_path):\s*(\/\S+)\s*$/gm)) {
        probed.add(match[1]);
      }
    }

    // Guard against a manifest change that silently breaks the parsing.
    expect(probed.size).toBeGreaterThan(0);

    for (const probePath of probed) {
      expect(
        RATE_LIMIT_EXEMPTIONS.some((m) => routeMatches(m, 'GET', probePath)),
        `${probePath} is probed by the deployment but is not rate-limit exempt`
      ).toBe(true);
    }
  });

  it('registers the health probe under the path that is exempt', async () => {
    // The health route is registered with the same constant the exemption
    // list is built from, so the served path and the exempt path cannot
    // disagree. Fastify rejects a path that does not start with a slash.
    const instance = Fastify({ logger: false });
    instance.get(MONITORING_PATHS.health, async () => ({ ok: true }));
    await instance.ready();

    const res = await instance.inject({ method: 'GET', url: MONITORING_PATHS.health });
    expect(res.statusCode).toBe(200);
    expect(classifyRoute(route('GET', MONITORING_PATHS.health))).toBe('exempt');
  });

  it('serves the health probe under the path that is exempt', () => {
    // The route in src/index.ts and the exemption list must name the same
    // path. Before this fix the route was registered as 'health', without a
    // leading slash: Fastify throws ("The first character of a path should be
    // `/` or `*`") while the route is registered, so the API never booted
    // and the probe was never served at all.
    const indexSource = readFileSync(path.resolve(SRC_DIR, 'index.ts'), 'utf8');

    expect(indexSource).toContain('MONITORING_PATHS.health');
    expect(indexSource).not.toMatch(/\bapp\.get\(\s*'health'/);
  });

  it('declares every monitoring path with a leading slash', () => {
    for (const [name, probePath] of Object.entries(MONITORING_PATHS)) {
      expect(probePath.startsWith('/'), `${name} must start with a slash`).toBe(true);
    }
  });

  it('registers every route under a path that starts with a slash', () => {
    // A path without a leading slash makes Fastify throw while the route is
    // registered, so a single bad path stops the whole API from booting.
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(
        /\bapp\.(get|post|put|patch|delete|head|options)\(\s*'([^']*)'/g
      )) {
        if (!match[2].startsWith('/')) {
          offenders.push(`${path.relative(SRC_DIR, file)}: app.${match[1]}('${match[2]}')`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('route classification', () => {
  it('classifies the real application routes from the central config', () => {
    const classify = (r: RouteOptions) =>
      classifyRoute(r, RATE_LIMIT_POLICIES, RATE_LIMIT_RULES, RATE_LIMIT_EXEMPTIONS);

    expect(classify(route('GET', '/health'))).toBe('exempt');
    expect(classify(route('HEAD', '/readiness'))).toBe('exempt');
    expect(classify(route('OPTIONS', '/*'))).toBe('exempt');
    expect(classify(route('POST', '/api/v1/auth/login'))).toBe('sensitive');
    expect(classify(route('POST', '/api/v1/auth/password-reset'))).toBe('sensitive');
    expect(classify(route('POST', '/api/v1/auth/password-reset/confirm'))).toBe('sensitive');
    expect(classify(route('POST', '/api/v1/transactions/tip', { preHandler: [authMiddleware] }))).toBe(
      'sensitive'
    );
    expect(classify(route('POST', '/api/v1/jobs/export', { preHandler: authMiddleware }))).toBe(
      'sensitive'
    );
    expect(classify(route('GET', '/api/v1/users/profile', { preHandler: authMiddleware }))).toBe(
      'authenticated'
    );
    expect(classify(route('GET', '/api/v1/admin/moderation', { preHandler: requireAdmin }))).toBe(
      'authenticated'
    );
    expect(classify(route('GET', '/api/v1/creators/:id'))).toBe('public');
  });

  it('applies the strictest class to a multi-method route', () => {
    const rules = [{ method: 'POST', url: '/thing', class: 'sensitive' as const }];
    expect(classifyRoute(route(['GET', 'POST'], '/thing'), POLICIES, rules, [])).toBe('sensitive');
    expect(
      classifyRoute(route(['GET', 'POST'], '/probe'), POLICIES, [], [{ method: 'GET', url: '/probe' }])
    ).toBe('public');
  });

  it('matches prefix patterns', () => {
    const rules = [{ url: '/api/v1/jobs/*', class: 'sensitive' as const }];
    expect(classifyRoute(route('POST', '/api/v1/jobs/email'), POLICIES, rules, [])).toBe('sensitive');
    expect(classifyRoute(route('GET', '/api/v1/jobs'), POLICIES, rules, [])).toBe('sensitive');
    expect(classifyRoute(route('GET', '/api/v1/jobsx'), POLICIES, rules, [])).toBe('public');
  });
});

describe('parseTrustProxy', () => {
  it('parses booleans, hop counts and address lists', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});

// Small wallet-specific limits used in the block below so tests run fast.
const WALLET_POLICIES: Record<RateLimitClass, RateLimitPolicy> = {
  public: { max: 100, timeWindowMs: 60_000 },
  authenticated: { max: 100, timeWindowMs: 60_000 },
  sensitive: { max: 100, timeWindowMs: 60_000 },
  walletNonce: { max: 2, timeWindowMs: 3_600_000 },
  walletVerify: { max: 3, timeWindowMs: 3_600_000 },
};

async function buildWalletApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setErrorHandler(globalErrorHandler);

  await registerRateLimiting(instance, {
    enabled: true,
    store: 'memory',
    policies: WALLET_POLICIES,
    rules: [
      { method: 'POST', url: '/api/v1/auth/wallet/challenge', class: 'walletNonce' },
      { method: 'POST', url: '/api/v1/auth/wallet/verify', class: 'walletVerify' },
    ],
    exemptions: [],
  });

  const ok = async () => ({ ok: true });
  instance.post('/api/v1/auth/wallet/challenge', { preHandler: authMiddleware }, ok);
  instance.post('/api/v1/auth/wallet/verify', { preHandler: authMiddleware }, ok);

  await instance.ready();
  return instance;
}

describe('wallet route per-user rate limiting', () => {
  afterEach(async () => {
    await app?.close();
  });

  it('per-user isolation for nonce: exhausting one user does not block another', async () => {
    app = await buildWalletApp();

    // alice exhausts the 2-request nonce limit
    const aliceResponses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/wallet/challenge', headers: bearer('alice-wallet') }),
      app.inject({ method: 'POST', url: '/api/v1/auth/wallet/challenge', headers: bearer('alice-wallet') }),
    ]);
    expect(aliceResponses.map((r) => r.statusCode)).toEqual([200, 200]);

    const aliceBlocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('alice-wallet'),
    });
    expect(aliceBlocked.statusCode).toBe(429);

    // bob uses the same IP — different user bucket, not blocked
    const bob = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('bob-wallet'),
    });
    expect(bob.statusCode).toBe(200);
    expect(bob.headers['x-ratelimit-limit']).toBe('2');
  });

  it('per-user isolation for verify: exhausting one user does not block another', async () => {
    app = await buildWalletApp();

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/wallet/verify', headers: bearer('alice-verify') });
    }

    const aliceBlocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/verify',
      headers: bearer('alice-verify'),
    });
    expect(aliceBlocked.statusCode).toBe(429);

    const bob = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/verify',
      headers: bearer('bob-verify'),
    });
    expect(bob.statusCode).toBe(200);
    expect(bob.headers['x-ratelimit-limit']).toBe('3');
  });

  it('rate-limit headers reflect wallet nonce policy (not sensitive or authenticated)', async () => {
    app = await buildWalletApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('carol-wallet'),
    });
    expect(res.statusCode).toBe(200);
    // walletNonce limit is 2, not the sensitive (100) or authenticated (100) defaults
    expect(res.headers['x-ratelimit-limit']).toBe('2');
  });

  it('window is 1 hour: x-ratelimit-reset reflects hourly window', async () => {
    app = await buildWalletApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('dave-wallet'),
    });
    expect(res.statusCode).toBe(200);
    // @fastify/rate-limit returns reset in seconds; 1 hour = 3600 s
    expect(Number(res.headers['x-ratelimit-reset'])).toBeLessThanOrEqual(3600);
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('user follows across IPs: nonce quota exhausted on IP A also blocks on IP B', async () => {
    app = await buildWalletApp();

    // Exhaust from IP A
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/wallet/challenge',
        headers: bearer('eve-wallet'),
        remoteAddress: '10.1.1.1',
      });
    }

    // Same user from IP B — should be blocked (keyed by userId, not IP)
    const fromIpB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('eve-wallet'),
      remoteAddress: '10.1.1.2',
    });
    expect(fromIpB.statusCode).toBe(429);
  });

  it('unauthenticated request falls back to IP bucket, not a user bucket', async () => {
    app = await buildWalletApp();

    // Unauthenticated requests to wallet routes still increment the rate-limit counter
    // (onRequest fires before authMiddleware's preHandler). The response is 401 from
    // authMiddleware, but the IP bucket still depletes. After exhausting the walletNonce
    // limit of 2, the 3rd unauthenticated request from the same IP receives 429.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/wallet/challenge',
        remoteAddress: '10.2.2.2',
      });
      // Auth rejected, but rate-limit counter was incremented
      expect(res.statusCode).toBe(401);
    }

    // Third request from the same IP without a token — now blocked at the rate limit
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      remoteAddress: '10.2.2.2',
    });
    expect(blocked.statusCode).toBe(429);

    // A different IP without a token has its own bucket — not yet exhausted
    const otherIp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      remoteAddress: '10.2.2.3',
    });
    // This IP's bucket is fresh, so rate limit passes and authMiddleware rejects with 401
    expect(otherIp.statusCode).toBe(401);

    // An authenticated user from the same blocked IP uses a separate user bucket
    const authedFromBlockedIp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wallet/challenge',
      headers: bearer('frank-wallet'),
      remoteAddress: '10.2.2.2',
    });
    expect(authedFromBlockedIp.statusCode).toBe(200);
  });
});
