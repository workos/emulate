/**
 * JWT template rendering.
 *
 * A JWT template is a string in `content` that renders to a JSON object whose keys are
 * merged into the access tokens the emulator mints. WorkOS documents a small custom
 * interpolation syntax — not full Liquid — so this implements exactly that subset:
 *
 * - `{{ user.email }}` — variable interpolation over a dotted path
 * - `{{ user.nickname || user.email }}` — fallback chain, first non-null wins
 * - `{{ user.nickname || 'anonymous' }}` — single-quoted string literal as a fallback
 * - `"{{ user.first_name }} {{ user.last_name }}"` — concatenation inside a JSON string
 * - `{"meta": {{ user.metadata }}}` — whole objects and arrays, interpolated outside a string
 *
 * Filters, conditionals, and loops are not part of the syntax and are not supported.
 */

import { type Store, WorkOSApiError } from '../core/index.js';
import type { WorkOSStore } from './store.js';
import type { WorkOSJwtTemplate, WorkOSUser } from './entities.js';
import { STORE_KEYS } from './constants.js';

/**
 * Claims a template may not set. WorkOS rejects these at template-update time, so the
 * emulator does too rather than letting a template quietly shadow the identity of the
 * token. Notably `aud`, `sid`, `org_id`, `role`, `roles`, and `permissions` are *not*
 * reserved: a template may override those, and the rendered value wins.
 */
export const RESERVED_JWT_CLAIMS = ['iss', 'sub', 'exp', 'iat', 'nbf', 'jti'] as const;

/**
 * WorkOS caps the rendered claim set at 3072 bytes, because the session cookie that
 * carries it has to fit in a browser. Enforced at sign time, since the rendered size
 * depends on the data the claims are drawn from.
 */
export const MAX_RENDERED_CLAIMS_BYTES = 3072;

/** Roots a template may reference. An unknown root is a typo, and fails validation. */
const TEMPLATE_ROOTS = ['user', 'organization', 'organization_membership'] as const;

export interface JwtTemplateContext {
  user?: Record<string, unknown>;
  organization?: Record<string, unknown>;
  organization_membership?: Record<string, unknown>;
}

/** A template that cannot be rendered: bad syntax, unknown root, or an oversized result. */
export class JwtTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtTemplateError';
  }
}

function isStringLiteral(token: string): boolean {
  return token.length >= 2 && token.startsWith("'") && token.endsWith("'");
}

function resolvePath(path: string, context: JwtTemplateContext): unknown {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(path)) {
    throw new JwtTemplateError(`invalid variable path \`${path}\``);
  }

  const segments = path.split('.');
  const root = segments[0];
  if (!(TEMPLATE_ROOTS as readonly string[]).includes(root)) {
    throw new JwtTemplateError(`unknown template variable \`${root}\` (available: ${TEMPLATE_ROOTS.join(', ')})`);
  }

  // A path below a known root that the emulator does not model resolves to null, so a
  // fallback can cover it. Only the root is checked, which is what catches typos.
  let current: unknown = context[root as keyof JwtTemplateContext];
  for (const segment of segments.slice(1)) {
    if (current === null || current === undefined) return null;
    if (typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

/** Evaluate one `{{ … }}` expression: a fallback chain of paths and string literals. */
function evaluateExpression(expression: string, context: JwtTemplateContext): unknown {
  const alternatives = expression
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (alternatives.length === 0) {
    throw new JwtTemplateError('empty `{{ }}` expression');
  }

  for (const alternative of alternatives) {
    if (isStringLiteral(alternative)) return alternative.slice(1, -1);
    const value = resolvePath(alternative, context);
    if (value !== null && value !== undefined) return value;
  }

  return null;
}

/** Interpolated inside a JSON string: coerced to text, with null becoming empty. */
function toStringFragment(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value).slice(1, -1);
  if (typeof value === 'object') return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  return String(value);
}

/** Interpolated outside a JSON string: emitted as a JSON value. */
function toJsonFragment(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

/**
 * Substitute every `{{ … }}` expression, tracking whether the cursor sits inside a JSON
 * string literal — that is what decides between text and JSON-value interpolation.
 */
function interpolate(content: string, context: JwtTemplateContext): string {
  let out = '';
  let inString = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (char === '{' && content[i + 1] === '{') {
      const end = content.indexOf('}}', i + 2);
      if (end === -1) throw new JwtTemplateError('unterminated `{{` expression');
      const value = evaluateExpression(content.slice(i + 2, end), context);
      out += inString ? toStringFragment(value) : toJsonFragment(value);
      i = end + 2;
      continue;
    }

    if (inString && char === '\\') {
      out += char + (content[i + 1] ?? '');
      i += 2;
      continue;
    }

    if (char === '"') inString = !inString;
    out += char;
    i++;
  }

  if (inString) throw new JwtTemplateError('unterminated string literal');
  return out;
}

/** Render a template to the claim object it produces, before reserved-claim stripping. */
function renderToObject(content: string, context: JwtTemplateContext): Record<string, unknown> {
  const rendered = interpolate(content, context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    throw new JwtTemplateError('template did not render to valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JwtTemplateError('template must render to a JSON object');
  }

  return parsed as Record<string, unknown>;
}

/**
 * Render a template into claims ready to merge into a token. Top-level nulls are dropped
 * (a claim WorkOS would omit rather than emit as null), as are reserved claims — those are
 * rejected when the template is set, so this is only a backstop.
 */
export function renderJwtTemplate(content: string, context: JwtTemplateContext): Record<string, unknown> {
  const rendered = renderToObject(content, context);

  const claims: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rendered)) {
    if (value === null || value === undefined) continue;
    if ((RESERVED_JWT_CLAIMS as readonly string[]).includes(key)) continue;
    claims[key] = value;
  }

  const size = Buffer.byteLength(JSON.stringify(claims), 'utf-8');
  if (size > MAX_RENDERED_CLAIMS_BYTES) {
    throw new JwtTemplateError(`template rendered to ${size} bytes, over the ${MAX_RENDERED_CLAIMS_BYTES}-byte limit`);
  }

  return claims;
}

/**
 * Representative values used to render a template at validation time, so syntax errors,
 * unknown variables, and reserved claims surface when the template is set rather than at
 * the next sign-in. Only the shape matters — these values never reach a token.
 */
const PROBE_CONTEXT: JwtTemplateContext = {
  user: {
    id: 'user_01PROBE',
    email: 'probe@example.com',
    first_name: 'Probe',
    last_name: 'User',
    email_verified: true,
    profile_picture_url: null,
    external_id: null,
    metadata: {},
  },
  organization: {
    id: 'org_01PROBE',
    name: 'Probe Org',
    domains: [{ domain: 'example.com' }],
    stripe_customer_id: null,
    external_id: null,
    metadata: {},
  },
  organization_membership: {
    id: 'om_01PROBE',
    role: 'member',
    roles: ['member'],
  },
};

/**
 * Validate template content the way WorkOS does when it is set: it has to render to a JSON
 * object with at least one key, reference only known variables, and stay off the reserved
 * claims. Returns human-readable problems; empty means valid.
 */
export function validateJwtTemplateContent(content: unknown): string[] {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return ['content is required and must be a non-empty string'];
  }

  let rendered: Record<string, unknown>;
  try {
    rendered = renderToObject(content, PROBE_CONTEXT);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const keys = Object.keys(rendered);
  if (keys.length === 0) {
    return ['template must render to a JSON object with at least one key'];
  }

  const reserved = keys.filter((key) => (RESERVED_JWT_CLAIMS as readonly string[]).includes(key));
  if (reserved.length > 0) {
    return [`template may not set reserved claims: ${reserved.join(', ')}`];
  }

  return [];
}

/**
 * Assemble the variables a template can read for one sign-in. Fields the emulator does not
 * model — `organization.allow_profiles_outside_organization` and
 * `organization_membership.custom_attributes` among them — are left out rather than filled
 * with a plausible value, so a template referencing them resolves to null.
 */
export function buildJwtTemplateContext(
  ws: WorkOSStore,
  user: WorkOSUser,
  organizationId?: string | null,
): JwtTemplateContext {
  const context: JwtTemplateContext = {
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      email_verified: user.email_verified,
      profile_picture_url: user.profile_picture_url,
      external_id: user.external_id,
      metadata: user.metadata,
    },
  };

  if (!organizationId) return context;

  const organization = ws.organizations.get(organizationId);
  if (organization) {
    context.organization = {
      id: organization.id,
      name: organization.name,
      domains: ws.organizationDomains
        .findBy('organization_id', organization.id)
        .map((domain) => ({ id: domain.id, domain: domain.domain, state: domain.state })),
      stripe_customer_id: organization.stripe_customer_id,
      external_id: organization.external_id,
      metadata: organization.metadata,
    };
  }

  const membership = ws.organizationMemberships
    .findBy('organization_id', organizationId)
    .find((m) => m.user_id === user.id);
  if (membership) {
    context.organization_membership = {
      id: membership.id,
      role: membership.role.slug,
      roles: [membership.role.slug],
      external_id: membership.external_id,
      metadata: membership.metadata,
    };
  }

  return context;
}

/**
 * Render the environment's configured template, if one is set, into claims for a token.
 * Returns undefined when no template is configured.
 */
export function renderConfiguredJwtTemplate(
  store: Store,
  ws: WorkOSStore,
  user: WorkOSUser,
  organizationId?: string | null,
): Record<string, unknown> | undefined {
  const template = store.getData<WorkOSJwtTemplate>(STORE_KEYS.jwtTemplate);
  if (!template?.content) return undefined;

  try {
    return renderJwtTemplate(template.content, buildJwtTemplateContext(ws, user, organizationId));
  } catch (error) {
    // A template that will not render is a configuration error. Failing the sign-in puts it
    // where a test can see it, instead of handing back a token quietly missing its claims.
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkOSApiError(422, `JWT template could not be rendered: ${detail}`, 'unprocessable_entity');
  }
}
