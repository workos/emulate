import { randomInt } from 'node:crypto';
import { unprocessableEntity, validationFailed } from '../core/index.js';
import { COMMON_CONSUMER_DOMAINS } from './consumer-domains.js';
import type { WorkOSOrganizationDomain } from './entities.js';
import type { WorkOSStore } from './store.js';

/**
 * The states `domain_data` may declare. Production's DTO refuses `legacy_verified` and `failed`
 * on input: those are states a domain reaches, never ones a caller sets.
 */
export const INITIAL_DOMAIN_STATES = ['pending', 'verified'] as const;
export type InitialDomainState = (typeof INITIAL_DOMAIN_STATES)[number];

export interface DomainDataEntry {
  domain: string;
  state: InitialDomainState;
}

/** Production's `normalizeDomain`: a domain is stored and compared trimmed and lowercased. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Production validates a domain with `is-valid-domain@0.1.6` under `{ subdomain: true }`; this is
 * that check ported rather than depended on (the package loads Node's deprecated `punycode`).
 * A domain is at most 253 characters of letters, digits, hyphens, underscores and dots, with at
 * least two labels; each label is under 64 characters and neither starts nor ends with a hyphen;
 * the TLD is not all digits; the registrable label (the one before the TLD) allows no underscore
 * and no `--` other than an IDN `xn--` prefix. Internationalized names must arrive in that
 * punycode form: production never passes `allowUnicode`, so `bücher.de` is refused and
 * `xn--bcher-kva.de` accepted.
 *
 * One divergence: the package also knows public second-level suffixes (`co.uk`), so it holds
 * `foo` in `foo.co.uk` to the registrable-label rules, whereas this port holds `co` to them. An
 * underscore or stray `--` in such a label passes here and fails in production.
 */
export function isValidDomain(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let domain = value.toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  if (domain.length > 253) return false;
  if (!/^[฀-๿a-z0-9\-._*]+$/.test(domain)) return false;

  const labels = domain.split('.');
  if (labels.length <= 1) return false;
  const tld = labels.pop()!;
  if (!/^(?:xn--)?(?!^\d+$)[฀-๿a-z0-9]+$/i.test(tld)) return false;

  return labels.every((label, index) => {
    const registrable = index === labels.length - 1;
    if (registrable) {
      const doubleDashes = (label.match(/--(--)?/g) ?? []).length;
      const idnPrefixes = (label.match(/xn--/g) ?? []).length;
      if (doubleDashes !== idnPrefixes) return false;
    }
    const chars = registrable ? /^[฀-๿a-zA-Z0-9-]+$/ : /^[฀-๿a-zA-Z0-9\-_]+$/;
    return chars.test(label) && label.length < 64 && !label.startsWith('-') && !label.endsWith('-');
  });
}

/** Production's `isCommonConsumerDomain`: membership in its public consumer-mail list. */
export function isCommonConsumerDomain(domain: string): boolean {
  return COMMON_CONSUMER_DOMAINS.has(normalizeDomain(domain));
}

/**
 * Production's `ensureNoConsumerDomains`: the first consumer domain among those about to be
 * attached is refused with the organization routes' 422.
 */
export function rejectConsumerDomains(domains: string[]): void {
  const consumer = domains.find(isCommonConsumerDomain);
  if (consumer) {
    throw unprocessableEntity(
      `The domain ${consumer} is a public consumer domain and cannot be attached to an organization.`,
    );
  }
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The token production mints when DNS verification starts: `generateToken('base62', 25)`. */
export function generateDomainVerificationToken(): string {
  let token = '';
  for (let i = 0; i < 25; i++) token += BASE62[randomInt(BASE62.length)];
  return token;
}

/**
 * The `{ field, code }` errors production's validation pipe reports for a `domain_data` list, or
 * none. `code` is the failed class-validator constraint's message, as production renders it:
 * `domain` must satisfy `isValidDomain`, and `state` is required (`IsNotEmpty` reports first
 * when it is missing, empty or null) and must be one of INITIAL_DOMAIN_STATES.
 */
export function domainDataValidationErrors(entries: unknown[]): Array<{ field: string; code: string }> {
  const errors: Array<{ field: string; code: string }> = [];
  entries.forEach((entry, index) => {
    const data = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (!isValidDomain(data.domain)) {
      errors.push({ field: `domain_data.${index}.domain`, code: 'domain must be valid domain name' });
    }
    if (data.state === undefined || data.state === null || data.state === '') {
      errors.push({ field: `domain_data.${index}.state`, code: 'state should not be empty' });
    } else if (!(INITIAL_DOMAIN_STATES as readonly unknown[]).includes(data.state)) {
      errors.push({
        field: `domain_data.${index}.state`,
        code: 'state must be one of the following values: pending, verified',
      });
    }
  });
  return errors;
}

/**
 * Reads `domain_data` off an organization create or update body the way production does: absent
 * (or not a list) leaves the domains untouched; otherwise every entry is validated — 422
 * `Validation failed` — and the list may not name a domain twice in any casing — 422
 * `` `domain_data` must contain unique domains `` — before anything is written. Entries come
 * back normalized.
 */
export function parseDomainData(body: Record<string, unknown>): DomainDataEntry[] | undefined {
  const raw = body.domain_data;
  if (!Array.isArray(raw)) return undefined;

  const errors = domainDataValidationErrors(raw);
  if (errors.length > 0) throw validationFailed(errors);

  const entries = (raw as DomainDataEntry[]).map(({ domain, state }) => ({ domain: normalizeDomain(domain), state }));
  if (new Set(entries.map((e) => e.domain)).size !== entries.length) {
    throw unprocessableEntity('`domain_data` must contain unique domains');
  }
  return entries;
}

/**
 * Inserts a domain the way production's `createMany` does for `domain_data` (and the seed loader
 * for seeds): a verified domain records the `manual` strategy; a pending one carries no strategy,
 * token or prefix until verification starts (`startDnsVerification`). Fires
 * `organization_domain.created`.
 */
export function insertOrganizationDomain(
  ws: WorkOSStore,
  organizationId: string,
  { domain, state }: DomainDataEntry,
): WorkOSOrganizationDomain {
  return ws.organizationDomains.insert({
    object: 'organization_domain',
    organization_id: organizationId,
    domain: normalizeDomain(domain),
    state,
    ...(state === 'verified' ? { verification_strategy: 'manual' as const } : {}),
  });
}

/**
 * Production's `DomainVerifier.initiateVerification`: the domain goes (or stays) pending under the
 * `dns` strategy with a fresh token, and `organization_domain.updated` fires. The verification
 * prefix is left as it was — the API passes none, so API-created domains never gain one. Nothing
 * resolves DNS afterwards: the emulator runs no verification cron, so the domain stays pending.
 */
export function startDnsVerification(ws: WorkOSStore, domain: WorkOSOrganizationDomain): WorkOSOrganizationDomain {
  return ws.organizationDomains.update(domain.id, {
    state: 'pending',
    verification_strategy: 'dns',
    verification_token: generateDomainVerificationToken(),
  })!;
}
