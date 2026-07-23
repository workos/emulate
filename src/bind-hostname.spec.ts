/**
 * Regression tests for the server bind address.
 *
 * The emulator exposes unauthenticated, token-minting and control endpoints on
 * the assumption that only the local machine can reach it. It must therefore
 * bind to loopback by default and only listen on other interfaces when the
 * operator explicitly opts in via `hostname`.
 */
import { networkInterfaces } from 'node:os';
import { describe, it, expect } from 'vitest';
import { createEmulator } from './index.js';

function firstNonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

function hasIPv6Loopback(): boolean {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv6' && addr.internal) return true;
    }
  }
  return false;
}

async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const externalIp = firstNonLoopbackIPv4();
const ipv6Loopback = hasIPv6Loopback();

describe('server bind address', () => {
  it('is reachable on loopback with the default hostname', async () => {
    const emulator = await createEmulator({ port: 0 });
    try {
      expect(await isReachable(`${emulator.url}/health`)).toBe(true);
      expect(await isReachable(`http://127.0.0.1:${emulator.port}/health`)).toBe(true);
    } finally {
      await emulator.close();
    }
  });

  // The advertised `localhost` URL may resolve to either family on dual-stack hosts,
  // so the default bind must also answer on IPv6 loopback where it's available.
  it.skipIf(!ipv6Loopback)('is reachable on IPv6 loopback with the default hostname', async () => {
    const emulator = await createEmulator({ port: 0 });
    try {
      expect(await isReachable(`http://[::1]:${emulator.port}/health`)).toBe(true);
    } finally {
      await emulator.close();
    }
  });

  it.skipIf(!externalIp)('does not listen on non-loopback interfaces by default', async () => {
    const emulator = await createEmulator({ port: 0 });
    try {
      expect(await isReachable(`http://${externalIp}:${emulator.port}/health`)).toBe(false);
    } finally {
      await emulator.close();
    }
  });

  it.skipIf(!externalIp)('listens on non-loopback interfaces when hostname is 0.0.0.0', async () => {
    const emulator = await createEmulator({ port: 0, hostname: '0.0.0.0' });
    try {
      expect(await isReachable(`http://${externalIp}:${emulator.port}/health`)).toBe(true);
    } finally {
      await emulator.close();
    }
  });
});
