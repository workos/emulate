/**
 * Drive the CLI the way a shell or a compose file does: as a subprocess. Nothing in `cli.ts` can
 * be imported without starting a server, so a spec that wants the flag parsing, the environment
 * fallback or the exit code has to spawn it.
 */

const CLI = new URL('./cli.ts', import.meta.url).pathname;

/** What `--json` prints on startup. */
export interface CliStartup {
  url: string;
  port: number;
  apiKey: string;
  health: string;
}

/**
 * The inherited environment with every WORKOS_EMULATE_* variable removed, so a developer's shell
 * cannot configure the process under test, and update checks off. `env` is applied on top.
 */
function cliEnv(env: Record<string, string>): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env, NO_UPDATE_NOTIFIER: '1' };
  for (const name of Object.keys(base)) {
    if (name.startsWith('WORKOS_EMULATE_')) delete base[name];
  }
  return { ...base, ...env };
}

function spawnCli(args: string[], env: Record<string, string>) {
  return Bun.spawn([process.execPath, CLI, '--port', '0', '--json', ...args], {
    env: cliEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/**
 * The startup line only, not the whole stream: a served emulator never closes stdout, so reading
 * to EOF would wait for the process the caller is about to make requests against.
 */
async function readStartupLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffered += new TextDecoder().decode(value);
      const line = buffered.split('\n').find((l) => l.startsWith('{'));
      if (line && buffered.includes('\n')) return line;
      if (done) throw new Error(`CLI printed no startup JSON: ${buffered}`);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Start the CLI on a free port, hand its startup details to `body`, and make sure the process is reaped. */
export async function withCli(
  args: string[],
  env: Record<string, string>,
  body: (startup: CliStartup) => Promise<void>,
): Promise<void> {
  const proc = spawnCli(args, env);
  try {
    const line = await readStartupLine(proc.stdout);
    await body(JSON.parse(line) as CliStartup);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

/** Run the CLI to completion, for an invocation that is expected to exit rather than serve. */
export async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const proc = spawnCli(args, env);
  const stderr = await Bun.readableStreamToText(proc.stderr);
  return { exitCode: await proc.exited, stderr };
}
