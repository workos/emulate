import { type RouteContext, notFound, parseJsonBody, validationError, parseListParams } from '../../core/index.js';
import type { WorkOSConnectApplication } from '../entities.js';
import { getWorkOSStore } from '../store.js';
import {
  formatConnectApplication,
  formatClientSecret,
  generateClientId,
  generateVerificationToken,
  formatListResponse,
} from '../helpers.js';

/**
 * Redirect URIs as the spec sends them (`RedirectUriDto`: `{ uri, default? }`) reduced to the
 * bare URI strings the emulator stores. Plain strings are accepted too, because the create
 * route has always taken that shorter form and the `connectApplications[].redirect_uris` seed
 * key is typed as `string[]`.
 *
 * `default` is parsed and discarded: nothing in the emulator distinguishes a default callback,
 * and `formatConnectApplication` reports `default: false` for every URI.
 */
function parseRedirectUris(value: unknown): string[] {
  const field = 'redirect_uris';
  if (!Array.isArray(value)) {
    throw validationError(`${field} must be an array`, [{ field, code: 'invalid' }]);
  }
  return value.map((entry) => {
    const uri =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { uri?: unknown }).uri === 'string'
          ? (entry as { uri: string }).uri
          : undefined;
    if (uri === undefined) {
      throw validationError(`${field} entries must be a string or an object with a uri`, [{ field, code: 'invalid' }]);
    }
    // A blank entry is worse than none: `/oauth2/authorize` treats a non-empty list as an
    // allow-list, so one empty string locks out every callback the app could present.
    if (uri.trim().length === 0) {
      throw validationError(`${field} entries must not be blank`, [{ field, code: 'invalid' }]);
    }
    return uri;
  });
}

export function connectRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // The spec documents the `{id}` param on every `/connect/applications/{id}...` route as
  // "the application ID or client ID". Resolve the primary key first so an application ID
  // always wins over another application's colliding client_id.
  const findApplication = (ref: string) =>
    ws.connectApplications.get(ref) ?? ws.connectApplications.findOneBy('client_id', ref);

  const requireApplication = (ref: string): WorkOSConnectApplication => {
    const application = findApplication(ref);
    if (!application) throw notFound('ConnectApplication');
    return application;
  };

  // List applications
  app.get('/connect/applications', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const organizationId = url.searchParams.get('organization_id') ?? undefined;
    // "Defaults to `authenticated` only when not specified" — so an unfiltered list hides
    // dynamically registered applications rather than showing everything.
    const registrationTypes = (url.searchParams.get('registration_types') ?? 'authenticated')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const unknown = registrationTypes.filter((t) => t !== 'dynamic' && t !== 'authenticated');
    if (unknown.length > 0) {
      throw validationError(`registration_types must be 'dynamic' or 'authenticated': ${unknown.join(', ')}`, [
        { field: 'registration_types', code: 'invalid' },
      ]);
    }

    const result = ws.connectApplications.list({
      ...params,
      filter: (a) =>
        (organizationId === undefined || a.organization_id === organizationId) &&
        registrationTypes.includes(a.was_dynamically_registered ? 'dynamic' : 'authenticated'),
    });
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

    if (body.login_url !== undefined && body.login_url !== null && typeof body.login_url !== 'string') {
      throw validationError('login_url must be a string or null', [{ field: 'login_url', code: 'invalid' }]);
    }

    const applicationType = body.application_type === 'm2m' ? 'm2m' : 'oauth';
    const organizationId = (body.organization_id as string) ?? null;

    if (body.is_first_party !== undefined && typeof body.is_first_party !== 'boolean') {
      throw validationError('is_first_party must be a boolean', [{ field: 'is_first_party', code: 'invalid' }]);
    }
    if (body.uses_pkce !== undefined && body.uses_pkce !== null && typeof body.uses_pkce !== 'boolean') {
      throw validationError('uses_pkce must be a boolean or null', [{ field: 'uses_pkce', code: 'invalid' }]);
    }
    // The spec marks `is_first_party` required on an oauth create; defaulting to true keeps
    // the bodies that predate it creating the same first-party application they always did.
    const isFirstParty = (body.is_first_party as boolean | undefined) ?? true;

    // m2m applications are owned by an organization; reject a null or dangling owner so
    // the emulator never returns an m2m app (or later signs a token) for an org that
    // doesn't exist. A third-party oauth application names an owner for the same reason.
    if (applicationType === 'm2m' || !isFirstParty) {
      if (!organizationId) {
        throw validationError(
          applicationType === 'm2m'
            ? 'organization_id is required for m2m applications'
            : 'organization_id is required when is_first_party is false',
          [{ field: 'organization_id', code: 'required' }],
        );
      }
      if (!ws.organizations.get(organizationId)) {
        throw validationError('organization_id must reference an existing organization', [
          { field: 'organization_id', code: 'invalid' },
        ]);
      }
    }

    // `CreateM2MApplicationDto` has no redirect_uris, and an m2m application never reaches a
    // callback — storing one would leave a value no route reads and no update can clear.
    if (applicationType === 'm2m' && body.redirect_uris != null) {
      throw validationError('redirect_uris can only be set on oauth applications', [
        { field: 'redirect_uris', code: 'invalid' },
      ]);
    }

    const application = ws.connectApplications.insert({
      object: 'connect_application',
      name: name.trim(),
      description: (body.description as string) ?? null,
      application_type: applicationType,
      organization_id: organizationId,
      scopes: (body.scopes as string[]) ?? [],
      audience: (body.audience as string) ?? null,
      redirect_uris: body.redirect_uris == null ? [] : parseRedirectUris(body.redirect_uris),
      is_first_party: isFirstParty,
      // Nothing in the emulator performs dynamic client registration, so an application
      // created through this route is always one an authenticated caller registered.
      was_dynamically_registered: false,
      uses_pkce: (body.uses_pkce as boolean | undefined) ?? false,
      login_url: (body.login_url as string) ?? null,
      client_id: generateClientId(),
      logo_url: (body.logo_url as string) ?? null,
    });

    return c.json(formatConnectApplication(application), 201);
  });

  // Get application
  app.get('/connect/applications/:id', (c) => {
    return c.json(formatConnectApplication(requireApplication(c.req.param('id'))));
  });

  // Update application
  app.put('/connect/applications/:id', async (c) => {
    const application = requireApplication(c.req.param('id'));
    // An empty update is a no-op, not a parse error — `parseJsonBody` rejects an absent body.
    const body = c.req.raw.body ? await parseJsonBody(c) : {};

    // `UpdateOAuthApplicationDto` is the only update body the spec defines, and every field on
    // it is optional: an absent key leaves the stored value alone. An explicit null clears —
    // to null for `description`, to an empty array for the two list fields, which have no
    // nullable representation in the store.
    const patch: Partial<WorkOSConnectApplication> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw validationError('name must be a non-empty string', [{ field: 'name', code: 'invalid' }]);
      }
      patch.name = body.name.trim();
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw validationError('description must be a string or null', [{ field: 'description', code: 'invalid' }]);
      }
      patch.description = body.description;
    }

    if (body.scopes !== undefined) {
      if (body.scopes === null) {
        patch.scopes = [];
      } else if (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === 'string')) {
        throw validationError('scopes must be an array of strings', [{ field: 'scopes', code: 'invalid' }]);
      } else {
        patch.scopes = body.scopes as string[];
      }
    }

    if (body.redirect_uris !== undefined) {
      // The spec scopes redirect URIs to OAuth applications, as the create route does. An
      // explicit null still passes: clearing what an m2m app cannot have is a no-op, not an error.
      if (application.application_type === 'm2m' && body.redirect_uris !== null) {
        throw validationError('redirect_uris can only be set on oauth applications', [
          { field: 'redirect_uris', code: 'invalid' },
        ]);
      }
      patch.redirect_uris = body.redirect_uris === null ? [] : parseRedirectUris(body.redirect_uris);
    }

    // Emulator-only, so it is not in the spec's update DTO — but create accepts it and this is
    // the only other write path, so without it a seeded login page could never be changed.
    if (body.login_url !== undefined) {
      if (body.login_url !== null && typeof body.login_url !== 'string') {
        throw validationError('login_url must be a string or null', [{ field: 'login_url', code: 'invalid' }]);
      }
      patch.login_url = body.login_url;
    }

    const updated = ws.connectApplications.update(application.id, patch);
    return c.json(formatConnectApplication(updated!));
  });

  // Delete application
  app.delete('/connect/applications/:id', (c) => {
    const application = requireApplication(c.req.param('id'));
    ws.clientSecrets.deleteBy('application_id', application.id);
    // An in-flight Standalone Connect login outlives its application otherwise: the browser
    // still completes at `/oauth2/authorize/complete`, creates a user and lands on the callback
    // with a code that `/oauth2/token` can no longer redeem. Fail the login, not the callback.
    ws.externalAuthSessions.deleteBy('client_id', application.client_id);
    // authCodes is not indexed on client_id, so this is the `.all()` sweep organizations.ts uses.
    for (const authCode of ws.authCodes.all()) {
      if (authCode.client_id === application.client_id) ws.authCodes.delete(authCode.id);
    }
    ws.connectApplications.delete(application.id);
    return c.body(null, 204);
  });

  // List client secrets. The spec returns a bare array here, not the `list` envelope the other
  // collection routes use, so there is no cursor to order against: oldest first, because these
  // are rotated in place and the order a caller cares about is the order they were issued.
  app.get('/connect/applications/:id/client_secrets', (c) => {
    const application = requireApplication(c.req.param('id'));
    const secrets = ws.clientSecrets
      .findBy('application_id', application.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return c.json(secrets.map(formatClientSecret));
  });

  // Create client secret
  app.post('/connect/applications/:id/client_secrets', (c) => {
    const application = requireApplication(c.req.param('id'));

    const value = `secret_${generateVerificationToken()}`;
    const secret = ws.clientSecrets.insert({
      object: 'connect_application_secret',
      application_id: application.id,
      value,
      secret_hint: value.slice(-4),
      last_used_at: null,
    });

    // Return full value only on creation
    return c.json({ ...formatClientSecret(secret), secret: secret.value }, 201);
  });

  // Revoke client secret
  app.delete('/connect/client_secrets/:id', (c) => {
    const secret = ws.clientSecrets.get(c.req.param('id'));
    if (!secret) throw notFound('ClientSecret');
    ws.clientSecrets.delete(secret.id);
    return c.body(null, 204);
  });
}
