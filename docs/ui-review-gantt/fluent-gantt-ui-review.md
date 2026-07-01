# Fluent Gantt UI Review

Date: 2026-07-01
Surface: `public/gantt-dependencies-demo.html`
Goal: make the Gantt demo feel like a Microsoft Fluent professional planning workspace, not a standalone technical demo.

## Evidence Captured

- `01-blocked-cascade.png`: default blocked gate and dependency cascade state.
- `02-300-task-stress.png`: 300 task stress state.
- `03-parallel-release.png`: SS / FF / SF dependency state.
- Matching `.snapshot.txt` and `.metrics.json` files are saved beside each screenshot.

## Agent Consensus

All three reviewers converged on the same priority:

1. The Gantt surface has promising scheduling grammar.
2. The surrounding page still reads as a demo page.
3. The first viewport is wasted by a large blank band.
4. The right inspector is valuable, but should become a scheduling debugger / audit panel.
5. Dependency marks need to explain causality, not only draw connections.

## P0 Fixes

### 1. Remove The Demo Shell

Current issue:
- The title says "Professional Gantt Dependency Demo".
- The subtitle exposes implementation details: "Canvas/SVG hybrid prototype...".
- Scenario buttons float in the page as test cases.
- A large blank area pushes the actual work surface to the lower half of the viewport.

Recommendation:
- Replace the top area with a compact Fluent app command bar.
- Use product language:
  - Project: `OmniPlan Personal / Scheduling Engine`
  - View: `Plan`
  - Scenario: `Blocked release gate`
  - Status: `Gate blocked`
- Remove visible "Demo" and implementation copy.
- Move the Gantt frame directly under the command bar.

### 2. Fix App Shell Layout

Current issue:
- The shell creates a large empty middle area before the workspace.
- The main chart does not own the first viewport.

Recommendation:
- Use a three-row app shell: command bar, scenario/audit strip, workspace.
- Keep the workspace row as `minmax(0, 1fr)`.
- Keep the Gantt frame visible immediately after the command surface.

Target first-read:
- User sees project identity, schedule pressure, audit gate state, and the Gantt without scrolling.

## P1 Fluent Design System

### 3. Adopt Fluent Command Structure

Current issue:
- Buttons and chips are generic pill controls.
- Scenario, focus, dependency filters, zoom, trace, and simulation controls feel bolted on.

Recommendation:
- Use compact Fluent toolbar groups:
  - `View`: Plan, Dependencies, Audit, Baselines
  - `Scenario`: Blocked gate, Critical path, Parallel release, Stress test
  - `Trace`: Critical path, Blocked chain, Baseline variance
  - `Commands`: Zoom, Simulate slip, Compare baseline, Export
- Add restrained Fluent-style icons for trace, zoom, simulate, baseline, warning, blocked gate, and milestone.

### 4. Tighten Type, Elevation, And Density

Recommendation:
- Use `Segoe UI Variable` first, then system fallbacks.
- Use a strict type scale: 12, 14, 16, 20.
- Use 1px neutral strokes, smaller shadows, and flatter command surfaces.
- Keep dense rows, but improve readable labels and selected state.
- Reduce card-like decoration around page sections; reserve panels for inspector and repeated items.

### 5. Normalize Semantic Color

Recommended color semantics:
- Blue: selection, active trace, primary command.
- Red: blocked gates and violated dependencies.
- Amber: delay, risk, schedule pressure.
- Green: completed work.
- Gray: baseline, ghost bars, inactive dependencies.
- Purple should be limited to special task types such as hammock tasks.

Implementation note:
- Lower saturation and opacity for non-selected bars and dependencies.
- Make the active chain visually dominant without making the whole chart noisy.

## P1 Gantt And Dependency Grammar

### 6. Make Dependency Types Legible

Current issue:
- FS / SS / FF / SF labels exist, but start-vs-finish endpoints are not explicit enough.

Recommendation:
- Add small start and finish ports on selected or hovered bars.
- Render dependency labels as:
  - `F->S +3d`
  - `S->S +4d`
  - `F->F +1d`
  - `S->F`
- Place labels closer to dependency edges, not as detached tags.

### 7. Explain Causality, Not Only Paths

Current issue:
- Dependency lines show connection, but not the scheduling reason.

Recommendation:
- Add numbered causal steps on the selected path.
- In the inspector, show scheduling equations:
  - `1.5 finish + 3d lag = earliest start Aug 18`
  - `Evidence blocked -> milestone cannot complete`
- For violated gates, show the failing rule before the metric grid.

### 8. Separate Task-State Visual Layers

Current issue:
- Baseline, current, split, hammock, milestone, delayed, blocked, and critical all compete in one visual lane.

Recommended row grammar:
- Baseline: thin gray underlay.
- Current task: solid main bar.
- Variance: red or blue tail from baseline to current.
- Split task: explicit segment breaks.
- Hammock: bracket/span style, not a normal task bar.
- Milestone: diamond with gate status.
- Critical path: top accent or edge treatment, not full recoloring of every mark.

## P1 Inspector Redesign

### 9. Turn Inspector Into An Audit Debugger

Current issue:
- The inspector has useful facts, but the primary conclusion is buried.

Recommendation:
- Inspector order:
  1. Gate or constraint verdict.
  2. Selected task identity and date window.
  3. Why this date is constrained.
  4. Baseline variance, float, downstream impact.
  5. Direct dependencies.
  6. Recommended action.

Example header:

```text
Gate blocked
Evidence package is preventing milestone completion
1.5 finish + 3d lag -> earliest start Aug 18
```

### 10. Make Dependency Rows Actionable

Recommendation:
- Each dependency row should support:
  - jump to predecessor / successor
  - edit dependency type
  - edit lag / lead
  - remove link
  - explain why it affects the selected task

## P2 Scale And Navigation

### 11. Make 300 Tasks Feel Intentionally Scalable

Current issue:
- Stress mode works technically but visually looks like a normal short chart.

Recommendation:
- Add scale metadata:
  - `300 tasks`
  - `52 weeks`
  - `showing rows 1-48`
  - `14 groups`
  - `critical chain length`
- Add density mode control: Comfortable / Compact / Dense.
- Keep row virtualization invisible, but show navigation affordances.

### 12. Upgrade Minimap

Recommendation:
- Add a visible viewport rectangle.
- Add critical / blocked heat bands.
- Let users click or drag the viewport in the minimap.
- Show range and zoom scale.

## Recommended Implementation Order

1. Fix shell layout and remove the giant blank band.
2. Replace demo title/subtitle/scenario row with Fluent command bar.
3. Normalize typography, color tokens, strokes, shadows, and button states.
4. Redesign inspector header into audit-debugger mode.
5. Improve dependency labels and endpoint ports.
6. Add scale metadata for 300-task stress.
7. Upgrade minimap after the main layout is stable.

## Acceptance Criteria

- The Gantt surface starts in the first viewport without scrolling.
- No visible copy says "demo" or exposes implementation technology.
- Controls read as product commands, not test cases.
- Selected task, selected dependency, blocked gate, and baseline variance are visually distinct.
- FS / SS / FF / SF relationships can be understood without reading the code.
- The right panel answers "what constrains this date?" within the first two lines.
- 300-task mode communicates scale without adding visible clutter.
