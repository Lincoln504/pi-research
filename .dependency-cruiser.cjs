/**
 * Dependency Cruiser configuration for pi-research
 *
 * Enforces layer architecture, bans circular dependencies, and generates a
 * colour-coded SVG dependency graph.
 *
 * Layer order (dependency may only flow downward):
 *   index.ts / commands / tui / observers / cleanup
 *     └─ orchestration
 *          └─ tools / security / stackexchange / web-research
 *               └─ infrastructure
 *                    └─ knowledge
 *                         └─ core (interfaces, services, DI)
 *                              └─ utils / config / logger / types
 *
 * Composition-root exceptions: core/service-initialization.ts and
 * infrastructure/service-initialization.ts are allowed to import across layers
 * because they wire the DI container — they are intentional composition roots.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ───────────────────────────────────────────────────────────────────────
    // HARD RULES — break the build
    // ───────────────────────────────────────────────────────────────────────

    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies indicate a design problem and must be eliminated.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      comment: 'Source files must never import from the test directory.',
      from: { pathNot: '^(test|config/tooling)/' },
      to: { path: '^test/' },
    },
    {
      name: 'not-to-dist',
      severity: 'error',
      comment: 'Source files must not import from build artefacts.',
      from: {},
      to: { path: '^dist/' },
    },

    // ───────────────────────────────────────────────────────────────────────
    // ARCHITECTURAL LAYER RULES — break the build
    // ───────────────────────────────────────────────────────────────────────

    /**
     * utils/ and types/ are foundation — no imports from any named layer above.
     * (They may import from Node built-ins and external packages freely.)
     */
    {
      name: 'utils-not-to-upper-layers',
      severity: 'error',
      comment:
        'utils/ and types/ are foundation layers. They must not depend on ' +
        'core/, knowledge/, infrastructure/, orchestration/, tools/, security/, ' +
        'stackexchange/, web-research/, tui/, commands/, observers/, or cleanup/.',
      from: { path: '^src/(utils|types)/' },
      to: {
        path: '^src/(core|knowledge|infrastructure|orchestration|tools|security|stackexchange|web-research|tui|commands|observers|cleanup)/',
      },
    },

    /**
     * core/ (interfaces + services) must not depend on anything above it.
     * Exception: the two composition-root service-initialization files are
     * explicitly allowed to register concrete implementations.
     */
    {
      name: 'core-not-to-upper-layers',
      severity: 'error',
      comment:
        'core/ must not depend on infrastructure/, orchestration/, tools/, ' +
        'security/, stackexchange/, web-research/ (except types), tui/, ' +
        'commands/, observers/, or cleanup/. ' +
        'Use core/service-initialization.ts (composition root) for wiring.',
      from: {
        path: '^src/core/',
        // service-initialization.ts is the composition root (registers all services).
        // scheduler-service.ts uses a dynamic import of browser-lifecycle.ts in its
        // dispose() method only — intentional to avoid a static circular dep.
        pathNot: '^src/core/(service-initialization|scheduler-service)\\.ts$',
      },
      to: {
        path: '^src/(infrastructure|orchestration|tools|security|stackexchange|tui|commands|observers|cleanup)/',
      },
    },

    /**
     * knowledge/ (embedder + vector store) must not depend on anything above it.
     */
    {
      name: 'knowledge-not-to-upper-layers',
      severity: 'error',
      comment:
        'knowledge/ must not depend on infrastructure/, orchestration/, tools/, ' +
        'security/, stackexchange/, tui/, commands/, observers/, or cleanup/.',
      from: { path: '^src/knowledge/' },
      to: {
        path: '^src/(infrastructure|orchestration|tools|security|stackexchange|tui|commands|observers|cleanup)/',
      },
    },

    /**
     * infrastructure/ must not depend on orchestration/ or the presentation
     * layer. Exception: service-initialization.ts (composition root).
     */
    {
      name: 'infrastructure-not-to-upper-layers',
      severity: 'error',
      comment:
        'infrastructure/ must not depend on orchestration/, tools/, security/, ' +
        'stackexchange/, tui/, commands/, observers/, or cleanup/. ' +
        'Use infrastructure/service-initialization.ts (composition root) for wiring.',
      from: {
        path: '^src/infrastructure/',
        pathNot: '^src/infrastructure/service-initialization\\.ts$',
      },
      to: {
        path: '^src/(orchestration|tools|security|stackexchange|tui|commands|observers|cleanup)/',
      },
    },

    // ───────────────────────────────────────────────────────────────────────
    // WARNINGS — flag for review but do not break the build
    // ───────────────────────────────────────────────────────────────────────

    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Files not reachable from any entry point may be dead code.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig',
          '(^|/)vitest',
          '(^|/)eslint',
          '\\.cjs$',
          '\\.mjs$',
          'src/prompts/',   // markdown prompt files
        ],
      },
      to: {},
    },
  ],

  options: {
    /* Only follow source and resolve TypeScript path aliases */
    doNotFollow: {
      path: 'node_modules',
    },

    /* Resolve TypeScript pre-compilation imports (type-only, etc.) */
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },

    /* ── Visualisation ─────────────────────────────────────────────────── */
    reporterOptions: {
      dot: {
        /* Collapse node_modules to a single box per package */
        collapsePattern: '^node_modules/[^/]+',
        theme: {
          graph: {
            rankdir: 'LR',
            /* 'spline' is usually safer and looks good. */
            splines: 'spline',
            concentrate: 'true',
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '12',
            pad: '0.5',
            /* Horizontal spacing between rank columns */
            ranksep: '1.5',
            /* Vertical spacing between nodes in the same rank */
            nodesep: '0.6',
            bgcolor: '#ffffff',
          },
          node: {
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '10',
            style: 'filled',
            fillcolor: '#f8fafc',
            color: '#94a3b8',
            height: '0.3',
            margin: '0.15,0.05',
          },
          edge: {
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '9',
            color: '#475569',
            arrowsize: '0.7',
            penwidth: '1.0',
          },
          modules: [
            // colour-code by architectural layer (ordered from high-level to low-level)
            {
              criteria: { source: '^src/tui/' },
              attributes: { fillcolor: '#fefce8', color: '#eab308', label: 'tui' },
            },
            {
              criteria: { source: '^src/commands/' },
              attributes: { fillcolor: '#eff6ff', color: '#6366f1', label: 'commands' },
            },
            {
              criteria: { source: '^src/(observers|cleanup|healthcheck)/' },
              attributes: { fillcolor: '#fff1f2', color: '#f43f5e', label: 'support' },
            },
            {
              criteria: { source: '^src/orchestration/' },
              attributes: { fillcolor: '#fef9c3', color: '#ca8a04', label: 'orchestration' },
            },
            {
              criteria: { source: '^src/tools/' },
              attributes: { fillcolor: '#fee2e2', color: '#ef4444', label: 'tools' },
            },
            {
              criteria: { source: '^src/web-research/' },
              attributes: { fillcolor: '#ecfdf5', color: '#10b981', label: 'web-research' },
            },
            {
              criteria: { source: '^src/security/' },
              attributes: { fillcolor: '#fdf2f8', color: '#ec4899', label: 'security' },
            },
            {
              criteria: { source: '^src/stackexchange/' },
              attributes: { fillcolor: '#fff7ed', color: '#f97316', label: 'stackexchange' },
            },
            {
              criteria: { source: '^src/infrastructure/' },
              attributes: { fillcolor: '#dcfce7', color: '#22c55e', label: 'infrastructure' },
            },
            {
              criteria: { source: '^src/knowledge/' },
              attributes: { fillcolor: '#f3e8ff', color: '#a855f7', label: 'knowledge' },
            },
            {
              criteria: { source: '^src/core/' },
              attributes: { fillcolor: '#dbeafe', color: '#3b82f6', label: 'core' },
            },
            {
              criteria: { source: '^src/utils/' },
              attributes: { fillcolor: '#f1f5f9', color: '#64748b', label: 'utils' },
            },
            {
              criteria: { source: '^src/types/' },
              attributes: { fillcolor: '#f8fafc', color: '#94a3b8', label: 'types' },
            },
          ],
          dependencies: [
            {
              criteria: { circular: true },
              attributes: { color: '#dc2626', penwidth: '2.5', style: 'bold' },
            },
            {
              criteria: { 'rules[0].severity': 'error' },
              attributes: { color: '#dc2626', penwidth: '2.0', style: 'dashed' },
            },
            {
              criteria: { 'rules[0].severity': 'warn' },
              attributes: { color: '#d97706', penwidth: '1.5', style: 'dashed' },
            },
          ],
        },
      },

      /* archi: high-level layer view — one box per src/X/ folder. */
      archi: {
        /* Collapse every src/X/ subtree and every node_modules package */
        collapsePattern: '^(src/[^/]+|node_modules/[^/]+)',
        theme: {
          graph: {
            rankdir: 'LR',
            splines: 'spline',
            concentrate: 'true',
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '16',
            pad: '1.0',
            /* Significant spacing between layers */
            ranksep: '2.0',
            nodesep: '1.0',
            label: 'pi-research — architectural layer graph',
            labelloc: 't',
          },
          node: {
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '13',
            style: 'filled,rounded',
            fillcolor: '#f8fafc',
            color: '#94a3b8',
            width: '2.4',
            height: '0.8',
            shape: 'rect',
            penwidth: '2.0',
          },
          edge: {
            fontname: 'Helvetica, Arial, sans-serif',
            fontsize: '11',
            color: '#475569',
            arrowsize: '1.0',
            penwidth: '1.5',
          },
          modules: [
            { criteria: { source: '^src/tui' },            attributes: { fillcolor: '#fefce8', color: '#eab308', label: 'tui' } },
            { criteria: { source: '^src/commands' },       attributes: { fillcolor: '#eff6ff', color: '#6366f1', label: 'commands' } },
            { criteria: { source: '^src/(observers|cleanup|healthcheck)' }, attributes: { fillcolor: '#fff1f2', color: '#f43f5e', label: 'support' } },
            { criteria: { source: '^src/orchestration' },  attributes: { fillcolor: '#fef9c3', color: '#ca8a04', label: 'orchestration' } },
            { criteria: { source: '^src/tools' },          attributes: { fillcolor: '#fee2e2', color: '#ef4444', label: 'tools' } },
            { criteria: { source: '^src/web-research' },   attributes: { fillcolor: '#ecfdf5', color: '#10b981', label: 'web-research' } },
            { criteria: { source: '^src/security' },       attributes: { fillcolor: '#fdf2f8', color: '#ec4899', label: 'security' } },
            { criteria: { source: '^src/stackexchange' },  attributes: { fillcolor: '#fff7ed', color: '#f97316', label: 'stackexchange' } },
            { criteria: { source: '^src/infrastructure' }, attributes: { fillcolor: '#dcfce7', color: '#22c55e', label: 'infrastructure' } },
            { criteria: { source: '^src/knowledge' },      attributes: { fillcolor: '#f3e8ff', color: '#a855f7', label: 'knowledge' } },
            { criteria: { source: '^src/core' },          attributes: { fillcolor: '#dbeafe', color: '#3b82f6', label: 'core' } },
            { criteria: { source: '^src/utils' },          attributes: { fillcolor: '#f1f5f9', color: '#64748b', label: 'utils' } },
            { criteria: { source: '^src/types' },          attributes: { fillcolor: '#f8fafc', color: '#94a3b8', label: 'types' } },
          ],
          dependencies: [
            { criteria: { circular: true },                attributes: { color: '#dc2626', penwidth: '3.0', style: 'bold' } },
            { criteria: { 'rules[0].severity': 'error' },  attributes: { color: '#dc2626', penwidth: '2.0', style: 'dashed' } },
            { criteria: { 'rules[0].severity': 'warn' },   attributes: { color: '#d97706', penwidth: '1.5', style: 'dashed' } },
          ],
        },
      },
    },
  },
};
