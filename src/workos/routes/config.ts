import { type RouteContext, parseJsonBody, WorkOSApiError, validationError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatRedirectUri, formatCorsOrigin } from '../helpers.js';
import { STORE_KEYS } from '../constants.js';
import { validateJwtTemplateContent } from '../jwt-template.js';
import type { WorkOSJwtTemplate } from '../entities.js';

export function configRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/user_management/redirect_uris', async (c) => {
    const body = await parseJsonBody(c);
    const uri = body.uri as string | undefined;
    if (!uri) {
      throw validationError('uri is required', [{ field: 'uri', code: 'required' }]);
    }

    const existing = ws.redirectUris.findOneBy('uri', uri);
    if (existing) {
      throw new WorkOSApiError(422, 'Redirect URI already exists', 'redirect_uri_already_exists');
    }

    const redirectUri = ws.redirectUris.insert({
      object: 'redirect_uri',
      uri,
    });

    return c.json(formatRedirectUri(redirectUri), 201);
  });

  app.post('/user_management/cors_origins', async (c) => {
    const body = await parseJsonBody(c);
    const origin = body.origin as string | undefined;
    if (!origin) {
      throw validationError('origin is required', [{ field: 'origin', code: 'required' }]);
    }

    const existing = ws.corsOrigins.findOneBy('origin', origin);
    if (existing) {
      throw new WorkOSApiError(422, 'CORS origin already exists', 'cors_origin_already_exists');
    }

    const corsOrigin = ws.corsOrigins.insert({
      object: 'cors_origin',
      origin,
    });

    return c.json(formatCorsOrigin(corsOrigin), 201);
  });

  // A GET before any template is set is a 404, per the spec: an environment either has a
  // template or it does not, and an empty one would render to no claims anyway.
  app.get('/user_management/jwt_template', (c) => {
    const template = store.getData<WorkOSJwtTemplate>(STORE_KEYS.jwtTemplate);
    if (!template) {
      throw new WorkOSApiError(404, 'JWT template not found', 'not_found');
    }
    return c.json(template);
  });

  app.put('/user_management/jwt_template', async (c) => {
    const body = await parseJsonBody(c);

    // `custom_claims` was an emulator-only field that never reached a token. Name the
    // replacement rather than accepting it and silently doing nothing.
    if (body.custom_claims !== undefined && body.content === undefined) {
      throw validationError(
        'custom_claims is not a JWT template field; pass `content` as a template string, e.g. {"content": "{\\"claim\\": \\"{{ user.email }}\\"}"}',
        [{ field: 'content', code: 'required' }],
      );
    }

    const problems = validateJwtTemplateContent(body.content);
    if (problems.length > 0) {
      throw validationError(problems.join('; '), [{ field: 'content', code: 'invalid' }]);
    }

    const now = new Date().toISOString();
    const existing = store.getData<WorkOSJwtTemplate>(STORE_KEYS.jwtTemplate);
    const template: WorkOSJwtTemplate = {
      object: 'jwt_template',
      content: body.content as string,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    store.setData(STORE_KEYS.jwtTemplate, template);
    return c.json(template);
  });
}
