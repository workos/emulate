/**
 * Integration tests for error hooks with actual API failures
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmulator, type Emulator } from '../index.js';

describe('Error Hooks Integration Tests', () => {
  let emulator: Emulator;

  beforeAll(async () => {
    emulator = await createEmulator({ port: 0 });
  });

  afterAll(async () => {
    await emulator.close();
  });

  it('should return 422 error when error hook is configured', async () => {
    const hook = emulator.addErrorHook({
      method: 'POST',
      path: '/user_management/users',
      status: 422,
      body: {
        message: 'Validation failed',
        code: 'unprocessable_entity',
        errors: [
          { field: 'email', code: 'invalid', message: 'must be a valid email' },
        ],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.message).toBe('Validation failed');
    expect(data.code).toBe('unprocessable_entity');
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].field).toBe('email');

    emulator.removeErrorHook(hook.id);
  });

  it('should return 500 error for configured path', async () => {
    const hook = emulator.addErrorHook({
      method: 'GET',
      path: '/organizations',
      status: 500,
    });

    const res = await fetch(`${emulator.url}/organizations`, {
      headers: { 'Authorization': `Bearer ${emulator.apiKey}` },
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.message).toBe('Internal Server Error');
    expect(data.code).toBe('server_error');

    emulator.removeErrorHook(hook.id);
  });

  it('should respect count parameter and auto-remove hook', async () => {
    const hook = emulator.addErrorHook({
      method: 'POST',
      path: '/organizations',
      status: 503,
      count: 2, // Fail first 2 requests
    });

    // First request should fail
    const res1 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org' }),
    });
    expect(res1.status).toBe(503);

    // Second request should fail
    const res2 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org' }),
    });
    expect(res2.status).toBe(503);

    // Third request should succeed (hook auto-removed)
    const res3 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org' }),
    });
    expect(res3.status).toBe(201);
  });

  it('should match wildcard paths', async () => {
    const hook = emulator.addErrorHook({
      method: '*',
      path: '/user_management/*',
      status: 429,
    });

    const res = await fetch(`${emulator.url}/user_management/users`, {
      headers: { 'Authorization': `Bearer ${emulator.apiKey}` },
    });

    expect(res.status).toBe(429);

    emulator.removeErrorHook(hook.id);
  });

  it('should match wildcard methods', async () => {
    const hook = emulator.addErrorHook({
      method: '*',
      path: '/organizations',
      status: 403,
    });

    const getRes = await fetch(`${emulator.url}/organizations`, {
      headers: { 'Authorization': `Bearer ${emulator.apiKey}` },
    });
    expect(getRes.status).toBe(403);

    const postRes = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(postRes.status).toBe(403);

    emulator.removeErrorHook(hook.id);
  });

  it('should validate error hook payloads', () => {
    expect(() => {
      emulator.addErrorHook({
        method: '' as any, // Invalid method
        path: '/test',
        status: 500,
      });
    }).toThrow('Error hook validation failed: method is required and must be a string');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '' as any, // Invalid path
        status: 500,
      });
    }).toThrow('Error hook validation failed: path is required and must be a string');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 700 as any, // Invalid status
      });
    }).toThrow('Error hook validation failed: status is required and must be a valid HTTP status code');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 500,
        body: 'invalid' as any, // Invalid body
      });
    }).toThrow('Error hook validation failed: body must be an object if provided');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 500,
        count: -1, // Invalid count
      });
    }).toThrow('Error hook validation failed: count must be a non-negative number if provided');
  });

  it('should apply rate limiting to error hooks', async () => {
    const hook = emulator.addErrorHook({
      method: 'POST',
      path: '/organizations',
      status: 503,
      rateLimit: {
        maxRequests: 3,
        windowMs: 1000, // 1 second window
      },
    });

    // First 3 requests should trigger the error hook
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${emulator.url}/organizations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({ name: `Test Org ${i}` }),
      });
      expect(res.status).toBe(503);
    }

    // 4th request should hit rate limit and return 429
    const res4 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org 4' }),
    });
    expect(res4.status).toBe(429);
    const data = await res4.json();
    expect(data.code).toBe('rate_limit_exceeded');
    expect(data.retry_after).toBeGreaterThan(0);

    emulator.removeErrorHook(hook.id);
  });

  it('should validate rate limit configuration', () => {
    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 500,
        rateLimit: 'invalid' as any,
      });
    }).toThrow('Error hook validation failed: rateLimit must be an object if provided');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 500,
        rateLimit: {
          maxRequests: 0, // Invalid
          windowMs: 1000,
        },
      });
    }).toThrow('Error hook validation failed: rateLimit.maxRequests must be a positive number');

    expect(() => {
      emulator.addErrorHook({
        method: 'POST',
        path: '/test',
        status: 500,
        rateLimit: {
          maxRequests: 10,
          windowMs: 0, // Invalid
        },
      });
    }).toThrow('Error hook validation failed: rateLimit.windowMs must be a positive number');
  });

  it('should allow normal operation after removing error hook', async () => {
    const hook = emulator.addErrorHook({
      method: 'POST',
      path: '/organizations',
      status: 500,
    });

    const res1 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org' }),
    });
    expect(res1.status).toBe(500);

    emulator.removeErrorHook(hook.id);

    const res2 = await fetch(`${emulator.url}/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({ name: 'Test Org' }),
    });
    expect(res2.status).toBe(201);
  });

  it('should list all active error hooks', async () => {
    const hook1 = emulator.addErrorHook({
      method: 'POST',
      path: '/test1',
      status: 500,
    });

    const hook2 = emulator.addErrorHook({
      method: 'GET',
      path: '/test2',
      status: 404,
    });

    const hooks = emulator.listErrorHooks();
    expect(hooks).toHaveLength(2);
    expect(hooks.some((h) => h.id === hook1.id)).toBe(true);
    expect(hooks.some((h) => h.id === hook2.id)).toBe(true);

    emulator.removeErrorHook(hook1.id);
    emulator.removeErrorHook(hook2.id);
  });
});