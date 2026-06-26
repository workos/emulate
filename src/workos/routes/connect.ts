import { type RouteContext, notFound, parseJsonBody, validationError, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatConnectApplication,
  formatClientSecret,
  generateClientId,
  generateVerificationToken,
  formatListResponse,
} from '../helpers.js';

export function connectRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // List applications
  app.get('/connect/applications', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const result = ws.connectApplications.list({ ...params });
    return c.json(formatListResponse(result, formatConnectApplication));
  });

  // Create application
  app.post('/connect/applications', async (c) => {
    const body = await parseJsonBody(c);
    const name = body.name as string | undefined;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    }

    if (
      body.scopes !== undefined &&
      (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === 'string'))
    ) {
      throw validationError('scopes must be an array of strings', [{ field: 'scopes', code: 'invalid' }]);
    }

    const applicationType = body.application_type === 'm2m' ? 'm2m' : 'oauth';
    const organizationId = (body.organization_id as string) ?? null;
    // m2m applications are owned by an organization; reject a null or dangling owner so
    // the emulator never returns an m2m app (or later signs a token) for an org that
    // doesn't exist.
    if (applicationType === 'm2m') {
      if (!organizationId) {
        throw validationError('organization_id is required for m2m applications', [
          { field: 'organization_id', code: 'required' },
        ]);
      }
      if (!ws.organizations.get(organizationId)) {
        throw validationError('organization_id must reference an existing organization', [
          { field: 'organization_id', code: 'invalid' },
        ]);
      }
    }

    const application = ws.connectApplications.insert({
      object: 'connect_application',
      name: name.trim(),
      description: (body.description as string) ?? null,
      application_type: applicationType,
      organization_id: organizationId,
      scopes: (body.scopes as string[]) ?? [],
      redirect_uris: (body.redirect_uris as string[]) ?? [],
      client_id: generateClientId(),
      logo_url: (body.logo_url as string) ?? null,
    });

    return c.json(formatConnectApplication(application), 201);
  });

  // Get application
  app.get('/connect/applications/:id', (c) => {
    const application = ws.connectApplications.get(c.req.param('id'));
    if (!application) throw notFound('ConnectApplication');
    return c.json(formatConnectApplication(application));
  });

  // Create client secret
  app.post('/connect/applications/:id/client_secrets', (c) => {
    const application = ws.connectApplications.get(c.req.param('id'));
    if (!application) throw notFound('ConnectApplication');

    const value = `secret_${generateVerificationToken()}`;
    const secret = ws.clientSecrets.insert({
      object: 'client_secret',
      application_id: application.id,
      value,
      last_four: value.slice(-4),
    });

    // Return full value only on creation
    return c.json(
      {
        ...formatClientSecret(secret),
        value: secret.value,
      },
      201,
    );
  });

  // Revoke client secret
  app.delete('/connect/client_secrets/:id', (c) => {
    const secret = ws.clientSecrets.get(c.req.param('id'));
    if (!secret) throw notFound('ClientSecret');
    ws.clientSecrets.delete(secret.id);
    return c.body(null, 204);
  });
}
