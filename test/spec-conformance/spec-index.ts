/**
 * The OpenAPI spec as a lookup table: which operation a request hits, which query parameters it
 * documents, and where its request and response schemas live. Pointers are JSON-pointer
 * fragments into the spec document, the form ajv resolves once the document is registered under
 * `SPEC_ID`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

export const SPEC_ID = 'openapi';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface SpecOperation {
  /** `GET /organizations/{id}`: the key findings are reported under. */
  id: string;
  pattern: RegExp;
  literalSegments: number;
  queryParams: Set<string>;
  /** Pointer to the `application/json` request schema, when the operation takes a body. */
  requestSchema: string | null;
  /** Status code -> pointer to the `application/json` response schema, or null when the status is documented without one. */
  responses: Map<string, string | null>;
}

interface RawParameter {
  name: string;
  in: string;
}

interface RawContent {
  content?: Record<string, { schema?: unknown }>;
}

interface RawOperation extends RawContent {
  parameters?: RawParameter[];
  requestBody?: RawContent;
  responses?: Record<string, RawContent>;
}

type RawPathItem = Partial<Record<(typeof METHODS)[number], RawOperation>> & { parameters?: RawParameter[] };

export interface Spec {
  paths: Record<string, RawPathItem>;
}

export function loadSpec(): Spec {
  const path = createRequire(import.meta.url).resolve('@workos/openapi-spec/spec');
  return parse(readFileSync(path, 'utf-8')) as Spec;
}

/** JSON-pointer segment, escaped for use inside a URI fragment. */
function segment(value: string): string {
  return encodeURIComponent(value.replace(/~/g, '~0').replace(/\//g, '~1'));
}

function jsonSchemaPointer(base: string, holder: RawContent | undefined): string | null | undefined {
  if (!holder) return undefined;
  const contentType = Object.keys(holder.content ?? {}).find((type) => type.includes('json'));
  if (!contentType || !holder.content?.[contentType]?.schema) return null;
  return `${base}/content/${segment(contentType)}/schema`;
}

export function indexSpec(spec: Spec): SpecOperation[] {
  const operations: SpecOperation[] = [];
  for (const [template, item] of Object.entries(spec.paths)) {
    const segments = template.split('/').slice(1);
    const pattern = new RegExp(
      `^/${segments.map((s) => (s.startsWith('{') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`,
    );
    const literalSegments = segments.filter((s) => !s.startsWith('{')).length;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const base = `/paths/${segment(template)}/${method}`;
      const queryParams = new Set(
        [...(item.parameters ?? []), ...(operation.parameters ?? [])]
          .filter((p) => p.in === 'query')
          .map((p) => p.name),
      );
      const responses = new Map<string, string | null>();
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        responses.set(status, jsonSchemaPointer(`${base}/responses/${status}`, response) ?? null);
      }
      operations.push({
        id: `${method.toUpperCase()} ${template}`,
        pattern,
        literalSegments,
        queryParams,
        requestSchema: jsonSchemaPointer(`${base}/requestBody`, operation.requestBody) ?? null,
        responses,
      });
    }
  }
  return operations;
}

/** The operation a request hits: the matching template with the most literal segments wins. */
export function findOperation(
  operations: SpecOperation[],
  method: string,
  pathname: string,
): SpecOperation | undefined {
  const upper = method.toUpperCase();
  let best: SpecOperation | undefined;
  for (const operation of operations) {
    if (!operation.id.startsWith(`${upper} `) || !operation.pattern.test(pathname)) continue;
    if (!best || operation.literalSegments > best.literalSegments) best = operation;
  }
  return best;
}
