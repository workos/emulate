import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_config: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_config', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Config routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  describe('Redirect URIs', () => {
    it('creates a redirect URI', async () => {
      const res = await req('/user_management/redirect_uris', {
        method: 'POST',
        body: JSON.stringify({ uri: 'http://localhost:3000/callback' }),
      });
      expect(res.status).toBe(201);
      const data = await json(res);
      expect(data.object).toBe('redirect_uri');
      expect(data.uri).toBe('http://localhost:3000/callback');
      expect(data.id).toMatch(/^redir_/);
    });

    it('rejects duplicate redirect URI', async () => {
      await req('/user_management/redirect_uris', {
        method: 'POST',
        body: JSON.stringify({ uri: 'http://localhost:3000/dup' }),
      });
      const res = await req('/user_management/redirect_uris', {
        method: 'POST',
        body: JSON.stringify({ uri: 'http://localhost:3000/dup' }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('redirect_uri_already_exists');
    });
  });

  describe('CORS Origins', () => {
    it('creates a CORS origin', async () => {
      const res = await req('/user_management/cors_origins', {
        method: 'POST',
        body: JSON.stringify({ origin: 'http://localhost:3000' }),
      });
      expect(res.status).toBe(201);
      const data = await json(res);
      expect(data.object).toBe('cors_origin');
      expect(data.origin).toBe('http://localhost:3000');
      expect(data.id).toMatch(/^cors_/);
    });

    it('rejects duplicate CORS origin', async () => {
      await req('/user_management/cors_origins', {
        method: 'POST',
        body: JSON.stringify({ origin: 'http://localhost:4000' }),
      });
      const res = await req('/user_management/cors_origins', {
        method: 'POST',
        body: JSON.stringify({ origin: 'http://localhost:4000' }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('cors_origin_already_exists');
    });
  });

  describe('JWT Template', () => {
    const content = '{"urn:myapp:email": "{{ user.email }}"}';

    it('404s before a template is set', async () => {
      const res = await req('/user_management/jwt_template');
      expect(res.status).toBe(404);
    });

    it('updates and persists the template in the spec shape', async () => {
      const res = await req('/user_management/jwt_template', {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.object).toBe('jwt_template');
      expect(data.content).toBe(content);
      expect(data.created_at).toBeString();
      expect(data.updated_at).toBeString();

      const getRes = await req('/user_management/jwt_template');
      expect((await json(getRes)).content).toBe(content);
    });

    it('keeps created_at across updates', async () => {
      const first = await json(
        await req('/user_management/jwt_template', { method: 'PUT', body: JSON.stringify({ content }) }),
      );
      const second = await json(
        await req('/user_management/jwt_template', {
          method: 'PUT',
          body: JSON.stringify({ content: '{"a": "b"}' }),
        }),
      );
      expect(second.created_at).toBe(first.created_at);
    });

    it('rejects a template that sets a reserved claim', async () => {
      const res = await req('/user_management/jwt_template', {
        method: 'PUT',
        body: JSON.stringify({ content: '{"sub": "{{ user.id }}", "iss": "me"}' }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toContain('reserved claims: sub, iss');
    });

    it('rejects a template referencing an unknown variable', async () => {
      const res = await req('/user_management/jwt_template', {
        method: 'PUT',
        body: JSON.stringify({ content: '{"x": "{{ usr.email }}"}' }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toContain('unknown template variable `usr`');
    });

    it('rejects a template that does not render to JSON', async () => {
      const res = await req('/user_management/jwt_template', {
        method: 'PUT',
        body: JSON.stringify({ content: 'not json' }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toContain('did not render to valid JSON');
    });

    it('rejects a missing content field', async () => {
      const res = await req('/user_management/jwt_template', { method: 'PUT', body: JSON.stringify({}) });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toContain('content is required');
    });

    // The emulator used to accept `custom_claims` and silently drop it from the token. Point
    // anyone still sending it at the field that works instead of accepting it as a no-op.
    it('names `content` when handed the old custom_claims field', async () => {
      const res = await req('/user_management/jwt_template', {
        method: 'PUT',
        body: JSON.stringify({ custom_claims: { tenant: 'acme' } }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toContain('custom_claims is not a JWT template field');
    });
  });
});
