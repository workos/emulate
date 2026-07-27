import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { get } from 'node:http';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const input = process.argv[2];
if (!input) {
  throw new Error('usage: node scripts/smoke-binary.mjs <binary>');
}

const binary = resolve(input);
const execFileAsync = promisify(execFile);
const version = await execFileAsync(binary, ['--version'], { timeout: 10_000, windowsHide: true });
assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+(?:-.+)?$/);

const child = spawn(binary, ['--port', '0', '--json'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

try {
  const startup = await new Promise((resolveStartup, rejectStartup) => {
    const timeout = setTimeout(() => {
      rejectStartup(new Error(`binary did not report startup within 10 seconds\n${stderr}`));
    }, 10_000);

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.url === 'string') {
          clearTimeout(timeout);
          lines.close();
          resolveStartup(parsed);
        }
      } catch {
        // Ignore non-JSON startup output; --json should eventually emit one JSON line.
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectStartup(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectStartup(new Error(`binary exited before startup (code=${code}, signal=${signal})\n${stderr}`));
    });
  });

  const health = await getJson(`${startup.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });

  const jwksResponse = await getJson(`${startup.url}/oauth2/jwks`);
  assert.equal(jwksResponse.status, 200);
  const jwks = jwksResponse.body;
  assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS must contain at least one key');

  console.log(`smoke-binary: OK (${binary})`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((resolveExit) => child.once('exit', resolveExit));
    const timeout = new Promise((resolveTimeout) => {
      const timer = setTimeout(resolveTimeout, 1_000);
      timer.unref();
    });
    child.kill('SIGINT');
    await Promise.race([exit, timeout]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function getJson(url) {
  return new Promise((resolveRequest, rejectRequest) => {
    get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolveRequest({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (error) {
          rejectRequest(error);
        }
      });
    }).once('error', rejectRequest);
  });
}
