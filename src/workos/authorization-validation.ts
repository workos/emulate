import { validationFailed } from '../core/index.js';

/**
 * Request-body validation for the authorization routes, reported the way production's
 * class-validator pipe reports it: a 422 "Validation failed" carrying one entry per failing
 * field, whose `code` is the message of the first constraint that failed. Unknown properties
 * come first (the pipe whitelists before it validates), then the DTO's fields in declaration
 * order. Production decorates each DTO property bottom-up, so a field's constraints run in
 * the reverse of the decorator stack in the monorepo; the rule sets below list them in that
 * run order.
 */

/** Returns the constraint's message when `value` fails it. */
export type Constraint = (value: unknown, field: string) => string | undefined;

export interface FieldRule {
  /**
   * When the field is checked: `always` for a required field (checked even when absent),
   * `defined` for one checked whenever it is sent, null included (class-validator's
   * `ValidateIf(v => v !== undefined)`), `present` for one skipped when absent or null
   * (`IsOptional`).
   */
  when: 'always' | 'defined' | 'present';
  constraints: readonly Constraint[];
}

export interface BodyRules {
  fields: Record<string, FieldRule>;
  /** Reject properties the DTO does not declare, as `forbidNonWhitelisted` does. */
  forbidUnknown: boolean;
}

export const notEmpty: Constraint = (value, field) =>
  value === undefined || value === null || value === '' ? `${field} should not be empty` : undefined;

export const isString: Constraint = (value, field) =>
  typeof value === 'string' ? undefined : `${field} must be a string`;

/**
 * class-validator's MaxLength counts a surrogate pair as one character (validator.js
 * `isLength`), so an astral character such as an emoji counts once, as it does in production.
 */
export const maxLength =
  (max: number): Constraint =>
  (value, field) =>
    typeof value === 'string' && Array.from(value).length <= max
      ? undefined
      : `${field} cannot be more than ${max} characters`;

export const matches =
  (pattern: RegExp, message: string): Constraint =>
  (value) =>
    typeof value === 'string' && pattern.test(value) ? undefined : message;

export const ascii: Constraint = (value, field) =>
  // eslint-disable-next-line no-control-regex
  typeof value === 'string' && /^[\x00-\x7F]*$/.test(value) ? undefined : `${field} must contain only ASCII characters`;

export const isArray: Constraint = (value, field) => (Array.isArray(value) ? undefined : `${field} must be an array`);

/** `IsString({ each: true })`: class-validator only inspects the elements of an array. */
export const eachString: Constraint = (value, field) =>
  Array.isArray(value) && value.some((item) => typeof item !== 'string')
    ? `each value in ${field} must be a string`
    : undefined;

export const arrayMinSize =
  (min: number): Constraint =>
  (value, field) =>
    Array.isArray(value) && value.length >= min ? undefined : `${field} must contain at least ${min} elements`;

/** `IsNotEmpty` + `IsString` + the rest: a field production marks required. */
export const required = (...constraints: Constraint[]): FieldRule => ({
  when: 'always',
  constraints: [notEmpty, isString, ...constraints],
});

/** `IsOptional` + `IsString` + the rest: absent or null passes untouched. */
export const optional = (...constraints: Constraint[]): FieldRule => ({
  when: 'present',
  constraints: [isString, ...constraints],
});

/** `IsOptional` + `IsNotEmpty` + `IsString`: absent or null passes, an empty string does not. */
export const optionalNonEmpty = (...constraints: Constraint[]): FieldRule => ({
  when: 'present',
  constraints: [notEmpty, isString, ...constraints],
});

export function validateBody(body: Record<string, unknown>, rules: BodyRules): void {
  const errors: Array<{ field: string; code: string }> = [];

  if (rules.forbidUnknown) {
    for (const key of Object.keys(body)) {
      if (!Object.hasOwn(rules.fields, key)) {
        errors.push({ field: key, code: `property ${key} should not exist` });
      }
    }
  }

  for (const [field, rule] of Object.entries(rules.fields)) {
    const value = body[field];
    if (rule.when === 'present' && (value === undefined || value === null)) continue;
    if (rule.when === 'defined' && value === undefined) continue;
    for (const constraint of rule.constraints) {
      const code = constraint(value, field);
      if (code !== undefined) {
        errors.push({ field, code });
        break;
      }
    }
  }

  if (errors.length > 0) {
    throw validationFailed(errors);
  }
}

// ---------------------------------------------------------------------------
// Slugs and lengths: packages/api/src/constants.ts and common/validators in the monorepo.
// ---------------------------------------------------------------------------

export const MAX_SLUG_LENGTH = 48;
export const MAX_NAME_LENGTH = 48;
export const MAX_DESCRIPTION_LENGTH = 150;
export const MAX_RESOURCE_EXTERNAL_ID_LENGTH = 128;

export const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const ORGANIZATION_ROLE_SLUG_PATTERN = /^org-[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const PERMISSION_SLUG_PATTERN = /^[a-z0-9*]+(?:[-_.:][a-z0-9*]+)*$/;

export const SLUG_MESSAGE =
  'Slug must contain only lowercase letters, numbers, hyphens and underscores, and cannot have leading, trailing, or consecutive separators.';
export const ORGANIZATION_ROLE_SLUG_MESSAGE =
  "Slug must be prefixed with 'org-', contain only lowercase letters, numbers, hyphens and underscores, and cannot have leading, trailing, or consecutive separators.";
export const PERMISSION_SLUG_MESSAGE =
  'Slug must contain only lowercase letters, numbers, hyphens, underscores, colons, periods, and asterisks, and cannot have leading, trailing, or consecutive separators.';

const slug = matches(SLUG_PATTERN, SLUG_MESSAGE);
const organizationRoleSlug = matches(ORGANIZATION_ROLE_SLUG_PATTERN, ORGANIZATION_ROLE_SLUG_MESSAGE);
const permissionSlug = matches(PERMISSION_SLUG_PATTERN, PERMISSION_SLUG_MESSAGE);

const name = required(maxLength(MAX_NAME_LENGTH));
const description = optional(maxLength(MAX_DESCRIPTION_LENGTH));
const resourceTypeSlug = optional(slug, maxLength(MAX_SLUG_LENGTH));

// ---------------------------------------------------------------------------
// Roles: authorization-roles/dto and authorization-organization-roles/dto.
// ---------------------------------------------------------------------------

export const ROLE_CREATE_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    slug: required(slug, maxLength(MAX_SLUG_LENGTH)),
    name,
    description,
    resource_type_slug: resourceTypeSlug,
  },
};

/**
 * An organization role's slug is optional (one is generated from the name when omitted)
 * but must carry the `org-` prefix when given; the create route runs a plain
 * `ValidationPipe()` with no whitelist, so unknown properties are ignored, not refused.
 */
export const ORGANIZATION_ROLE_CREATE_RULES: BodyRules = {
  forbidUnknown: false,
  fields: {
    slug: {
      when: 'defined',
      constraints: [notEmpty, isString, organizationRoleSlug, maxLength(MAX_SLUG_LENGTH)],
    },
    name,
    description,
    resource_type_slug: resourceTypeSlug,
  },
};

/** Shared by environment and organization roles: only name and description are updatable. */
export const ROLE_UPDATE_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    name: optionalNonEmpty(maxLength(MAX_NAME_LENGTH)),
    description,
  },
};

/** `PUT .../permissions`: set-role-permissions.dto.ts. */
export const ROLE_PERMISSIONS_SET_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    permissions: { when: 'always', constraints: [eachString, isArray] },
  },
};

/** `POST .../permissions`: add-role-permission.dto.ts. */
export const ROLE_PERMISSION_ADD_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    slug: required(),
  },
};

/** `PUT .../roles/priority`: update-organization-role-priority-order.dto.ts, no whitelist. */
export const ROLE_PRIORITY_ORDER_RULES: BodyRules = {
  forbidUnknown: false,
  fields: {
    role_priority_order: { when: 'always', constraints: [arrayMinSize(1), isArray, eachString] },
  },
};

// ---------------------------------------------------------------------------
// Permissions: authorization-permissions/types.
// ---------------------------------------------------------------------------

export const PERMISSION_CREATE_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    slug: required(permissionSlug, maxLength(MAX_SLUG_LENGTH)),
    name,
    description,
    resource_type_slug: resourceTypeSlug,
  },
};

export const PERMISSION_UPDATE_RULES: BodyRules = ROLE_UPDATE_RULES;

// ---------------------------------------------------------------------------
// Resources: authorization-resources/dto. The parent fields are whitelisted here and
// resolved against each other by the route, which owns their cross-field rules.
// ---------------------------------------------------------------------------

const parentField: FieldRule = { when: 'present', constraints: [isString] };

export const RESOURCE_CREATE_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    external_id: required(maxLength(MAX_RESOURCE_EXTERNAL_ID_LENGTH), ascii),
    name,
    description,
    resource_type_slug: required(),
    organization_id: required(),
    parent_resource_id: parentField,
    parent_resource_external_id: parentField,
    parent_resource_type_slug: parentField,
  },
};

export const RESOURCE_UPDATE_RULES: BodyRules = {
  forbidUnknown: true,
  fields: {
    name: optional(maxLength(MAX_NAME_LENGTH)),
    description,
    parent_resource_id: parentField,
    parent_resource_external_id: parentField,
    parent_resource_type_slug: parentField,
  },
};

/** The query of the memberships-for-resource routes: list-organization-memberships-for-resource.dto.ts. */
export const RESOURCE_MEMBERSHIPS_QUERY_RULES: BodyRules = {
  forbidUnknown: false,
  fields: {
    permission_slug: required(),
  },
};
