import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from './index.js';
import { workosPlugin } from '../workos/index.js';
import { addErrorHook, getErrorHooks, removeErrorHook } from './error-hooks.js';
import type { Store } from './store.js';

const apiKeys: ApiKeyMap = { sk_test_hooks: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_hooks', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Error hooks middleware', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    store = result.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });

  it('returns configured error for matching route', async () => {
    addErrorHook(store, {
      method: 'POST',
      path: '/user_management/users',
      status: 422,
      body: { message: 'Validation failed', code: 'unprocessable_entity' },
    });

    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toBe('Validation failed');
    expect(body.code).toBe('unprocessable_entity');
  });

  it('returns default body when no custom body is provided', async () => {
    addErrorHook(store, {
      method: 'GET',
      path: '/user_management/users',
      status: 500,
    });

    const res = await req('/user_management/users');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toBe('Internal Server Error');
    expect(body.code).toBe('server_error');
  });

  it('does not intercept non-matching routes', async () => {
    addErrorHook(store, {
      method: 'GET',
      path: '/user_management/users',
      status: 500,
    });

    const res = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme' }),
    });
    expect(res.status).toBe(201);
  });

  it('does not intercept non-matching methods', async () => {
    addErrorHook(store, {
      method: 'DELETE',
      path: '/user_management/users',
      status: 500,
    });

    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'ok@example.com' }),
    });
    expect(res.status).toBe(201);
  });

  it('supports wildcard method matching', async () => {
    addErrorHook(store, {
      method: '*',
      path: '/user_management/users',
      status: 503,
    });

    const getRes = await req('/user_management/users');
    expect(getRes.status).toBe(503);

    const postRes = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(postRes.status).toBe(503);
  });

  it('supports wildcard path matching', async () => {
    addErrorHook(store, {
      method: 'GET',
      path: '/user_management/*',
      status: 500,
    });

    const res = await req('/user_management/users');
    expect(res.status).toBe(500);
  });

  it('supports catch-all path', async () => {
    addErrorHook(store, {
      method: '*',
      path: '*',
      status: 503,
    });

    const res = await req('/user_management/users');
    expect(res.status).toBe(503);
  });

  it('decrements count and removes hook when exhausted', async () => {
    addErrorHook(store, {
      method: 'POST',
      path: '/user_management/users',
      status: 500,
      count: 2,
    });

    const res1 = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com' }),
    });
    expect(res1.status).toBe(500);

    const res2 = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'b@example.com' }),
    });
    expect(res2.status).toBe(500);

    // Third request should succeed — hook is exhausted
    const res3 = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'c@example.com' }),
    });
    expect(res3.status).toBe(201);
    expect(getErrorHooks(store)).toHaveLength(0);
  });

  it('count: 1 fires exactly once', async () => {
    addErrorHook(store, {
      method: 'GET',
      path: '/user_management/users',
      status: 500,
      count: 1,
    });

    const res1 = await req('/user_management/users');
    expect(res1.status).toBe(500);

    const res2 = await req('/user_management/users');
    expect(res2.status).toBe(200);
  });

  it('includes custom errors array in body', async () => {
    addErrorHook(store, {
      method: 'POST',
      path: '/user_management/users',
      status: 422,
      body: {
        message: 'Invalid input',
        code: 'unprocessable_entity',
        errors: [{ field: 'email', code: 'invalid', message: 'must be a valid email' }],
      },
    });

    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'bad' }),
    });
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].field).toBe('email');
  });

  it('first matching hook wins', async () => {
    addErrorHook(store, { method: 'GET', path: '/user_management/users', status: 422 });
    addErrorHook(store, { method: 'GET', path: '/user_management/users', status: 500 });

    const res = await req('/user_management/users');
    expect(res.status).toBe(422);
  });
});

describe('Error hooks CRUD helpers', () => {
  let store: Store;

  beforeEach(() => {
    const result = createTestApp();
    store = result.store;
  });

  it('adds and lists hooks', () => {
    const hook = addErrorHook(store, { method: 'GET', path: '/test', status: 500 });
    expect(hook.id).toMatch(/^hook_/);
    expect(getErrorHooks(store)).toHaveLength(1);
  });

  it('removes a hook by id', () => {
    const hook = addErrorHook(store, { method: 'GET', path: '/test', status: 500 });
    expect(removeErrorHook(store, hook.id)).toBe(true);
    expect(getErrorHooks(store)).toHaveLength(0);
  });

  it('returns false when removing non-existent hook', () => {
    expect(removeErrorHook(store, 'hook_nonexistent')).toBe(false);
  });

  it('clears hooks on store reset', () => {
    addErrorHook(store, { method: 'GET', path: '/test', status: 500 });
    store.reset();
    expect(getErrorHooks(store)).toHaveLength(0);
  });
});
