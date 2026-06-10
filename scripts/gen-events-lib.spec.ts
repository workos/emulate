import { describe, it, expect } from 'vitest';
import {
  type EventSchemaNode,
  eventConstantKey,
  parseEventCatalog,
  deriveAuthEventDataFields,
  generateEventsFile,
} from './gen-events-lib.js';

// ---------------------------------------------------------------------------
// Fixture: a miniature spec exercising every extraction path — the
// subscribable enum, inline data schemas, $ref data schemas, const
// type/status fields, and the failed-event error object.
// ---------------------------------------------------------------------------

const fixtureSpec: EventSchemaNode = {
  openapi: '3.1.0',
  components: {
    schemas: {
      CreateWebhookEndpointDto: {
        type: 'object',
        properties: {
          endpoint_url: { type: 'string' },
          events: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['user.created', 'authentication.password_succeeded', 'authentication.password_failed'],
            },
          },
        },
      },
      UserlandUser: {
        type: 'object',
        properties: {
          object: { const: 'user' },
          id: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['object', 'id', 'email'],
      },
      Event: {
        oneOf: [
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              event: { type: 'string', const: 'user.created' },
              data: { $ref: '#/components/schemas/UserlandUser' },
            },
          },
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              event: { type: 'string', const: 'authentication.password_succeeded' },
              data: {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'password' },
                  status: { type: 'string', const: 'succeeded' },
                  user_id: { type: ['string', 'null'] },
                  email: { type: 'string' },
                  ip_address: { type: ['string', 'null'] },
                  user_agent: { type: ['string', 'null'] },
                },
                required: ['type', 'status', 'user_id', 'email', 'ip_address', 'user_agent'],
              },
            },
          },
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              event: { type: 'string', const: 'authentication.password_failed' },
              data: {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'password' },
                  status: { type: 'string', const: 'failed' },
                  user_id: { type: ['string', 'null'] },
                  email: { type: ['string', 'null'] },
                  ip_address: { type: ['string', 'null'] },
                  user_agent: { type: ['string', 'null'] },
                  error: {
                    type: 'object',
                    properties: { code: { type: 'string' }, message: { type: 'string' } },
                    required: ['code', 'message'],
                  },
                },
                required: ['type', 'status', 'user_id', 'email', 'ip_address', 'user_agent', 'error'],
              },
            },
          },
        ],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// eventConstantKey
// ---------------------------------------------------------------------------

describe('eventConstantKey', () => {
  it('converts dotted snake_case event names to camelCase keys', () => {
    expect(eventConstantKey('user.created')).toBe('userCreated');
    expect(eventConstantKey('authentication.magic_auth_failed')).toBe('authenticationMagicAuthFailed');
    expect(eventConstantKey('dsync.group.user_added')).toBe('dsyncGroupUserAdded');
  });
});

// ---------------------------------------------------------------------------
// parseEventCatalog
// ---------------------------------------------------------------------------

describe('parseEventCatalog', () => {
  it('extracts subscribable names from CreateWebhookEndpointDto', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    expect(catalog.subscribable).toEqual([
      'authentication.password_failed',
      'authentication.password_succeeded',
      'user.created',
    ]);
  });

  it('throws a clear error when the subscribable enum is missing', () => {
    expect(() => parseEventCatalog({ components: { schemas: {} } })).toThrow(/CreateWebhookEndpointDto/);
  });

  it('finds event payload schemas anywhere in the spec tree', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    expect(catalog.events.map((e) => e.name)).toEqual([
      'authentication.password_failed',
      'authentication.password_succeeded',
      'user.created',
    ]);
  });

  it('resolves $ref data schemas for required fields', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    const userCreated = catalog.events.find((e) => e.name === 'user.created')!;
    expect(userCreated.dataRequired).toEqual(['object', 'id', 'email']);
  });

  it('captures const type and status from auth event data', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    const failed = catalog.events.find((e) => e.name === 'authentication.password_failed')!;
    expect(failed.dataType).toBe('password');
    expect(failed.dataStatus).toBe('failed');
    expect(failed.dataRequired).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// deriveAuthEventDataFields
// ---------------------------------------------------------------------------

describe('deriveAuthEventDataFields', () => {
  it('derives literal unions for const fields and merges nullability', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    const fields = deriveAuthEventDataFields(catalog.events);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    expect(byName.status.tsType).toBe("'failed' | 'succeeded'");
    expect(byName.type.tsType).toBe("'password'");
    // email is `string` on succeeded and `string | null` on failed → merged
    expect(byName.email.tsType).toBe('string | null');
    expect(byName.email.optional).toBe(false);
  });

  it('marks fields absent from some auth schemas as optional', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    const fields = deriveAuthEventDataFields(catalog.events);
    const error = fields.find((f) => f.name === 'error')!;
    expect(error.optional).toBe(true);
    expect(error.tsType).toBe('{ code: string; message: string }');
  });
});

// ---------------------------------------------------------------------------
// generateEventsFile
// ---------------------------------------------------------------------------

describe('generateEventsFile', () => {
  it('generates EVENTS constants, the subscribable list, and requirements', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    const output = generateEventsFile(catalog);

    expect(output).toContain("userCreated: 'user.created',");
    expect(output).toContain("authenticationPasswordFailed: 'authentication.password_failed',");
    expect(output).toContain('export type WorkOSEventName');
    expect(output).toContain('export const SUBSCRIBABLE_EVENTS');
    expect(output).toContain('export interface AuthenticationEventData');
    expect(output).toContain(
      "'authentication.password_failed': { type: 'password', status: 'failed', required: ['type', 'status', 'user_id', 'email', 'ip_address', 'user_agent', 'error'] },",
    );
  });

  it('is deterministic (same catalog → same output)', () => {
    const catalog = parseEventCatalog(fixtureSpec);
    expect(generateEventsFile(catalog)).toBe(generateEventsFile(catalog));
  });
});
