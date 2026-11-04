/**
 * Validates one exchange against the OpenAPI spec and reports what does not fit. Three things
 * are checked, each only where the spec has something to say:
 *
 *   response  — a JSON body for a documented status is validated against that status's schema
 *   status    — a JSON response with a status the operation does not document
 *   query     — on a request the emulator accepted, a query parameter the operation does not list
 *   request   — on a request the emulator accepted, a JSON body validated against the request schema
 *
 * A request the emulator refused is not held to the request schema: tests send bad bodies on
 * purpose. Statuses the emulator's own middleware produces for every route (401, 403, 429) are
 * skipped, since the spec documents them on a few operations only.
 */
import type { ErrorObject, Options, ValidateFunction } from 'ajv';
import * as ajv2020 from 'ajv/dist/2020.js';
import * as ajvFormats from 'ajv-formats';
import type { Exchange } from '../../src/core/index.js';
import { SPEC_ID, findOperation, indexSpec, loadSpec, type Spec, type SpecOperation } from './spec-index.js';

// ajv and ajv-formats are CommonJS; under nodenext their classes are the modules' default exports.
interface AjvLike {
  addSchema(schema: object, key: string): unknown;
  compile(schema: object): ValidateFunction;
}
const Ajv2020 = (ajv2020 as unknown as { default: new (options: Options) => AjvLike }).default;
const addFormats = (ajvFormats as unknown as { default: (instance: AjvLike) => void }).default;

export interface Finding {
  operation: string;
  status: number;
  kind: 'response' | 'status' | 'query' | 'request';
  detail: string;
}

/** One line per finding, with array indices collapsed so the key is stable across runs. */
export function findingKey(finding: Finding): string {
  return `${finding.operation} ${finding.status} ${finding.kind} ${finding.detail}`;
}

const CROSS_CUTTING_STATUSES = new Set([401, 403, 429]);

const spec = loadSpec();
const operations = indexSpec(spec);
/** Property names `tagDiscriminators` found telling `oneOf` branches apart, e.g. `event`. */
const discriminatorTags = new Set<string>();
tagDiscriminators(spec);
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
  validateSchema: false,
  discriminator: true,
});
addFormats(ajv);
ajv.addSchema(spec as unknown as object, SPEC_ID);

/**
 * Marks each `oneOf` whose branches are told apart by one constant property — events by
 * `event`, authenticate grants by `grant_type` — with an OpenAPI `discriminator`, so ajv reports
 * the chosen branch's errors instead of "must match exactly one schema in oneOf". The spec
 * itself declares none. A `oneOf` with no such property, or whose tag values repeat, is left to
 * ajv's default handling.
 */
function tagDiscriminators(document: Spec): void {
  type Node = Record<string, unknown>;
  const pointerGet = (ref: string): Node | undefined => {
    let node: unknown = document;
    for (const part of ref.replace(/^#\//, '').split('/')) {
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Node)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return node && typeof node === 'object' ? (node as Node) : undefined;
  };
  const resolve = (node: unknown): Node | undefined =>
    node && typeof node === 'object'
      ? typeof (node as Node).$ref === 'string'
        ? pointerGet((node as Node).$ref as string)
        : (node as Node)
      : undefined;

  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const schema = node as Node;
    if (Array.isArray(schema.oneOf) && !schema.discriminator) {
      const branches = schema.oneOf.map(resolve);
      const tag = findTag(branches);
      if (tag) {
        schema.discriminator = { propertyName: tag };
        discriminatorTags.add(tag);
      }
    }
    for (const value of Object.values(schema)) visit(value);
  };

  const findTag = (branches: Array<Node | undefined>): string | undefined => {
    const objects = branches.map((b) => (b?.properties && typeof b.properties === 'object' ? b : undefined));
    if (objects.length === 0 || objects.some((b) => !b)) return undefined;
    const constantOf = (branch: Node, name: string): unknown => {
      const property = (branch.properties as Record<string, Node | undefined>)[name];
      if (!property) return undefined;
      if ('const' in property) return property.const;
      if (Array.isArray(property.enum) && property.enum.length === 1) return property.enum[0];
      return undefined;
    };
    for (const name of Object.keys(objects[0]!.properties as object)) {
      const values = objects.map((branch) => constantOf(branch!, name));
      const required = objects.every((branch) => Array.isArray(branch!.required) && branch!.required.includes(name));
      if (!required || values.some((v) => typeof v !== 'string') || new Set(values).size !== values.length) continue;
      return name;
    }
    return undefined;
  };

  visit(document);
}

const validators = new Map<string, ValidateFunction>();
function validatorFor(pointer: string): ValidateFunction {
  const cached = validators.get(pointer);
  if (cached) return cached;
  const compiled = ajv.compile({ $ref: `${SPEC_ID}#${pointer}` });
  validators.set(pointer, compiled);
  return compiled;
}

/**
 * ajv reports every branch of a failed `oneOf`/`anyOf`; only the composite failure is kept, since
 * the branch errors describe schemas the value was never meant to match. Branch errors are the
 * ones at or below the composite's own instance path.
 */
function describe(errors: ErrorObject[], instance: unknown): string[] {
  const composites = errors.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf').map((e) => e.instancePath);
  const underComposite = (e: ErrorObject) =>
    composites.some((path) => e.instancePath === path || e.instancePath.startsWith(`${path}/`));
  return errors
    .filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf' || !underComposite(e))
    .map((e) => {
      const what =
        e.keyword === 'additionalProperties'
          ? `additionalProperties: ${String(e.params.additionalProperty)}`
          : e.keyword === 'required'
            ? `required: ${String(e.params.missingProperty)}`
            : e.keyword === 'type'
              ? `type: ${String(e.params.type)}`
              : e.keyword === 'enum'
                ? 'enum'
                : e.keyword === 'discriminator'
                  ? `discriminator: ${String(e.params.tag)}=${JSON.stringify(e.params.tagValue)} not documented`
                  : `${e.keyword}: ${e.message ?? ''}`;
      return `${collapse(e.instancePath, instance)} ${what}`;
    });
}

/**
 * The instance path with array indices collapsed, so a finding reads the same whichever item
 * produced it. An item told apart by a discriminator keeps that: `/data/[event=user.created]/data`
 * says which event variant fell short where `/data/[]/data` would not.
 */
function collapse(instancePath: string, instance: unknown): string {
  if (instancePath === '') return '/';
  let node: unknown = instance;
  const parts = instancePath.split('/').slice(1);
  return `/${parts
    .map((part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
      if (!/^\d+$/.test(key)) return key;
      const item = node && typeof node === 'object' ? (node as Record<string, unknown>) : undefined;
      const tag = item && [...discriminatorTags].find((name) => typeof item[name] === 'string');
      return tag ? `[${tag}=${String(item[tag])}]` : '[]';
    })
    .join('/')}`;
}

function validate(pointer: string, value: unknown): string[] {
  const validator = validatorFor(pointer);
  return validator(value) ? [] : describe(validator.errors ?? [], value);
}

export function inspectExchange(exchange: Exchange): Finding[] {
  const operation = findOperation(operations, exchange.method, exchange.url.pathname);
  if (!operation) return [];
  const findings: Finding[] = [];
  const report = (kind: Finding['kind'], detail: string) =>
    findings.push({ operation: operation.id, status: exchange.status, kind, detail });

  if (exchange.responseBody !== undefined && !CROSS_CUTTING_STATUSES.has(exchange.status)) {
    const pointer = operation.responses.get(String(exchange.status));
    // A 5xx is never documented and, from the emulator, is an error hook a test installed.
    if (pointer === undefined && exchange.status < 500) report('status', 'undocumented');
    else if (pointer) for (const line of validate(pointer, exchange.responseBody)) report('response', line);
  }

  if (exchange.status >= 200 && exchange.status < 300) {
    for (const name of queryNames(exchange.url, operation)) report('query', `${name} undocumented`);
    if (exchange.requestBody !== undefined && operation.requestSchema) {
      for (const line of validate(operation.requestSchema, exchange.requestBody)) report('request', line);
    }
  }
  return findings;
}

/** Query names the spec does not list, with the array forms SDKs use (`a[]`, `a[0]`) folded to `a`. */
function queryNames(url: URL, operation: SpecOperation): string[] {
  const names = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const name = key.replace(/\[\d*\]$/, '');
    if (!operation.queryParams.has(name)) names.add(name);
  }
  return [...names];
}
