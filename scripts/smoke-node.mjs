// Guards the npm library path: plain Node imports dist and serves crypto endpoints.
// Run with `node scripts/smoke-node.mjs` — never with bun; the invariant under
// test is that dist/ contains no Bun-only APIs and boots under plain Node.
import { createEmulator } from '../dist/index.js';

const emulator = await createEmulator({ port: 0 });
try {
  const res = await fetch(`${emulator.url}/oauth2/jwks`);
  if (!res.ok) throw new Error(`JWKS returned ${res.status}`);
  const jwks = await res.json();
  if (!Array.isArray(jwks.keys) || jwks.keys.length < 1) throw new Error('JWKS has no keys');
  console.log('smoke-node: OK');
} finally {
  await emulator.close();
}
