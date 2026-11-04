/**
 * Validates one exchange against the OpenAPI spec and reports what does not fit. Three things
 * are checked, each only where the spec has something to say:
 *
 *   response  — a JSON body for a documented status is validated against that status's schema;
 *               a documented JSON response that arrives empty, unparseable or not JSON at all
 *               is reported too
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
  const schemaAt = (ref: string): Node | undefined => {
    const node = pointerGet(document, ref.replace(/^#/, ''));
    return node && typeof node === 'object' ? (node as Node) : undefined;
  };
  const resolve = (node: unknown): Node | undefined =>
    node && typeof node === 'object'
      ? typeof (node as Node).$ref === 'string'
        ? schemaAt((node as Node).$ref as string)
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
 * ajv reports every branch of a failed `oneOf`/`anyOf` alongside the composite failure. Only the
 * composite is kept: the branch errors describe schemas the value was never meant to match. A
 * branch error is one whose schema path lies inside a branch — an inline branch under the
 * composite's own path, or the schema a `$ref` branch names — at or below the composite's
 * instance path. An error from a sibling keyword at the same instance path, such as a `required`
 * next to the `oneOf`, is independent and stays.
 */
export function describeErrors(errors: ErrorObject[], instance: unknown, document: unknown): string[] {
  const composites = errors.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf');
  const isBranchError = (e: ErrorObject) =>
    composites.some((composite) => {
      const under =
        e.instancePath === composite.instancePath || e.instancePath.startsWith(`${composite.instancePath}/`);
      return under && branchPrefixes(composite.schemaPath, document).some((prefix) => e.schemaPath.startsWith(prefix));
    });
  return errors
    .filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf' || !isBranchError(e))
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
 * Where a composite's branches live, as schema-path prefixes: `<composite>/<i>/` for an inline
 * branch, plus the path of every schema a branch reaches through `$ref`, directly or through
 * its own `allOf`/`properties`, since ajv reports an error under the schema that owns the
 * keyword. A composite whose schema cannot be found yields no prefixes, so nothing is dropped
 * on its account.
 */
function branchPrefixes(compositeSchemaPath: string, document: unknown): string[] {
  const hash = compositeSchemaPath.indexOf('#');
  if (hash === -1) return [];
  const base = compositeSchemaPath.slice(0, hash);
  const composite = pointerGet(document, compositeSchemaPath.slice(hash + 1));
  const branches = Array.isArray(composite) ? composite : [];
  const prefixes: string[] = [];
  const seen = new Set<string>();
  const follow = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) follow(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        const full = value.startsWith('#') ? `${base}${value}` : value;
        if (seen.has(full)) continue;
        seen.add(full);
        prefixes.push(full);
        const target = full.indexOf('#');
        if (target !== -1) follow(pointerGet(document, full.slice(target + 1)));
      } else {
        follow(value);
      }
    }
  };
  branches.forEach((branch, i) => {
    prefixes.push(`${compositeSchemaPath}/${i}/`);
    follow(branch);
  });
  return prefixes;
}

/**
 * The schema at a JSON pointer, stepping through any `$ref` met on the way: ajv inlines small
 * referenced schemas, and then reports an error's path through the referencing schema (the
 * operation's `schema`) rather than the component it names.
 */
function pointerGet(document: unknown, pointer: string): unknown {
  let node: unknown = document;
  for (const part of pointer.replace(/^\//, '').split('/')) {
    if (part === '') continue;
    node = deref(document, node);
    if (!node || typeof node !== 'object') return undefined;
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[key];
  }
  return deref(document, node);
}

function deref(document: unknown, node: unknown, depth = 0): unknown {
  if (depth > 16 || !node || typeof node !== 'object') return node;
  const ref = (node as Record<string, unknown>).$ref;
  if (typeof ref !== 'string') return node;
  const hash = ref.indexOf('#');
  return deref(document, pointerGet(document, hash === -1 ? ref : ref.slice(hash + 1)), depth + 1);
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
  return validator(value) ? [] : describeErrors(validator.errors ?? [], value, spec);
}

export function inspectExchange(exchange: Exchange): Finding[] {
  const operation = findOperation(operations, exchange.method, exchange.url.pathname);
  if (!operation) return [];
  const findings: Finding[] = [];
  const report = (kind: Finding['kind'], detail: string) =>
    findings.push({ operation: operation.id, status: exchange.status, kind, detail });

  if (!CROSS_CUTTING_STATUSES.has(exchange.status)) {
    const pointer = operation.responses.get(String(exchange.status));
    if (pointer === undefined) {
      // A 5xx is never documented and, from the emulator, is an error hook a test installed.
      if (exchange.responseBody !== undefined && exchange.status < 500) report('status', 'undocumented');
    } else if (pointer) {
      if (exchange.responseBody === undefined) report('response', '/ no JSON body');
      else for (const line of validate(pointer, exchange.responseBody)) report('response', line);
    }
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
