import { describe, expect, it, setSystemTime } from 'bun:test';
import { runCli, withCli } from './cli.test-utils.js';
import { createEmulator, type Emulator } from './index.js';

async function request(emulator: Emulator, apiKey = emulator.apiKey): Promise<Response> {
  const response = await fetch(`${emulator.url}/organizations`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  await response.text();
  return response;
}

describe('request budgets', () => {
  it('accepts the full default budget before throttling', async () => {
    const emulator = await createEmulator({ port: 0 });
    try {
      for (let count = 1; count <= 1000; count++) {
        const response = await request(emulator);
        expect(response.status).toBe(200);
        expect(response.headers.get('X-RateLimit-Limit')).toBe('1000');
        expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(1000 - count));
        expect(response.headers.get('Retry-After')).toBeNull();
      }
      const response = await request(emulator);
      expect(response.status).toBe(429);
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    } finally {
      await emulator.close();
    }
  });

  it.each([1, 3])('accepts exactly %s requests per API key before throttling', async (requestsPerMinute) => {
    const emulator = await createEmulator({
      port: 0,
      requestsPerMinute,
      seed: {
        apiKeys: {
          sk_test_first: { environment: 'test' },
          sk_test_second: { environment: 'test' },
        },
      },
    });
    try {
      for (let count = 1; count <= requestsPerMinute; count++) {
        const response = await request(emulator, 'sk_test_first');
        expect(response.status).toBe(200);
        expect(response.headers.get('X-RateLimit-Limit')).toBe(String(requestsPerMinute));
        expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(requestsPerMinute - count));
        expect(response.headers.get('Retry-After')).toBeNull();
      }
      const exhausted = await request(emulator, 'sk_test_first');
      expect(exhausted.status).toBe(429);
      expect(exhausted.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(Number(exhausted.headers.get('Retry-After'))).toBeGreaterThan(0);
      const stillExhausted = await request(emulator, 'sk_test_first');
      expect(stillExhausted.status).toBe(429);
      expect(stillExhausted.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(stillExhausted.headers.get('X-RateLimit-Reset')).toBe(exhausted.headers.get('X-RateLimit-Reset'));
      const independent = await request(emulator, 'sk_test_second');
      expect(independent.status).toBe(200);
      expect(independent.headers.get('X-RateLimit-Remaining')).toBe(String(requestsPerMinute - 1));
    } finally {
      await emulator.close();
    }
  });

  it('replenishes the budget when the 60-second window expires', async () => {
    const now = Date.UTC(2026, 0, 1);
    setSystemTime(now);
    let emulator: Emulator | undefined;
    try {
      emulator = await createEmulator({ port: 0, requestsPerMinute: 1 });
      const first = await request(emulator);
      expect(first.status).toBe(200);
      expect(first.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(first.headers.get('X-RateLimit-Reset')).toBe(String(now / 1000 + 60));

      setSystemTime(now + 59_000);
      const exhausted = await request(emulator);
      expect(exhausted.status).toBe(429);
      expect(exhausted.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(exhausted.headers.get('X-RateLimit-Reset')).toBe(first.headers.get('X-RateLimit-Reset'));
      expect(exhausted.headers.get('Retry-After')).toBe('1');

      setSystemTime(now + 60_000);
      const replenished = await request(emulator);
      expect(replenished.status).toBe(200);
      expect(replenished.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(replenished.headers.get('X-RateLimit-Reset')).toBe(String(now / 1000 + 120));
      expect(replenished.headers.get('Retry-After')).toBeNull();
      expect((await request(emulator)).status).toBe(429);
    } finally {
      if (emulator) await emulator.close();
      setSystemTime();
    }
  });

  it('allows integration suites to exceed the default budget', async () => {
    const emulator = await createEmulator({ port: 0, requestsPerMinute: 10_000 });
    try {
      for (let count = 0; count < 1000; count++) {
        const response = await request(emulator);
        expect(response.status).toBe(200);
      }
      const response = await request(emulator);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('10000');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('8999');
    } finally {
      await emulator.close();
    }
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid request budget %s before starting the server',
    async (requestsPerMinute) => {
      await expect(createEmulator({ port: 0, requestsPerMinute })).rejects.toThrow(
        'requestsPerMinute must be a positive safe integer',
      );
    },
  );

  // Public paths carry no API key, so they are counted against one shared anonymous budget
  // rather than against whichever key happens to be in use.
  it('budgets anonymous requests separately from API keys', async () => {
    const emulator = await createEmulator({ port: 0, requestsPerMinute: 1 });
    try {
      const health = async () => {
        const response = await fetch(`${emulator.url}/health`);
        await response.text();
        return response.status;
      };
      expect(await health()).toBe(200);
      expect(await health()).toBe(429);
      expect((await request(emulator)).status).toBe(200);
    } finally {
      await emulator.close();
    }
  });
});

/**
 * The flag and the environment variable are how a shell or a compose file reaches the budget.
 * Nothing above goes through the CLI, which parses and validates the value and prefers the flag
 * over the environment before createEmulator ever sees a number.
 */
describe('--requests-per-minute / WORKOS_EMULATE_REQUESTS_PER_MINUTE', () => {
  /** Status codes of `count` back-to-back authenticated requests. */
  async function statuses(startup: { url: string; apiKey: string }, count: number): Promise<number[]> {
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const response = await fetch(`${startup.url}/organizations`, {
        headers: { Authorization: `Bearer ${startup.apiKey}` },
      });
      await response.text();
      result.push(response.status);
    }
    return result;
  }

  it('reads the flag, in both forms', async () => {
    await withCli(['--requests-per-minute', '2'], {}, async (startup) => {
      expect(await statuses(startup, 3)).toEqual([200, 200, 429]);
    });
    await withCli(['--requests-per-minute=1'], {}, async (startup) => {
      expect(await statuses(startup, 2)).toEqual([200, 429]);
    });
  }, 20000);

  it('reads the environment variable', async () => {
    await withCli([], { WORKOS_EMULATE_REQUESTS_PER_MINUTE: '2' }, async (startup) => {
      expect(await statuses(startup, 3)).toEqual([200, 200, 429]);
    });
  }, 20000);

  it('prefers the flag over the environment', async () => {
    await withCli(['--requests-per-minute', '1'], { WORKOS_EMULATE_REQUESTS_PER_MINUTE: '5' }, async (startup) => {
      expect(await statuses(startup, 2)).toEqual([200, 429]);
    });
  }, 20000);

  it.each(['0', '-1', 'abc', '1.5'])(
    'exits rather than start with --requests-per-minute %s',
    async (value) => {
      const { exitCode, stderr } = await runCli(['--requests-per-minute', value]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`Invalid --requests-per-minute: ${value}`);
    },
    20000,
  );

  it('exits rather than start with an invalid environment value', async () => {
    const { exitCode, stderr } = await runCli([], { WORKOS_EMULATE_REQUESTS_PER_MINUTE: '0' });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid WORKOS_EMULATE_REQUESTS_PER_MINUTE: 0');
  }, 20000);

  it('requires a value', async () => {
    const { exitCode, stderr } = await runCli(['--requests-per-minute']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--requests-per-minute requires a value');
  }, 20000);
});
