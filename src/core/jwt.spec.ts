import { describe, it, expect, beforeEach, setSystemTime, afterEach } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { JWTManager } from './jwt.js';

describe('JWTManager', () => {
  let jwt: JWTManager;

  beforeEach(() => {
    jwt = new JWTManager('https://api.workos.test');
  });

  afterEach(() => {
    setSystemTime();
  });

  it('signs a token and verifies it', () => {
    const token = jwt.sign({
      sub: 'user_01ABC',
      aud: 'client_01XYZ',
      sid: 'session_01DEF',
      org_id: 'org_01GHI',
    });

    expect(token).toMatch(/^eyJ/);
    expect(token.split('.')).toHaveLength(3);

    const payload = jwt.verify(token);
    expect(payload.sub).toBe('user_01ABC');
    expect(payload.aud).toBe('client_01XYZ');
    expect(payload.sid).toBe('session_01DEF');
    expect(payload.org_id).toBe('org_01GHI');
    expect(payload.iss).toBe('https://api.workos.test');
    expect(payload.exp).toBe(payload.iat + 3600);
  });

  it('strips a trailing slash from the issuer, however it was set', () => {
    // `authKitIssuer` concatenates, so a trailing slash would mint
    // `https://api.workos.com//user_management/client_01XYZ` — a URL production never emits and
    // no verifier is comparing against. Easy to hand it one from a compose file or an env var.
    const pinned = new JWTManager('https://api.workos.com/');
    expect(pinned.issuer).toBe('https://api.workos.com');
    expect(pinned.authKitIssuer('client_01XYZ')).toBe('https://api.workos.com/user_management/client_01XYZ');

    // createEmulator reassigns it after listen() resolves an ephemeral port; that path normalizes too.
    pinned.issuer = 'https://api.workos.com//';
    expect(pinned.authKitIssuer('client_01XYZ')).toBe('https://api.workos.com/user_management/client_01XYZ');
  });

  it('preserves optional fields like role and permissions', () => {
    const token = jwt.sign({
      sub: 'user_01ABC',
      aud: 'client_01XYZ',
      role: 'admin',
      permissions: ['read', 'write'],
    });

    const payload = jwt.verify(token);
    expect(payload.role).toBe('admin');
    expect(payload.permissions).toEqual(['read', 'write']);
  });

  it('supports custom expiration', () => {
    const token = jwt.sign({ sub: 'user_01ABC', aud: 'client_01XYZ' }, { expiresIn: 300 });
    const payload = jwt.verify(token);
    expect(payload.exp).toBe(payload.iat + 300);
  });

  it('throws on expired token', () => {
    setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const token = jwt.sign({ sub: 'user_01ABC', aud: 'client_01XYZ' }, { expiresIn: 60 });

    setSystemTime(new Date('2020-01-01T00:02:00Z'));
    expect(() => jwt.verify(token)).toThrow('Token has expired');
  });

  it('throws on tampered token', () => {
    const token = jwt.sign({ sub: 'user_01ABC', aud: 'client_01XYZ' });
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'hacker' })).toString('base64url');
    expect(() => jwt.verify(parts.join('.'))).toThrow('Invalid token signature');
  });

  it('a different JWTManager cannot verify the token', () => {
    const token = jwt.sign({ sub: 'user_01ABC', aud: 'client_01XYZ' });
    const otherJwt = new JWTManager();
    expect(() => otherJwt.verify(token)).toThrow('Invalid token signature');
  });

  it('returns JWKS with correct structure', () => {
    const jwks = jwt.getJWKS();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.use).toBe('sig');
    expect(key.kid).toBeDefined();
  });

  it('returns a PEM-encoded public key', () => {
    const pem = jwt.getPublicKeyPem();
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
  });

  describe('template claims', () => {
    it('merges claims into the token', () => {
      const token = jwt.sign(
        { sub: 'user_01ABC', aud: 'client_01XYZ' },
        { claims: { 'urn:myapp:tenant': 'tenant_123', 'urn:myapp:seats': 5 } },
      );
      const payload = jwt.verify(token);
      expect(payload['urn:myapp:tenant']).toBe('tenant_123');
      expect(payload['urn:myapp:seats']).toBe(5);
    });

    it('lets a claim override a resolved, non-reserved claim', () => {
      const token = jwt.sign({ sub: 'user_01ABC', aud: 'client_01XYZ', role: 'member' }, { claims: { role: 'admin' } });
      expect(jwt.verify(token).role).toBe('admin');
    });

    it('never lets a claim override the token identity', () => {
      const token = jwt.sign(
        { sub: 'user_01ABC', aud: 'client_01XYZ' },
        { claims: { sub: 'user_01SPOOFED', iss: 'https://evil.test', exp: 1, iat: 1, jti: 'x', nbf: 1 } },
      );
      const payload = jwt.verify(token);
      expect(payload.sub).toBe('user_01ABC');
      expect(payload.iss).toBe('https://api.workos.test');
      expect(payload.jti).toBeUndefined();
      expect(payload.nbf).toBeUndefined();
      expect(payload.exp).toBe(payload.iat + 3600);
    });
  });

  describe('pinned signing key', () => {
    // A fresh keypair per run, so the fixture is never a checked-in private key.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    it('survives a restart: a new manager verifies the old token', () => {
      const before = new JWTManager('https://api.workos.test', { privateKey: pem });
      const token = before.sign({ sub: 'user_01ABC', aud: 'client_01XYZ' });

      const after = new JWTManager('https://api.workos.test', { privateKey: pem });
      expect(after.verify(token).sub).toBe('user_01ABC');
    });

    it('publishes the same JWKS and kid for the same key', () => {
      const a = new JWTManager('https://api.workos.test', { privateKey: pem });
      const b = new JWTManager('https://api.workos.test', { privateKey: pem });
      expect(a.getJWKS()).toEqual(b.getJWKS());
    });

    it('derives a different kid for a different key', () => {
      const other = new JWTManager('https://api.workos.test');
      expect(other.getJWKS().keys[0].kid).not.toBe(
        new JWTManager('https://api.workos.test', { privateKey: pem }).getJWKS().keys[0].kid,
      );
    });

    it('honors an explicit kid in the JWKS and the token header', () => {
      const pinned = new JWTManager('https://api.workos.test', { privateKey: pem, kid: 'my_kid' });
      expect(pinned.getJWKS().keys[0].kid).toBe('my_kid');

      const header = JSON.parse(
        Buffer.from(pinned.sign({ sub: 'user_01ABC', aud: 'c' }).split('.')[0], 'base64url').toString('utf-8'),
      );
      expect(header.kid).toBe('my_kid');
    });

    it('rejects a key that is not a PEM private key', () => {
      expect(() => new JWTManager('https://api.workos.test', { privateKey: 'not a key' })).toThrow(
        'could not parse as a PEM private key',
      );
    });

    it('rejects a non-RSA key, since tokens are signed RS256', () => {
      const ed25519 = generateKeyPairSync('ed25519').privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }) as string;
      expect(() => new JWTManager('https://api.workos.test', { privateKey: ed25519 })).toThrow('expected an RSA key');
    });
  });
});
