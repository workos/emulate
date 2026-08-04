import { describe, it, expect } from 'bun:test';
import {
  renderJwtTemplate,
  validateJwtTemplateContent,
  JwtTemplateError,
  MAX_RENDERED_CLAIMS_BYTES,
  type JwtTemplateContext,
} from './jwt-template.js';

const context: JwtTemplateContext = {
  user: {
    id: 'user_01ABC',
    email: 'alice@acme.com',
    first_name: 'Alice',
    last_name: null,
    email_verified: true,
    metadata: { tenant_id: 'tenant_123' },
  },
  organization: {
    id: 'org_01XYZ',
    name: 'Acme Corp',
    domains: [{ domain: 'acme.com' }, { domain: 'acme.dev' }],
    metadata: {},
  },
  organization_membership: {
    id: 'om_01DEF',
    role: 'admin',
    roles: ['admin'],
  },
};

const render = (content: string) => renderJwtTemplate(content, context);

describe('renderJwtTemplate', () => {
  it('interpolates a variable into a string claim', () => {
    expect(render('{"urn:myapp:email": "{{ user.email }}"}')).toEqual({
      'urn:myapp:email': 'alice@acme.com',
    });
  });

  it('concatenates several variables inside one string', () => {
    expect(render('{"name": "{{ user.first_name }} {{ user.last_name }}"}')).toEqual({ name: 'Alice ' });
  });

  it('falls back to the next alternative when a value is missing', () => {
    expect(render('{"n": "{{ user.nickname || user.email }}"}')).toEqual({ n: 'alice@acme.com' });
  });

  it('falls back to a single-quoted literal', () => {
    expect(render('{"n": "{{ user.nickname || \'anonymous\' }}"}')).toEqual({ n: 'anonymous' });
  });

  it('interpolates an object outside a string', () => {
    expect(render('{"meta": {{ user.metadata }}}')).toEqual({ meta: { tenant_id: 'tenant_123' } });
  });

  it('reads a nested path and an array index', () => {
    expect(render('{"t": "{{ user.metadata.tenant_id }}", "d": "{{ organization.domains.0.domain }}"}')).toEqual({
      t: 'tenant_123',
      d: 'acme.com',
    });
  });

  it('preserves non-string JSON types', () => {
    expect(render('{"verified": {{ user.email_verified }}, "roles": {{ organization_membership.roles }}}')).toEqual({
      verified: true,
      roles: ['admin'],
    });
  });

  it('drops top-level null claims', () => {
    expect(render('{"kept": "{{ user.email }}", "dropped": {{ user.last_name }}}')).toEqual({
      kept: 'alice@acme.com',
    });
  });

  it('escapes interpolated values that would break the JSON', () => {
    const quoted: JwtTemplateContext = { user: { first_name: 'A"B\\C' } };
    expect(renderJwtTemplate('{"n": "{{ user.first_name }}"}', quoted)).toEqual({ n: 'A"B\\C' });
  });

  it('drops reserved claims as a backstop', () => {
    expect(render('{"sub": "spoofed", "keep": "{{ user.id }}"}')).toEqual({ keep: 'user_01ABC' });
  });

  it('resolves an unmodelled path below a known root to null', () => {
    expect(render('{"x": "{{ organization.allow_profiles_outside_organization || \'unset\' }}"}')).toEqual({
      x: 'unset',
    });
  });

  it('throws on an unknown root variable', () => {
    expect(() => render('{"x": "{{ usr.email }}"}')).toThrow(JwtTemplateError);
  });

  it('throws on an unterminated expression', () => {
    expect(() => render('{"x": "{{ user.email"}')).toThrow('unterminated `{{` expression');
  });

  it('throws when the result is not a JSON object', () => {
    expect(() => render('["{{ user.email }}"]')).toThrow('must render to a JSON object');
  });

  it('throws when the rendered claims exceed the byte limit', () => {
    const big: JwtTemplateContext = { user: { first_name: 'x'.repeat(MAX_RENDERED_CLAIMS_BYTES) } };
    expect(() => renderJwtTemplate('{"big": "{{ user.first_name }}"}', big)).toThrow('over the 3072-byte limit');
  });
});

describe('validateJwtTemplateContent', () => {
  it('accepts a well-formed template', () => {
    expect(validateJwtTemplateContent('{"urn:myapp:email": "{{ user.email }}"}')).toEqual([]);
  });

  it('requires a non-empty string', () => {
    expect(validateJwtTemplateContent(undefined)[0]).toContain('content is required');
    expect(validateJwtTemplateContent('   ')[0]).toContain('content is required');
  });

  it('rejects reserved claims, naming each one', () => {
    expect(validateJwtTemplateContent('{"iat": 1, "jti": "x"}')[0]).toContain('reserved claims: iat, jti');
  });

  // Null-valued claims are stripped before signing, so the reserved check has to look at the
  // template's keys — otherwise `{"sub": null}` would slip past it.
  it('rejects a reserved claim whose value renders to null', () => {
    expect(validateJwtTemplateContent('{"sub": {{ user.nickname }}}')[0]).toContain('reserved claims: sub');
  });

  it('rejects an empty object', () => {
    expect(validateJwtTemplateContent('{}')[0]).toContain('at least one key');
  });

  it('rejects an unknown variable', () => {
    expect(validateJwtTemplateContent('{"x": "{{ nope.field }}"}')[0]).toContain('unknown template variable `nope`');
  });
});
