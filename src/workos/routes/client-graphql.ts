import type { Context } from 'hono';
import {
  GraphQLError,
  Kind,
  buildSchema,
  defaultFieldResolver,
  execute,
  parse,
  validate,
  visit,
  BREAK,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLFieldResolver,
  type GraphQLFormattedError,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import {
  ID_PREFIXES,
  WIDGET_TOKEN_AUDIENCE,
  type JWTManager,
  type JWTPayload,
  type RouteContext,
  type WorkOSAppEnv,
} from '../../core/index.js';
import type { WorkOSUser } from '../entities.js';
import { WIDGETS_API_SCHEMA_SDL } from '../generated/widgets-api-schema.js';
import { AUTH_METHOD_SESSION_VALUES, verifiedAuthFactors } from '../helpers.js';
import { MINIMUM_PASSWORD_LENGTH, MINIMUM_ZXCVBN_SCORE } from '../password-policy.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { CLIENT_API_TOKEN_AUDIENCE } from './client-api.js';
import { WIDGET_SESSION_ID_PREFIX } from './widgets.js';

/**
 * `POST /client/graphql` — the Widgets API, production's Client GraphQL API. Every
 * `@workos-inc/widgets` component from 1.19.0 on talks to this one endpoint (the `/_widgets/*`
 * REST surface served the components up to 1.18), through `graphql-request` and the operation
 * documents generated into the package from the schema WorkOS publishes.
 *
 * The emulator validates every request against that published schema (see
 * `generated/widgets-api-schema.ts`) and answers the operations it implements from the same store
 * the REST routes use. Production runs Apollo Server 3 under Nest, and this route reproduces the
 * envelopes of that stack as verified live: parse and validation failures are a 400 with the
 * Apollo error code, a token problem is an HTTP 200 whose error carries `UNAUTHENTICATED` — which
 * is what the widget client reads as "refetch the token once, then show the expired or
 * incorrect-permissions state" — and introspection is a 403, since the schema is published as a
 * download instead.
 */

export const CLIENT_GRAPHQL_PATH = '/client/graphql';

/** Apollo's answer to a request body it could not read as a GraphQL request, verbatim. */
const BAD_POST_BODY = 'POST body missing, invalid Content-Type, or JSON object has no keys.';

/**
 * Apollo's CSRF prevention, as production configures it: a request whose content type a browser
 * would send without a preflight (none, or one of the three "simple" ones) must carry the
 * `X-CSRF-Token` header production names, or it is refused with this text.
 */
const CSRF_REFUSAL =
  'This operation has been blocked as a potential Cross-Site Request Forgery (CSRF). Please either ' +
  "specify a 'content-type' header (with a type that is not one of application/x-www-form-urlencoded, " +
  'multipart/form-data, text/plain) or provide a non-empty value for one of the following headers: ' +
  'X-CSRF-Token';

const SIMPLE_CONTENT_TYPE = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;

/** The error code the emulator gives an operation the schema defines but the emulator does not answer. */
export const NOT_IMPLEMENTED_CODE = 'NOT_IMPLEMENTED';

/**
 * The verified session behind a request, as production's guard resolves it: who the token's
 * `sub` is — a user, or the widget session itself for an organization-only session — and the
 * organization the token selected, if any.
 */
interface ClientApiSession {
  subject: string;
  organizationId: string | undefined;
}

interface GraphqlContext {
  ws: WorkOSStore;
  /** Undefined when the request carried no usable token; every root field then answers Unauthenticated. */
  session: ClientApiSession | undefined;
}

type RootResolver = (args: Record<string, unknown>, context: GraphqlContext) => unknown;

/**
 * Production's `WidgetsApi_OAuthProvider` enum in the order its `me` resolver walks the user's
 * OAuth profiles, which is the order `connectedAccounts` lists them in.
 */
const OAUTH_PROVIDERS = [
  'AppleOAuth',
  'BitbucketOAuth',
  'DiscordOAuth',
  'GithubOAuth',
  'GitLabOAuth',
  'GoogleOAuth',
  'GrokOAuth',
  'XOAuth',
  'IntuitOAuth',
  'LinkedInOAuth',
  'MicrosoftOAuth',
  'SalesforceOAuth',
  'SlackOAuth',
  'VercelMarketplaceOAuth',
  'VercelOAuth',
  'XeroOAuth',
] as const;

/**
 * The REST surface spells GitHub's provider `GitHubOAuth` (the connection type, which is what a
 * completed OAuth login links an identity under) where the GraphQL enum has `GithubOAuth`.
 */
const toOAuthProvider = (provider: string): string => (provider === 'GitHubOAuth' ? 'GithubOAuth' : provider);

/**
 * The authentication settings of the environment the emulator models, as `authenticationSettings`
 * reports them. They describe what the emulator enforces rather than the dashboard defaults of a
 * fresh production environment, which differ in two places: MFA is `Optional` here (a password
 * sign-in challenges a verified factor, which an `Off` environment never does), and the
 * breached-password lookup is reported off because it never runs (it needs the network).
 * Passkeys are not implemented, so they are reported off.
 */
const AUTHENTICATION_SETTINGS = {
  passwordAuthEnabled: true,
  passkeyAuthEnabled: false,
  mfaEnabled: true,
  mfaRequired: false,
  passwordPolicy: {
    minimumLength: MINIMUM_PASSWORD_LENGTH,
    minimumStrength: MINIMUM_ZXCVBN_SCORE,
    rejectsBreachedPasswords: false,
    requiresUppercase: false,
    requiresLowercase: false,
    requiresNumber: false,
    requiresSymbol: false,
  },
} as const;

let schema: GraphQLSchema | undefined;
const getSchema = (): GraphQLSchema => (schema ??= buildSchema(WIDGETS_API_SCHEMA_SDL));

const hasActiveMembership = (ws: WorkOSStore, userId: string, organizationId: string): boolean =>
  ws.organizationMemberships
    .findBy('organization_id', organizationId)
    .some((m) => m.user_id === userId && m.status === 'active');

/**
 * Resolve the session a bearer token names, or nothing when the token is unusable. Production's
 * guard accepts three kinds of token and re-reads the session behind each on every request, so a
 * membership deactivated or a session revoked after the token was minted denies it:
 *
 * - an AuthKit access token (`sid` names a userland session): the session must be live and the
 *   token's `sub` its user; an `org_id` needs an active membership;
 * - a widget token from `POST /widgets/token` (`sid` names a widget session). The emulator keeps
 *   no widget session rows, so the claims stand in for one, checked the same way: a user with an
 *   `org_id` needs an active membership, and an organization-only session's organization must
 *   exist;
 * - a Client API token from `POST /client/token`, which the emulator mints without a `sid` and
 *   treats like a widget token.
 *
 * A missing header, a bad signature, an expired token, or one of another kind (an API key, an M2M
 * or agent token) all resolve to nothing, which the root fields answer as Unauthenticated.
 *
 * So does the access token `/oauth2/token` mints a Connect application for a signed-in user.
 * Production puts the application consent's id in that token's `sid`, which names no userland
 * session, so its guard finds none and denies the token. The emulator mints it with the user's
 * session in `sid`, so it is told apart by the other two things that mark it: it carries the
 * application's `client_id`, and its `iss` is the bare issuer, where an AuthKit access token
 * minted for a client carries `<issuer>/user_management/<client_id>`.
 */
function resolveSession(
  ws: WorkOSStore,
  jwt: JWTManager,
  authorization: string | undefined,
): ClientApiSession | undefined {
  // Production's own match: a `Bearer ` prefix, case-sensitive, and whatever follows it.
  const token = authorization?.match(/^Bearer (?<token>.*)/)?.groups?.token;
  if (!token) return undefined;

  let payload: JWTPayload;
  try {
    payload = jwt.verify(token);
  } catch {
    return undefined;
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return undefined;
  // An `org_id` that is present but not a non-empty string is a malformed claim, not "no
  // organization": production denies it rather than let it select nothing.
  if (payload.org_id !== undefined && (typeof payload.org_id !== 'string' || payload.org_id.length === 0)) {
    return undefined;
  }
  const organizationId = payload.org_id;

  if (typeof payload.sid === 'string' && !payload.sid.startsWith(`${WIDGET_SESSION_ID_PREFIX}_`)) {
    if (
      payload.iss === jwt.issuer &&
      typeof payload.client_id === 'string' &&
      ws.connectApplications.findOneBy('client_id', payload.client_id)
    ) {
      return undefined;
    }
    const session = ws.sessions.get(payload.sid);
    if (!session || session.status !== 'active' || new Date(session.expires_at).getTime() <= Date.now()) {
      return undefined;
    }
    if (session.user_id !== payload.sub) return undefined;
    if (organizationId !== undefined && !hasActiveMembership(ws, payload.sub, organizationId)) return undefined;
    return { subject: payload.sub, organizationId };
  }

  if (payload.aud !== WIDGET_TOKEN_AUDIENCE && payload.aud !== CLIENT_API_TOKEN_AUDIENCE) return undefined;
  if (organizationId !== undefined) {
    const isUser = payload.sub.startsWith(`${ID_PREFIXES.user}_`);
    if (isUser ? !hasActiveMembership(ws, payload.sub, organizationId) : !ws.organizations.get(organizationId)) {
      return undefined;
    }
  }
  return { subject: payload.sub, organizationId };
}

const unauthenticated = (): GraphQLError =>
  new GraphQLError('Unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });

/**
 * The user a session token is for. Production looks the subject up as a user and lets the
 * not-found exception through its filter, which renders a 404 as the `NOT_FOUND` code — so an
 * organization-only widget session, whose subject is the session itself, gets that rather than
 * Unauthenticated.
 */
function requireUser(context: GraphqlContext): WorkOSUser {
  if (!context.session) throw unauthenticated();
  const user = context.ws.users.get(context.session.subject);
  if (!user) {
    throw new GraphQLError(`User not found: '${context.session.subject}'.`, { extensions: { code: 'NOT_FOUND' } });
  }
  return user;
}

/**
 * Production's `passwordLastUsedAt`: the latest activity on any session the user signed into with
 * a password. The emulator records a session's sign-in and nothing after it, so the latest password
 * sign-in is what it reports.
 */
function passwordLastUsedAt(ws: WorkOSStore, userId: string): string | null {
  let latest: string | null = null;
  for (const session of ws.sessions.findBy('user_id', userId)) {
    if (session.auth_method !== AUTH_METHOD_SESSION_VALUES.Password) continue;
    if (latest === null || session.created_at > latest) latest = session.created_at;
  }
  return latest;
}

/**
 * The user's linked OAuth identities as production's connected accounts, which are the OAuth
 * profiles behind them. A login through an OAuth connection leaves such a profile here too, and
 * it is what fills the account; a seeded identity has none, so its account is the identity alone
 * and the profile fields the emulator never learned are null. A last login is tracked nowhere.
 */
function connectedAccounts(ws: WorkOSStore, userId: string) {
  const identities = ws.identities.findBy('user_id', userId);
  const accounts = [];
  for (const provider of OAUTH_PROVIDERS) {
    const identity = identities.find((i) => toOAuthProvider(i.provider) === provider);
    if (!identity) continue;
    const profile = ws.ssoProfiles
      .findBy('idp_id', identity.idp_id)
      .find((p) => p.connection_type === identity.provider);
    accounts.push({
      id: profile?.id ?? identity.id,
      provider,
      email: profile?.email ?? null,
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      profilePictureUrl: null,
      lastLoginAt: null,
    });
  }
  return accounts;
}

function toUser(ws: WorkOSStore, user: WorkOSUser) {
  // Production reads the user's first verified TOTP factor; TOTP is the only kind the emulator
  // enrolls, so every verified factor qualifies. The environment's MFA setting is `Optional` (see
  // AUTHENTICATION_SETTINGS), so this is never forced to false the way an `Off` environment is.
  const totp = verifiedAuthFactors(ws, user.id)[0];
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified,
    firstName: user.first_name,
    lastName: user.last_name,
    profilePictureUrl: user.profile_picture_url,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    connectedAccounts: connectedAccounts(ws, user.id),
    mfaEnabled: totp !== undefined,
    mfaLastUsedAt: totp?.last_verified_at ?? null,
    passwordSet: user.password_hash !== null,
    passwordLastUsedAt: user.password_hash === null ? null : passwordLastUsedAt(ws, user.id),
  };
}

/** The root fields the emulator answers, by root type. Everything else the schema defines is refused as unimplemented. */
const ROOT_RESOLVERS: Record<string, Record<string, RootResolver>> = {
  Query: {
    me: (_args, context) => toUser(context.ws, requireUser(context)),
    // Production loads the token's user before answering — the query "requires a session token" —
    // so an organization-only session is refused the same way `me` refuses it.
    authenticationSettings: (_args, context) => {
      requireUser(context);
      return AUTHENTICATION_SETTINGS;
    },
  },
  Mutation: {},
};

/**
 * Resolve root fields from the table above and everything below them off the parent object, as
 * graphql-js does by default. A root field the table lacks is a schema-valid operation the
 * emulator has not implemented, which is reported as such rather than as a null for a non-null
 * field — to a caller production would have let reach it. Production's guard sits on every
 * resolver, so without a usable token such a field answers Unauthenticated like any other, which
 * is what tells the widget client to refetch its token.
 */
const fieldResolver: GraphQLFieldResolver<unknown, GraphqlContext> = (source, args, context, info) => {
  const roots = ROOT_RESOLVERS[info.parentType.name];
  if (!roots) return defaultFieldResolver(source, args, context, info);
  const resolver = roots[info.fieldName];
  if (!resolver) {
    if (!context.session) throw unauthenticated();
    throw new GraphQLError(`The emulator does not implement ${info.parentType.name}.${info.fieldName} yet.`, {
      extensions: { code: NOT_IMPLEMENTED_CODE },
    });
  }
  return resolver(args, context);
};

/**
 * A GraphQL request as Apollo reads it off a POST body or a GET query string, before it is
 * parsed. `query` is checked for presence only here; its type is checked where Apollo checks it.
 */
interface GraphqlRequest {
  query: unknown;
  operationName: string | undefined;
  variables: Record<string, unknown> | undefined;
}

type Refusal = { status: 400 | 405; body: string } | { status: 400 | 403; json: Record<string, unknown> };

/** A refusal rendered the way Apollo renders a request it could not run: a bare text body. */
const text = (status: 400 | 405, body: string): Refusal => ({ status, body });

/** A refusal rendered as a GraphQL error document with one error and no `data`. */
const graphqlRefusal = (status: 400 | 403, message: string, code: string): Refusal => ({
  status,
  json: { errors: [{ message, extensions: { code } }] },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Apollo's parsing of `variables` and `operationName` off either transport. */
function readVariables(raw: unknown, fromQueryString: boolean): Record<string, unknown> | undefined | Refusal {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    // A JSON-encoded object, the only way a query string carries variables; a POST body may send
    // the same encoding.
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : text(400, 'Variables are invalid JSON.');
    } catch {
      return text(400, 'Variables are invalid JSON.');
    }
  }
  if (fromQueryString || !isRecord(raw)) return text(400, 'Variables are invalid JSON.');
  return raw;
}

async function readRequest(c: Context<WorkOSAppEnv>): Promise<GraphqlRequest | Refusal> {
  const contentType = c.req.header('content-type');
  if ((!contentType || SIMPLE_CONTENT_TYPE.test(contentType)) && !c.req.header('x-csrf-token')) {
    return text(400, CSRF_REFUSAL);
  }

  if (c.req.method === 'GET') {
    const variables = readVariables(c.req.query('variables'), true);
    if (isRefusal(variables)) return variables;
    return { query: c.req.query('query'), operationName: c.req.query('operationName'), variables };
  }

  if (!/^application\/json\b/i.test(contentType ?? '')) return text(400, BAD_POST_BODY);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    // Express's body parser, through Nest's filter: the JSON error's message, and nothing else.
    return { status: 400, json: { message: error instanceof Error ? error.message : 'Invalid JSON' } };
  }
  if (!isRecord(body) || Object.keys(body).length === 0) return text(400, BAD_POST_BODY);

  const variables = readVariables(body.variables, false);
  if (isRefusal(variables)) return variables;
  const operationName = body.operationName;
  return {
    query: body.query,
    operationName: typeof operationName === 'string' ? operationName : undefined,
    variables,
  };
}

const isRefusal = (value: unknown): value is Refusal =>
  isRecord(value) && typeof value.status === 'number' && ('body' in value || 'json' in value);

/**
 * Whether the operation that would run selects `__schema` or `__type` anywhere: directly, inside
 * an inline fragment, or through the named fragments it spreads, however deep. Only the operation
 * and the fragments it reaches count, as in production's check — another operation in the
 * document never executes.
 */
function introspects(document: DocumentNode, operation: OperationDefinitionNode): boolean {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }

  const pending: (OperationDefinitionNode | FragmentDefinitionNode)[] = [operation];
  const spread = new Set<string>();
  let found = false;
  for (let definition = pending.pop(); definition && !found; definition = pending.pop()) {
    visit(definition, {
      Field: ({ name }) => {
        if (name.value !== '__schema' && name.value !== '__type') return undefined;
        found = true;
        return BREAK;
      },
      FragmentSpread: ({ name }) => {
        if (spread.has(name.value)) return undefined;
        spread.add(name.value);
        const fragment = fragments.get(name.value);
        if (fragment) pending.push(fragment);
        return undefined;
      },
    });
  }
  return found;
}

/**
 * Pick the operation a request names, the way Apollo does before executing: one operation runs
 * unnamed, several need `operationName`, and a name the document lacks is refused. Each refusal
 * is a 400 carrying graphql-js's message under the code production's filter leaves on it.
 */
function selectOperation(document: DocumentNode, operationName: string | undefined): OperationDefinitionNode | Refusal {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operationName === undefined) {
    if (operations.length > 1) {
      return graphqlRefusal(
        400,
        'Must provide operation name if query contains multiple operations.',
        'INTERNAL_SERVER_ERROR',
      );
    }
    return operations[0];
  }
  const named = operations.find((operation) => operation.name?.value === operationName);
  return named ?? graphqlRefusal(400, `Unknown operation named "${operationName}".`, 'INTERNAL_SERVER_ERROR');
}

/**
 * An execution error as production's Apollo formats it: graphql-js's own JSON (message, where it
 * was raised, the path it failed at, extensions), with a code filled in for an error that was
 * thrown without one.
 */
function formatExecutionError(error: GraphQLError): GraphQLFormattedError {
  const formatted = error.toJSON();
  return typeof formatted.extensions?.code === 'string'
    ? formatted
    : { ...formatted, extensions: { ...formatted.extensions, code: 'INTERNAL_SERVER_ERROR' } };
}

export function clientGraphqlRoutes(ctx: RouteContext): void {
  const { app, jwt, store } = ctx;
  const ws = getWorkOSStore(store);

  const refuse = (c: Context<WorkOSAppEnv>, refusal: Refusal) =>
    'body' in refusal ? c.html(refusal.body, refusal.status) : c.json(refusal.json, refusal.status);

  app.on(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], CLIENT_GRAPHQL_PATH, async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'POST') {
      return refuse(c, text(405, 'Apollo Server supports only GET/POST requests.'));
    }

    const request = await readRequest(c);
    if (isRefusal(request)) return refuse(c, request);

    // Apollo checks the type of a `query` it was given before it checks that it was given one.
    if (request.query !== undefined && request.query !== null && typeof request.query !== 'string') {
      return refuse(c, text(400, 'GraphQL queries must be strings.'));
    }
    if (!request.query) {
      return refuse(
        c,
        graphqlRefusal(
          400,
          'GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.',
          'INTERNAL_SERVER_ERROR',
        ),
      );
    }

    // Parse and validation failures are reported without `locations`, as production reports them.
    let document: DocumentNode;
    try {
      document = parse(request.query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(c, graphqlRefusal(400, message, 'GRAPHQL_PARSE_FAILED'));
    }
    const validationErrors = validate(getSchema(), document);
    if (validationErrors.length > 0) {
      return c.json(
        {
          errors: validationErrors.map((error) => ({
            message: error.message,
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          })),
        },
        400,
      );
    }

    const operation = selectOperation(document, request.operationName);
    if (isRefusal(operation)) return refuse(c, operation);
    if (c.req.method === 'GET' && operation.operation !== 'query') {
      return refuse(c, text(405, `GET requests only support query operations, not ${operation.operation} operations.`));
    }
    // Production keeps the schema introspectable at the Apollo level and refuses it per caller;
    // every public caller gets this, with the schema published as a download instead.
    if (introspects(document, operation)) {
      return c.json(
        {
          errors: [{ message: 'Forbidden action. Cannot introspect schema.', extensions: { code: 'FORBIDDEN' } }],
          data: null,
        },
        403,
      );
    }

    const result = await execute({
      schema: getSchema(),
      document,
      operationName: request.operationName,
      variableValues: request.variables,
      contextValue: { ws, session: resolveSession(ws, jwt, c.req.header('authorization')) } satisfies GraphqlContext,
      fieldResolver,
    });

    // A result with errors and no `data` at all never executed: the variables did not coerce to
    // the types the operation declares. Production answers that as a bad request, each error
    // under Apollo's user-input code and, like the other pre-execution failures, without
    // `locations`.
    if (result.errors && result.data === undefined) {
      return c.json(
        {
          errors: result.errors.map((error) => ({
            message: error.message,
            extensions: { code: 'BAD_USER_INPUT' },
          })),
        },
        400,
      );
    }

    // graphql-js puts `errors` before `data` when there are any; so does production.
    return c.json(
      result.errors ? { errors: result.errors.map(formatExecutionError), data: result.data } : { data: result.data },
    );
  });
}
