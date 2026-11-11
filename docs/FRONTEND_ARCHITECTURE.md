# Frontend architecture and UI system

## Current transition state
The existing product UI began as one HTML document containing the application script and inline styling. This change establishes an asset boundary without pretending the four portals are already independent:
- `public/index.html`: minimal HTML shell and vendor asset references.
- `public/app.js`: extracted legacy application runtime. It still contains legacy routing, API calls and view renderers; it is not yet four portal bundles.
- `public/ui.css`: shared visual tokens and responsive shell overrides. Product-specific tokens must move into each portal as the split proceeds.

## UI principles
- Clear hierarchy: product identity, workspace navigation, page title, primary action, filters, content and secondary actions.
- Consistent spacing, typography, surface, border, radius, focus and status tokens.
- Responsive navigation: desktop sidebar; compact horizontally scrollable navigation on small screens.
- Accessible keyboard focus, readable contrast and reduced-motion support.
- Keep business operations and authorization in the server. UI hiding is never an authorization boundary.
- No cross-product menu or shared session state after the four portals are live.

## Target source layout
```
apps/
  rental-web/
    src/{app,auth,api,layout,features,styles}/
  hotel-web/
    src/{app,auth,api,layout,features,styles}/
  property-web/
    src/{app,auth,api,layout,features,styles}/
  super-admin-web/
    src/{app,auth,api,layout,features,styles}/
packages/
  ui-primitives/       # presentational primitives only; no tenant data/auth
  design-tokens/       # neutral tokens; each portal may theme independently
```

## Migration sequence
1. Extract static shell, scripts and styles (this batch).
2. Characterize current views and API contracts with browser/API regression tests.
3. Split app entrypoints and layouts one product at a time; keep separate auth audiences and API origins.
4. Move product-specific screens into feature modules; remove legacy router only after route parity.
5. Add visual regression, keyboard navigation, mobile viewport and accessibility checks.
6. Retire the legacy single-page entrypoint after staged deployment and rollback window.

## Dependency policy
- Node.js 24 LTS is the current compatibility baseline for this branch.
- Bootstrap CSS is pinned to 5.3.8; Bootstrap Icons to 1.13.2.
- npm and GitHub Actions updates are managed by Dependabot against this refactor branch.
- Express 4 to Express 5 is a major migration and must be validated with API regression tests before its lockfile update is accepted. The official migration guide documents breaking changes: https://expressjs.com/en/guide/migrating-5/
- Do not run blind major upgrades or commit a package manifest without a matching lockfile.
