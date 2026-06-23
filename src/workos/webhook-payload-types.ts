/**
 * Strict TypeScript types for webhook payloads
 * Generated from EVENT_DATA_REQUIREMENTS to provide type safety for webhook data
 */

import { EVENT_DATA_REQUIREMENTS } from './generated/events.js';

// Base webhook payload structure
export interface BaseWebhookPayload {
  id: string;
  event: string;
  data: Record<string, unknown>;
  created_at: string;
}

// Strict types for common webhook data structures
export interface UserEventData {
  object: 'user';
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  email_verified: boolean;
  profile_picture_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationEventData {
  object: 'organization';
  id: string;
  name: string;
  domains: Array<{ object: string; id: string; domain: string; state: string }>;
  metadata: Record<string, string>;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMembershipEventData {
  object: 'organization_membership';
  id: string;
  user_id: string;
  organization_id: string;
  role: { slug: string };
  status: 'active' | 'inactive' | 'pending';
  external_id: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface SessionEventData {
  object: 'session';
  id: string;
  user_id: string;
  organization_id: string | null;
  auth_method: 'oauth' | 'password' | 'magic_auth' | 'email_verification' | 'mfa' | 'sso';
  status: 'active' | 'revoked';
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface AuthenticationEventData {
  type: 'oauth' | 'password' | 'magic_auth' | 'email_verification' | 'mfa' | 'sso';
  status: 'succeeded' | 'failed';
  user_id: string | null;
  email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  error?: {
    code: string;
    message: string;
  };
  sso?: {
    organization_id: string | null;
    connection_id: string | null;
    session_id: string | null;
  };
}

export interface ConnectionEventData {
  object: 'connection';
  id: string;
  organization_id: string;
  connection_type: string;
  name: string;
  state: 'active' | 'inactive' | 'validating';
  domains: Array<{ object: string; id: string; domain: string }>;
  created_at: string;
  updated_at: string;
}

export interface MagicAuthEventData {
  object: 'magic_auth';
  id: string;
  user_id: string | null;
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
}

export interface PasswordResetEventData {
  object: 'password_reset';
  id: string;
  user_id: string;
  email: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export interface EmailVerificationEventData {
  object: 'email_verification';
  id: string;
  user_id: string;
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
}

// Type guards for webhook data validation
export function isUserEventData(data: unknown): data is UserEventData {
  const d = data as Record<string, unknown>;
  return (
    typeof d === 'object' &&
    d !== null &&
    d.object === 'user' &&
    typeof d.id === 'string' &&
    typeof d.email === 'string' &&
    typeof d.created_at === 'string'
  );
}

export function isOrganizationEventData(data: unknown): data is OrganizationEventData {
  const d = data as Record<string, unknown>;
  return (
    typeof d === 'object' &&
    d !== null &&
    d.object === 'organization' &&
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.created_at === 'string'
  );
}

export function isAuthenticationEventData(data: unknown): data is AuthenticationEventData {
  const d = data as Record<string, unknown>;
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof d.type === 'string' &&
    typeof d.status === 'string' &&
    (d.status === 'succeeded' || d.status === 'failed')
  );
}

export function isSessionEventData(data: unknown): data is SessionEventData {
  const d = data as Record<string, unknown>;
  return (
    typeof d === 'object' &&
    d !== null &&
    d.object === 'session' &&
    typeof d.id === 'string' &&
    typeof d.user_id === 'string' &&
    typeof d.created_at === 'string'
  );
}

// Event-specific webhook payload types
export type UserCreatedWebhook = BaseWebhookPayload & { data: UserEventData };
export type UserUpdatedWebhook = BaseWebhookPayload & { data: UserEventData };
export type UserDeletedWebhook = BaseWebhookPayload & { data: UserEventData };

export type OrganizationCreatedWebhook = BaseWebhookPayload & { data: OrganizationEventData };
export type OrganizationUpdatedWebhook = BaseWebhookPayload & { data: OrganizationEventData };
export type OrganizationDeletedWebhook = BaseWebhookPayload & { data: OrganizationEventData };

export type AuthenticationSucceededWebhook = BaseWebhookPayload & { data: AuthenticationEventData };
export type AuthenticationFailedWebhook = BaseWebhookPayload & { data: AuthenticationEventData };

export type SessionCreatedWebhook = BaseWebhookPayload & { data: SessionEventData };
export type SessionRevokedWebhook = BaseWebhookPayload & { data: SessionEventData };

export type MagicAuthCreatedWebhook = BaseWebhookPayload & { data: MagicAuthEventData };
export type PasswordResetCreatedWebhook = BaseWebhookPayload & { data: PasswordResetEventData };
export type EmailVerificationCreatedWebhook = BaseWebhookPayload & { data: EmailVerificationEventData };

// Helper function to validate webhook payload against event requirements
export function validateWebhookPayload(
  event: string,
  data: Record<string, unknown>
): { valid: boolean; missingFields: string[] } {
  const requirements = EVENT_DATA_REQUIREMENTS[event as keyof typeof EVENT_DATA_REQUIREMENTS];
  if (!requirements) {
    return { valid: false, missingFields: [`Unknown event: ${event}`] };
  }

  const missingFields: string[] = [];
  for (const field of requirements.required) {
    if (!(field in data) || data[field] === null || data[field] === undefined) {
      missingFields.push(field);
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

// Type-safe webhook payload creator
export function createWebhookPayload<T extends Record<string, unknown>>(
  event: string,
  data: T
): BaseWebhookPayload & { data: T } {
  const validation = validateWebhookPayload(event, data);
  if (!validation.valid) {
    throw new Error(
      `Invalid webhook payload for event ${event}. Missing fields: ${validation.missingFields.join(', ')}`
    );
  }

  return {
    id: crypto.randomUUID(),
    event,
    data,
    created_at: new Date().toISOString(),
  };
}