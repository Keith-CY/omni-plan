# Fluent Design Migration Plan

## Summary

Goal: restyle OmniPlan Personal into a Microsoft Fluent 2 web experience while preserving the current portfolio-first project-management workflow.

The five independent UI reviewers converged on the same conclusion: the current product structure is useful, but the visual system is far from Fluent 2. Current Fluent fit is approximately 2-3/10. The app reads as a custom editorial/control-room dashboard because of oversized serif headings, a paper-grid background, a dark custom rail, warm bespoke colors, heavy panel shadows, custom status pills, and hand-rolled tables/lists.

This migration should not rewrite the product model. It should replace the visual language and interaction primitives with Fluent 2 components, tokens, density, and responsive patterns.

## Target Style

Use Microsoft Fluent 2 for web:

- `@fluentui/react-components`
- `@fluentui/react-icons`
- `FluentProvider` with `webLightTheme`
- Segoe UI/system typography
- Neutral Fluent backgrounds, strokes, surfaces, shadows, and semantic status tokens
- Compact productivity density suitable for project management

Primary reference links:

- https://fluent2.microsoft.design/
- https://fluent2.microsoft.design/components/web/react
- https://react.fluentui.dev/
- https://developer.microsoft.com/en-us/fluentui

## Preserve

Keep these product decisions intact:

- Six-page IA: Portfolio, Project, Today, Audit, Reports, Settings
- Portfolio-first workflow
- Global search
- Project health, hard gates, audit status, and evidence freshness
- Recommended Focus ranking
- Momentum x Risk matrix
- Project Outline, Gantt, Network, Inspector
- Today due/upcoming execution split
- Audit Queue grouping: hard gates, warnings, decisions, baseline changes, leveling proposals
- Reports copy/download workflow
- Sample-as-of and hard-gate truthfulness
- Mobile feature completeness

## Global Problems To Fix

### 1. Non-Fluent Typography

Current issues:

- Georgia hero headings make the app feel editorial.
- Heading sizes are too large for a productivity tool.
- Avenir/Gill Sans stack does not feel Microsoft 365 aligned.

Required change:

- Use Segoe UI/system font stack.
- Replace hero-scale page titles with compact Fluent title/subtitle hierarchy.
- Use Fluent text sizes and weights consistently.

### 2. Non-Fluent Color And Surface System

Current issues:

- Custom `--ink`, `--paper`, `--cyan`, `--amber`, `--plum`, `--red`.
- Paper-grid background and olive/dark rail create a bespoke brand language.
- Heavy shadows and tinted panels make the interface visually noisy.

Required change:

- Replace custom palette with Fluent theme tokens.
- Use neutral app background, neutral cards, subtle strokes, and selective elevation.
- Use semantic danger/warning/success tokens for audit states.

### 3. Custom Shell And Navigation

Current issues:

- Dark icon rail is custom and not Fluent `Nav`.
- Mobile nav becomes icon-only, which Fluent reviewers flagged as weak.
- Header action area is a mix of custom badges/buttons instead of a toolbar.

Required change:

- Use Fluent `Nav` or `NavDrawer`.
- Use `Breadcrumb` for route context.
- Use top `Toolbar` for Search, as-of badge, audit status, and report actions.
- On mobile, prefer a drawer or compact labeled navigation instead of pure icon-only navigation.

### 4. Overuse Of Cards

Current issues:

- Nearly every section is framed as a card.
- Nested card-like areas reduce hierarchy and scanning efficiency.
- Shadows are too heavy for Fluent.

Required change:

- Use `Card` only for repeated objects or distinct content units.
- Use full-width neutral sections and data surfaces for page structure.
- Use Fluent stroke/elevation tokens sparingly.

### 5. Status Styling Is Fragmented

Current issues:

- Hard gates, warnings, audit states, locks, dots, pills, and red panels all use different custom treatments.

Required change:

- Use `Badge` for compact status.
- Use `MessageBar` for page-level or section-level blockers.
- Use semantic tokens for danger/warning/success/info.
- Keep hard-gate urgency visible; do not flatten blockers into neutral styling.

### 6. Tables And Lists Are Too Generic

Current issues:

- Outline, reports, leveling proposals, settings rows, and task rows are plain custom tables/cards.
- Missing Fluent row states, density, hover, sort/filter affordances, and selection patterns.

Required change:

- Use Fluent `Table`, `DataGrid`, `List`, or `Tree` patterns where appropriate.
- Use compact density for project-management screens.
- Add row hover, focus, and selected states.

### 7. Search Is Not Fluent

Current issues:

- Search opens from an icon into a custom inline panel.

Required change:

- Use Fluent `SearchBox`.
- Use `Popover` or command/result surface for search results.
- Keep current deep-link behavior: search result should route, scroll, and highlight the matched item.

### 8. Custom Visualizations Are Visually Detached

Current issues:

- Gantt, Network, and Momentum x Risk use custom SVG styling that does not inherit Fluent token colors/strokes.

Required change:

- Keep custom visualizations, but token-align them.
- Use Fluent neutral strokes, brand accents, semantic critical/warning colors, tooltip behavior, focus rings, and accessible summaries.

## Component Migration Map

| Current Element | Fluent Replacement |
| --- | --- |
| `sideRail`, `navButton` | `Nav`, `NavDrawer`, labeled mobile nav |
| `topBar`, `topActions` | `Toolbar`, `Breadcrumb`, compact page header |
| Search icon + custom panel | `SearchBox` + `Popover` |
| `statusAction`, `asOfBadge`, `modePill`, `datePill` | `Badge`, `Tag`, `MessageBar` where needed |
| Metric blocks | `Card` with compact header/body |
| Project cards | `Card` or `List` row depending density |
| Outline table | `DataGrid` or `TreeGrid` style WBS table |
| Task rows | `List` rows with `Badge` and inline actions |
| Audit hard/warning signals | `MessageBar` + `Badge` + `List` |
| Leveling proposals | `DataGrid` |
| Reports actions | `Toolbar` + Fluent `Button` |
| Settings rows | `Field`, `Input`, `Switch`, `Button`, `InfoLabel`, disabled controls |
| Modal/popover needs | `Dialog`, `Drawer`, `Popover` |
| Tooltips | Fluent `Tooltip` |

## Page-Level Redesign

### Portfolio

Keep:

- Metric strip
- Control Brief
- Recommended Focus
- Momentum x Risk
- Audit Signals

Change:

- Replace current editorial dashboard styling with neutral Fluent dashboard.
- Show hard-gate summary as `MessageBar`.
- Metric strip becomes compact Fluent `Card`s.
- Recommended Focus becomes a dense `List` or card-list with `Badge`s.
- Momentum x Risk remains custom, but uses Fluent tokens and tooltips.
- Remove paper background and heavy card shadows.

### Project

Keep:

- Project selector
- Next action, audit state, evidence state
- Outline, Gantt, Network, Inspector

Change:

- Project toolbar uses Fluent `Toolbar` + `Select` or `Combobox`.
- Use `TabList` or split-pane navigation for Outline/Gantt/Network/Inspector on smaller screens.
- Outline becomes `DataGrid` or WBS `Tree`/treegrid style.
- Inspector becomes a right `Drawer` on smaller viewports.
- Gantt and Network stay custom but use Fluent tokens, hover/focus states, and `Tooltip`.

### Today

Keep:

- Due/Overdue
- Upcoming Watchlist
- Blocking Gates
- Hard-gate lock and warning distinction

Change:

- Convert task cards into compact Fluent `List` rows.
- Use `Badge` for timing, critical path, lock, and warning.
- Use `MessageBar` for project-level or section-level blockers.
- Reduce empty space and improve row density.

### Audit

Keep:

- Hard Gates
- Warnings
- Contrarian Decisions
- Baseline Change Sets
- Leveling Proposals

Change:

- Hard gates and warnings use `MessageBar`/semantic status surfaces.
- Decisions use compact `Card`s or list rows.
- Leveling proposals use `DataGrid`.
- Baseline changes use `List` rows with status `Badge`s.

### Reports

Keep:

- Gate status
- EVM/Monte Carlo metrics
- Markdown export
- CSV export
- Schedule rows

Change:

- Gate status becomes a `MessageBar`.
- Copy/Download actions move into a Fluent `Toolbar`.
- Markdown/CSV/Rows can be organized with `TabList`.
- Replace dark code block with neutral preview surface unless syntax contrast is explicitly needed.
- Report rows use Fluent `Table`.

### Settings

Keep:

- Provider secrets category
- Storage category
- Pending adapter truthfulness
- Preview clock

Change:

- Use Fluent settings layout: `Field`, disabled `Input`, `Button`, `Switch`, `Badge`, helper text.
- Mark pending adapters with status `Badge`s.
- Avoid static two-column text blocks.

## Implementation Phases

### Phase 1: Fluent Foundation

Tasks:

- Add `@fluentui/react-components`.
- Add `@fluentui/react-icons`.
- Wrap app with `FluentProvider`.
- Create a small token bridge for custom chart colors.
- Replace global font stack with Segoe UI/system.
- Remove paper-grid background.
- Replace custom CSS variables with Fluent-compatible token names or direct Fluent tokens.

Acceptance:

- App visually shifts to neutral Fluent baseline.
- No page-level layout regressions.
- `bun test` and `bun run build` pass.

### Phase 2: Shell And Navigation

Tasks:

- Replace side rail with Fluent-like `Nav`/`NavDrawer`.
- Replace top bar with compact page header, `Breadcrumb`, and `Toolbar`.
- Replace search button/panel with `SearchBox` + result `Popover`.
- Replace audit/as-of custom badges with Fluent `Badge`/`MessageBar`.
- Fix mobile navigation so labels remain available through drawer or compact labeled nav.

Acceptance:

- Navigation reads as Microsoft 365/Fluent.
- Browser back behavior still returns to previous app page.
- Search still routes, scrolls, and highlights matches.
- Mobile navigation remains feature-complete.

### Phase 3: Status And Data Surfaces

Tasks:

- Convert hard gates and warnings to `MessageBar`/`Badge` patterns.
- Convert Outline, Reports rows, and Leveling proposals to Fluent table/data-grid styling.
- Convert Today task rows and Audit rows to Fluent list rows.
- Add consistent row hover/focus/selected states.

Acceptance:

- Hard blockers remain visually urgent.
- Warnings are visible but not confused with locks.
- Data surfaces feel denser and more Microsoft-aligned.

### Phase 4: Page Polish

Tasks:

- Restyle Portfolio metrics, focus list, and risk matrix.
- Restyle Project Gantt and Network with Fluent tokens.
- Restyle Reports preview and toolbar.
- Restyle Settings as real Fluent settings forms.
- Add tooltips for icon-only or dense controls.

Acceptance:

- Each page feels like the same Fluent application.
- Custom charts no longer look bolted on.
- Mobile layouts do not clip top actions or titles.

### Phase 5: Verification

Tasks:

- Run `bun test`.
- Run `bun run build`.
- Browser smoke test all routes.
- Check desktop and mobile widths.
- Check keyboard focus on navigation, search, tables, and report actions.
- Check color contrast for hard/warning/info/success states.

Acceptance:

- No console errors.
- No page-level horizontal overflow.
- Key workflows remain intact:
  - Portfolio to Project
  - Search to task highlight
  - Project selector
  - Browser back
  - Today hard gate vs warning semantics
  - Reports copy/download

## Recommended First Implementation Batch

Start with a style-system cut, not page-by-page repainting:

1. Add Fluent dependencies and `FluentProvider`.
2. Replace typography and background.
3. Replace side rail/top bar/search with Fluent shell patterns.
4. Introduce `Badge` and `MessageBar` wrappers for audit status.
5. Convert Outline and Leveling Proposal tables to Fluent-styled data tables.
6. Tokenize Gantt/Network/Matrix colors.

This order prevents the app from becoming a half-Fluent, half-custom hybrid for too long.

## Non-Goals For This Migration

- Do not change scheduling logic.
- Do not change data model.
- Do not remove custom Gantt, Network, or Matrix views.
- Do not hide audit urgency to make the interface calmer.
- Do not turn the app into a marketing-style landing page.
- Do not overuse Fluent `Card` as a generic section wrapper.
