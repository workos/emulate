import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createApiErrorHandler, EntityNotFoundError, NestNotFoundError, notFound } from './error-handler.js';

async function render(err: Error): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.get('/', () => {
    throw err;
  });
  const res = await app.request('/');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('404 bodies', () => {
  it("renders production's entity_not_found body when the lookup had an id", async () => {
    const { status, body } = await render(notFound('Organization', 'org_01ABC'));
    expect(status).toBe(404);
    expect(body).toEqual({
      message: "Organization not found: 'org_01ABC'.",
      code: 'entity_not_found',
      entity_id: 'org_01ABC',
    });
  });

  it('leaves entity_id out rather than inventing one when the lookup had no id', async () => {
    const { body } = await render(notFound('User'));
    expect(body).toEqual({ message: 'User not found', code: 'entity_not_found' });
    expect('entity_id' in body).toBe(false);
  });

  it('lets a site override the message and add fields where production does', async () => {
    const { body } = await render(
      new EntityNotFoundError('Permission', 'posts:read', {
        message: "Permission 'posts:read' not found.",
        extra: { entity_type: 'Permission' },
      }),
    );
    expect(body).toEqual({
      message: "Permission 'posts:read' not found.",
      code: 'entity_not_found',
      entity_id: 'posts:read',
      entity_type: 'Permission',
    });
  });

  it("renders a bare Nest NotFoundException as production's filter does: no code", async () => {
    const fromString = await render(new NestNotFoundError('Radar attempt not found', 'Not Found'));
    expect(fromString.status).toBe(404);
    expect(fromString.body).toEqual({ message: 'Radar attempt not found', error: 'Not Found' });

    const bare = await render(new NestNotFoundError());
    expect(bare.body).toEqual({ message: 'Not Found' });

    const fromObject = await render(new NestNotFoundError('JWT template not found for this environment.'));
    expect(fromObject.body).toEqual({ message: 'JWT template not found for this environment.' });
  });
});
