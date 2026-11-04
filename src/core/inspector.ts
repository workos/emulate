import type { MiddlewareHandler } from 'hono';

/**
 * One request and its response, as the emulator handled them. Bodies are parsed when they are
 * JSON and `undefined` otherwise, so an inspector never has to deal with a stream.
 */
export interface Exchange {
  method: string;
  url: URL;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

export type ExchangeInspector = (exchange: Exchange) => void;

let inspector: ExchangeInspector | null = null;

/**
 * Registers a function that sees every exchange the emulator handles, after the response is
 * built. The test suite's spec-conformance preload uses it to validate each exchange against the
 * OpenAPI spec; nothing registers one at runtime, where the middleware is a pass-through. An
 * inspector that throws fails the request it was looking at, so one that only records findings
 * should do exactly that and report them from a test hook.
 */
export function setExchangeInspector(fn: ExchangeInspector | null): void {
  inspector = fn;
}

export function exchangeInspectorMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!inspector) return next();
    // Cloned before the route reads it: a body stream can be consumed once.
    const request = c.req.raw.clone();
    await next();
    inspector({
      method: c.req.method,
      url: new URL(c.req.url),
      requestBody: await jsonBody(request),
      status: c.res.status,
      responseBody: await jsonBody(c.res.clone()),
    });
  };
}

// Structural, since Hono's request type and the runtime's response type name different `Headers`.
async function jsonBody(message: {
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}): Promise<unknown> {
  if (!message.headers.get('content-type')?.includes('json')) return undefined;
  const text = await message.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
