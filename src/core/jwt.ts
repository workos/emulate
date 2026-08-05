import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

/** The claims the emulator itself resolves and mints. */
export interface JWTClaims {
  sub: string;
  sid?: string;
  org_id?: string;
  role?: string;
  /**
   * Every role the membership grants. Production emits `roles` alongside the singular
   * `role`, and the WorkOS SDKs read it; a token carrying only `role` passes locally and
   * loses the claim in production. The emulator models one role per membership, matching
   * what the `organization_membership` serializer already does.
   */
  roles?: string[];
  permissions?: string[];
  /**
   * OAuth scopes granted to an M2M (client_credentials) token: space-delimited,
   * per RFC 8693 §4.2 — the claim name and encoding production emits, and the one
   * the WorkOS SDKs read. Not an array, and not `scp`.
   */
  scope?: string;
  /** Unique token identifier. Required on M2M tokens by the WorkOS SDKs. */
  jti?: string;
  /** The OAuth client the token was minted for; production AuthKit includes it. */
  client_id?: string;
  /** Unix-seconds timestamp of the user's most recent active authentication. */
  auth_time?: number;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

/**
 * A decoded token: the minted claims, plus whatever else a JWT template added. The index
 * signature is what makes template claims readable off a verified token.
 */
export type JWTPayload = JWTClaims & { [claim: string]: unknown };

interface SignOptions {
  expiresIn?: number;
  /**
   * Extra claims to merge into the token, as rendered from a JWT template. Reserved
   * claims (`iss`, `sub`, `exp`, `iat`, `nbf`, `jti`) are dropped: the token's own identity
   * is not something a template gets to restate.
   */
  claims?: Record<string, unknown>;
}

export interface SigningKeyOptions {
  /**
   * PEM-encoded RSA private key to sign with. Omit and a fresh key is generated at
   * startup, which means a JWKS consumer must refetch after every restart. Pin it to keep
   * the JWKS — and therefore any token minted against it — stable across restarts.
   */
  privateKey?: string;
  /**
   * `kid` to advertise in the JWKS and in token headers. Defaults to a value derived from
   * the key itself, so a pinned key yields a stable `kid` without setting this.
   */
  kid?: string;
}

/** Claims a JWT template may not set; see RESERVED_JWT_CLAIMS in workos/jwt-template.ts. */
const TEMPLATE_RESERVED_CLAIMS = new Set(['iss', 'sub', 'exp', 'iat', 'nbf', 'jti']);

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Parse a pinned PEM private key, rejecting anything that cannot sign RS256 tokens with a
 * message that names the problem — a bad key is a config mistake worth failing loudly on.
 */
function loadPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid signing key: could not parse as a PEM private key (${detail})`);
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Invalid signing key: expected an RSA key (tokens are signed RS256), got ${key.asymmetricKeyType}`);
  }

  return key;
}

/** RFC 7638 JWK thumbprint, used to derive a `kid` that is stable for a given key. */
function jwkThumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { e?: string; kty?: string; n?: string };
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash('sha256').update(canonical).digest('base64url');
}

export class JWTManager {
  private privateKey: KeyObject;
  private publicKey: KeyObject;
  private kid: string;
  issuer: string;

  constructor(issuer = 'https://api.workos.com', signingKey?: SigningKeyOptions) {
    this.issuer = issuer;

    if (signingKey?.privateKey) {
      this.privateKey = loadPrivateKey(signingKey.privateKey);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    }

    // Derived from the key rather than the clock, so pinning the key pins the `kid` too.
    this.kid = signingKey?.kid ?? `workos_emulate_${jwkThumbprint(this.publicKey).slice(0, 16)}`;
  }

  sign(payload: Omit<JWTClaims, 'iss' | 'iat' | 'exp'>, options?: SignOptions): string {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = options?.expiresIn ?? 3600;

    const templateClaims: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options?.claims ?? {})) {
      if (TEMPLATE_RESERVED_CLAIMS.has(key)) continue;
      templateClaims[key] = value;
    }

    const fullPayload: JWTPayload = {
      ...payload,
      // Template claims win over the claims the emulator resolves, matching WorkOS: only the
      // reserved claims below are off-limits, so a template may deliberately restate `role`,
      // `permissions`, or `org_id`.
      ...templateClaims,
      iss: this.issuer,
      iat: now,
      exp: now + expiresIn,
    };

    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(fullPayload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.privateKey, 'base64url');

    return `${signingInput}.${signature}`;
  }

  verify(token: string): JWTPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signature] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    const valid = verifier.verify(this.publicKey, signature, 'base64url');

    if (!valid) {
      throw new Error('Invalid token signature');
    }

    const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8')) as JWTPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error('Token has expired');
    }

    return payload;
  }

  getJWKS(): { keys: Record<string, unknown>[] } {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return {
      keys: [
        {
          ...jwk,
          kid: this.kid,
          alg: 'RS256',
          use: 'sig',
        },
      ],
    };
  }

  getPublicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  }
}
