import { describe, it, expect } from 'bun:test';
import {
  type SupportSpec,
  type FeatureDef,
  FEATURES,
  specPathToHono,
  normalizePath,
  routeKey,
  parseSpecOperations,
  parseEmulatorRoutes,
  parseSeedConfigKeys,
  deriveSetup,
  buildMatrix,
  generateSupportedMarkdown,
} from './gen-supported-lib.js';

// ---------------------------------------------------------------------------
// Fixture: a miniature spec covering the cases the matrix must distinguish —
// a fully covered feature, a partially covered one, one covered but unseedable
// (the Directory Sync trap), and one with no implementation at all.
// ---------------------------------------------------------------------------

const fixtureSpec: SupportSpec = {
  paths: {
    '/organizations': {
      get: { summary: 'List organizations', tags: ['organizations'] },
      post: { summary: 'Create an organization', tags: ['organizations'] },
    },
    '/organizations/{id}': {
      get: { summary: 'Get an organization', tags: ['organizations'] },
      delete: { summary: 'Delete an organization', tags: ['organizations'] },
    },
    '/directories': {
      get: { summary: 'List directories', tags: ['directories'] },
    },
    '/directories/{id}': {
      get: { summary: 'Get a directory', tags: ['directories'] },
      delete: { summary: 'Delete a directory', tags: ['directories'] },
    },
    '/vault/v1/kv': {
      get: { summary: 'List objects', tags: ['vault'] },
      post: { summary: 'Create an object', tags: ['vault'] },
    },
  },
};

const fixtureFeatures: FeatureDef[] = [
  { name: 'Organizations', tags: ['organizations'], seedKeys: ['organizations'] },
  { name: 'Directory Sync', tags: ['directories'], notes: 'Read-only.' },
  { name: 'Vault', tags: ['vault'], notes: 'Not implemented.' },
];

// Organizations: every GET, only the POST (DELETE unimplemented).
// Directory Sync: every endpoint, including the DELETE.
// Vault: nothing.
const fixtureRouteSource = `
  app.get('/organizations', (c) => {});
  app.post('/organizations', (c) => {});
  app.get('/organizations/:id', (c) => {});
  app.get('/directories', (c) => {});
  app.get('/directories/:id', (c) => {});
  app.delete('/directories/:id', (c) => {});
`;

const fixtureSeedKeys = ['organizations', 'users'];

function buildFixtureMatrix() {
  return buildMatrix(
    parseSpecOperations(fixtureSpec),
    parseEmulatorRoutes([fixtureRouteSource]),
    fixtureSeedKeys,
    fixtureFeatures,
  );
}

describe('path normalization', () => {
  it('converts OpenAPI params to Hono form', () => {
    expect(specPathToHono('/organizations/{id}')).toBe('/organizations/:id');
    expect(specPathToHono('/user_management/users/{userId}/api_keys')).toBe('/user_management/users/:userId/api_keys');
  });

  it('matches params regardless of their name', () => {
    expect(normalizePath('/organizations/:id')).toBe(normalizePath('/organizations/:organization_id'));
    expect(routeKey('get', '/Directories/:id')).toBe('GET /directories/:param');
  });

  it('ignores a trailing slash', () => {
    expect(normalizePath('/organizations/')).toBe('/organizations');
  });
});

describe('parseSpecOperations', () => {
  it('flattens every method into its own operation', () => {
    const ops = parseSpecOperations(fixtureSpec);
    expect(ops).toHaveLength(9);
    expect(ops.filter((o) => o.method === 'GET')).toHaveLength(5);
  });

  it('normalizes paths and keeps the first tag', () => {
    const op = parseSpecOperations(fixtureSpec).find((o) => o.path === '/organizations/:id' && o.method === 'GET');
    expect(op?.tag).toBe('organizations');
  });
});

describe('parseEmulatorRoutes', () => {
  it('extracts method and path from route registrations', () => {
    const routes = parseEmulatorRoutes([fixtureRouteSource]);
    expect(routes).toHaveLength(6);
    expect(routes[0]).toEqual({ method: 'GET', path: '/organizations' });
  });

  it('finds multiple registrations on one line', () => {
    const routes = parseEmulatorRoutes([`app.get('/a', h); app.post('/b', h);`]);
    expect(routes.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('resolves template literals with const variable interpolation', () => {
    const source = [
      `const prefix = '/authorization/organizations/:orgId/roles';`,
      `app.put(\`${'${prefix}'}/priority\`, (c) => {});`,
      `app.delete(\`${'${prefix}'}/:slug/permissions/:permissionSlug\`, (c) => {});`,
    ].join('\n');
    const routes = parseEmulatorRoutes([source]);
    expect(routes).toContainEqual({ method: 'PUT', path: '/authorization/organizations/:orgId/roles/priority' });
    expect(routes).toContainEqual({
      method: 'DELETE',
      path: '/authorization/organizations/:orgId/roles/:slug/permissions/:permissionSlug',
    });
  });

  it('skips template literals with unresolved interpolations', () => {
    const source = `app.get(\`${'${unknown}'}/path\`, (c) => {});`;
    const routes = parseEmulatorRoutes([source]);
    expect(routes).toHaveLength(0);
  });

  it('expands registerRoleRoutes helper with a literal pathPrefix', () => {
    const source = [
      `registerRoleRoutes(ctx, {`,
      `  pathPrefix: '/authorization/roles',`,
      `  roleType: 'EnvironmentRole',`,
      `});`,
    ].join('\n');
    const routes = parseEmulatorRoutes([source]);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /authorization/roles',
      'GET /authorization/roles',
      'GET /authorization/roles/:slug',
      'PUT /authorization/roles/:slug',
      'DELETE /authorization/roles/:slug',
      'GET /authorization/roles/:slug/permissions',
      'POST /authorization/roles/:slug/permissions',
    ]);
  });

  it('expands registerRoleRoutes helper with a variable pathPrefix', () => {
    const source = [
      `const prefix = '/authorization/organizations/:orgId/roles';`,
      `registerRoleRoutes(ctx, {`,
      `  pathPrefix: prefix,`,
      `  roleType: 'OrganizationRole',`,
      `});`,
    ].join('\n');
    const routes = parseEmulatorRoutes([source]);
    expect(routes).toHaveLength(7);
    expect(routes[0]).toEqual({ method: 'POST', path: '/authorization/organizations/:orgId/roles' });
  });
});

describe('parseSeedConfigKeys', () => {
  const source = `
export interface ErrorHookSeedConfig {
  status?: number;
}

export interface EmulatorSeedConfig {
  apiKeys?: WorkOSSeedConfig['apiKeys'];
  organizations?: WorkOSSeedConfig['organizations'];
  errorHooks?: ErrorHookSeedConfig[];
}

export interface EmulatorOptions {
  port?: number;
}
`;

  it('reads the declared keys', () => {
    expect(parseSeedConfigKeys(source)).toEqual(['apiKeys', 'organizations', 'errorHooks']);
  });

  it('does not bleed into neighbouring interfaces', () => {
    expect(parseSeedConfigKeys(source)).not.toContain('port');
    expect(parseSeedConfigKeys(source)).not.toContain('status');
  });

  it('throws when the interface is missing', () => {
    expect(() => parseSeedConfigKeys('export interface Something { a?: string }')).toThrow(
      /Could not find .*EmulatorSeedConfig/,
    );
  });
});

describe('deriveSetup', () => {
  const seedKeys = ['organizations', 'users'];

  it('reports seeding when the feature declares a valid seed key', () => {
    const cell = deriveSetup({ name: 'Organizations', tags: [], seedKeys: ['organizations'] }, seedKeys, 2);
    expect(cell).toEqual({ level: 'full', label: 'seed `organizations`' });
  });

  it('falls back to API-only when creating endpoints exist but seeding does not', () => {
    const cell = deriveSetup({ name: 'Audit Logs', tags: [] }, seedKeys, 3);
    expect(cell).toEqual({ level: 'partial', label: 'API only' });
  });

  it('reports no setup path when nothing can create data', () => {
    const cell = deriveSetup({ name: 'Directory Sync', tags: [] }, seedKeys, 0);
    expect(cell).toEqual({ level: 'none', label: 'none' });
  });

  it('reports automatic for features whose data is a side effect', () => {
    const cell = deriveSetup({ name: 'Events', tags: [], automatic: true }, seedKeys, 0);
    expect(cell).toEqual({ level: 'full', label: 'automatic' });
  });

  it('throws when a declared seed key is not on EmulatorSeedConfig', () => {
    expect(() => deriveSetup({ name: 'Directory Sync', tags: [], seedKeys: ['directories'] }, seedKeys, 0)).toThrow(
      /declares seed key "directories"/,
    );
  });
});

describe('buildMatrix', () => {
  it('splits coverage into reads and writes', () => {
    const orgs = buildFixtureMatrix().rows.find((r) => r.name === 'Organizations')!;
    expect(orgs.read).toEqual({ covered: 2, total: 2, level: 'full' });
    expect(orgs.write).toEqual({ covered: 1, total: 2, level: 'partial' });
  });

  it('flags a fully covered but unseedable feature as unusable', () => {
    // The whole point of the Set up column: Directory Sync is 100% on both
    // endpoint columns yet has no way to create data. Its one implemented
    // write is a DELETE, which must not count as a setup path.
    const dsync = buildFixtureMatrix().rows.find((r) => r.name === 'Directory Sync')!;
    expect(dsync.read.level).toBe('full');
    expect(dsync.write.level).toBe('full');
    expect(dsync.setup).toEqual({ level: 'none', label: 'none' });
  });

  it('does not treat an implemented DELETE as a way to create data', () => {
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/things/{id}': { delete: { tags: ['things'] } } } }),
      parseEmulatorRoutes([`app.delete('/things/:id', (c) => {});`]),
      [],
      [{ name: 'Things', tags: ['things'] }],
    );
    expect(matrix.rows[0].write.level).toBe('full');
    expect(matrix.rows[0].setup.level).toBe('none');
  });

  it('counts emulator-only creation routes toward setup without crediting coverage', () => {
    // Feature Flags' real shape: the emulator uses a different verb than the
    // spec, so the route counts as a setup path but not as coverage.
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/feature-flags/{slug}/enable': { put: { tags: ['ff'] } } } }),
      parseEmulatorRoutes([`app.post('/feature-flags/:slug/enable', (c) => {});`]),
      [],
      [{ name: 'Feature Flags', tags: ['ff'] }],
    );
    expect(matrix.rows[0].write).toEqual({ covered: 0, total: 1, level: 'none' });
    expect(matrix.rows[0].setup).toEqual({ level: 'partial', label: 'API only' });
    expect(matrix.totals.covered).toBe(0);
  });

  it('picks up a create route added under a feature with no explicit prefix', () => {
    // The regression that matters: adding POST /directories must flip Directory
    // Sync off "no way to create data" with no edit to the feature map.
    const spec = { paths: { '/directories': { get: { tags: ['directories'] } } } };
    const features = [{ name: 'Directory Sync', tags: ['directories'] }];

    const before = buildMatrix(parseSpecOperations(spec), parseEmulatorRoutes([]), [], features);
    expect(before.rows[0].setup.level).toBe('none');

    const after = buildMatrix(
      parseSpecOperations(spec),
      parseEmulatorRoutes([`app.post('/directories', (c) => {});`]),
      [],
      features,
    );
    expect(after.rows[0].setup).toEqual({ level: 'partial', label: 'API only' });
  });

  it('attributes a nested route to the most specific feature', () => {
    const matrix = buildMatrix(
      parseSpecOperations({
        paths: {
          '/organizations': { get: { tags: ['orgs'] } },
          '/organizations/{id}/feature-flags': { get: { tags: ['ff'] } },
        },
      }),
      parseEmulatorRoutes([`app.post('/organizations/:id/feature-flags', (c) => {});`]),
      [],
      [
        { name: 'Organizations', tags: ['orgs'] },
        { name: 'Feature Flags', tags: ['ff'] },
      ],
    );
    expect(matrix.rows.find((r) => r.name === 'Feature Flags')!.setup.level).toBe('partial');
    expect(matrix.rows.find((r) => r.name === 'Organizations')!.setup.level).toBe('none');
  });

  it('ignores emulator routes outside every feature prefix', () => {
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/a': { get: { tags: ['t'] } } } }),
      parseEmulatorRoutes([`app.post('/unrelated', (c) => {});`]),
      [],
      [{ name: 'T', tags: ['t'] }],
    );
    expect(matrix.rows[0].setup.level).toBe('none');
  });

  it('treats an implemented POST as an API-only setup path', () => {
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/things': { post: { tags: ['things'] } } } }),
      parseEmulatorRoutes([`app.post('/things', (c) => {});`]),
      [],
      [{ name: 'Things', tags: ['things'] }],
    );
    expect(matrix.rows[0].setup).toEqual({ level: 'partial', label: 'API only' });
  });

  it('marks an unimplemented feature as none on both columns', () => {
    const vault = buildFixtureMatrix().rows.find((r) => r.name === 'Vault')!;
    expect(vault.read.level).toBe('none');
    expect(vault.write.level).toBe('none');
  });

  it('totals coverage across every feature', () => {
    expect(buildFixtureMatrix().totals).toEqual({ covered: 6, total: 9 });
  });

  it('reports n/a for a feature with no endpoints of that kind', () => {
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/widgets': { post: { tags: ['widgets'] } } } }),
      [],
      [],
      [{ name: 'Widgets', tags: ['widgets'] }],
    );
    expect(matrix.rows[0].read).toEqual({ covered: 0, total: 0, level: 'n/a' });
  });

  it('throws when a spec tag is not assigned to a feature', () => {
    expect(() => buildMatrix(parseSpecOperations(fixtureSpec), [], fixtureSeedKeys, [fixtureFeatures[0]])).toThrow(
      /Spec tags are not assigned to a feature: directories, vault/,
    );
  });

  it('throws when two features claim the same tag', () => {
    expect(() =>
      buildMatrix(
        [],
        [],
        [],
        [
          { name: 'A', tags: ['shared'] },
          { name: 'B', tags: ['shared'] },
        ],
      ),
    ).toThrow(/claimed by both "A" and "B"/);
  });
});

describe('generateSupportedMarkdown', () => {
  it('renders one table row per feature with icons', () => {
    const md = generateSupportedMarkdown(buildFixtureMatrix());
    expect(md).toContain('| Organizations | ✅ 2/2 | ⚠️ 1/2 | ✅ seed `organizations` |');
    expect(md).toContain('| Directory Sync | ✅ 2/2 | ✅ 1/1 | ❌ none | Read-only. |');
  });

  it('leads with the headline coverage number', () => {
    expect(generateSupportedMarkdown(buildFixtureMatrix())).toContain('**6 of 9** endpoints');
    expect(generateSupportedMarkdown(buildFixtureMatrix())).toContain('**66.7%**');
  });

  it('includes the spec version when given', () => {
    const md = generateSupportedMarkdown(buildFixtureMatrix(), { specVersion: '0.41.0' });
    expect(md).toContain('`@workos/openapi-spec@0.41.0`');
  });

  it('marks the file as generated', () => {
    expect(generateSupportedMarkdown(buildFixtureMatrix())).toStartWith('<!-- Generated by');
  });

  it('escapes pipes so notes cannot break the table', () => {
    const matrix = buildMatrix(
      parseSpecOperations({ paths: { '/a': { get: { tags: ['t'] } } } }),
      [],
      [],
      [{ name: 'T', tags: ['t'], notes: 'a | b' }],
    );
    expect(generateSupportedMarkdown(matrix)).toContain('a \\| b');
  });
});

describe('FEATURES (the real map)', () => {
  it('never claims a tag twice', () => {
    const seen = new Set<string>();
    for (const feature of FEATURES) {
      for (const tag of feature.tags) {
        expect(seen.has(tag)).toBe(false);
        seen.add(tag);
      }
    }
  });

  it('gives every feature at least one tag', () => {
    for (const feature of FEATURES) {
      expect(feature.tags.length).toBeGreaterThan(0);
    }
  });
});
