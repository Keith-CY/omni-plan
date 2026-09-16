# Design QA — Task-first “温润工具”

## Scope and source of truth

This QA replaces the earlier Quiet Horizons / Fluent visual review. The accepted direction is a shadcn-compatible personal planning tool with warm surfaces and progressive disclosure:

- Desktop reference: `docs/product/task-first/visuals/today-desktop.png`
- Mobile reference: `docs/product/task-first/visuals/today-mobile.png`
- Product specification: `docs/product/task-first/product-spec.md`
- Target experience: instant Task capture first; time, effort, Project, dependency, Gantt, resources, and review only when needed.

The reference images define hierarchy, density, color character, and interaction emphasis. The browser captures use real workspace data, so task names, dates, counts, and bar lengths are intentionally data-driven rather than fabricated to match the reference pixels.

## Final evidence

| Surface | Viewport | Evidence |
| --- | --- | --- |
| Today with schedule and dependencies | 1280 × 720 | `docs/product/task-first/qa/today-desktop-dependencies.png` |
| Today mobile | 390 × 844 | `docs/product/task-first/qa/today-mobile-dependencies.png` |
| Project, advanced planning collapsed | 390 × 844 | `docs/product/task-first/qa/project-mobile-collapsed.png` |
| Project, advanced planning expanded | 1280 × 720 | `docs/product/task-first/qa/project-advanced-desktop.png` |

## Visual-system result

- Page background uses warm stone, primary work surfaces use ivory, and text uses warm charcoal rather than pure black.
- Deep indigo is reserved for selection and primary action; sage communicates completion/healthy capacity; burnt amber communicates pressure, blocking, and review.
- Surfaces rely on 1px borders, alignment, and whitespace. Shadows are restrained; there is no glass effect, decorative gradient, or card-inside-card dashboard treatment.
- Typography uses the system sans stack. Large serif display headings from the old direction are gone.
- Controls use compact 8px-class radii and Lucide line icons; product icons are not represented with emoji.
- Today keeps the capture field visually dominant, followed by date/capacity and one coherent day-plan surface.
- Project keeps summary and next action visible while Advanced planning is collapsed by default. Expanding it reveals Resources, dependencies, Gantt, baselines, actuals, and close controls without adding these to Today.

No actionable P0, P1, or P2 visual mismatch remains in the accepted Task-first scope.

## Desktop interaction verification

- Captured tasks from Today and Inbox with only a title.
- Confirmed immediate local receipt and Undo.
- Entered and persisted a real 09:30 planned time and one-hour effort.
- Completed and reopened a task.
- Converted a Todo to an OmniPlan Project without losing its content.
- Added a second resource, assigned multiple resources, and confirmed persistence.
- Added a Finish-to-Start dependency and confirmed both the blocked successor state in Today and the dependency in Project Gantt.
- Confirmed zero-duration work renders as a point, not a full-day bar.
- Confirmed a cross-midnight item is labeled with “次日” instead of showing ambiguous identical times.
- Confirmed Calendar, Project horizon, Outline, Gantt, Reports, Risk, and sidebar dates use the workspace time zone.
- Final console inspection returned no errors or warnings.

## Mobile and responsive verification

- At 390 × 844, Today renders a compact day overview and vertical Task rows rather than the desktop grid.
- The fixed bottom navigation contains only Today, Inbox, and Projects.
- Settings remains available as a secondary Projects action.
- Project advanced planning is collapsed by default.
- Tapping the WorkItem title directly opens its edit sheet; the primary target is at least 44 CSS px high.
- Sheets account for safe-area insets, primary touch controls meet the 44px target, and reduced-motion styles are present.
- The 390px Project document measured `scrollWidth === innerWidth === 390`.
- A 640px viewport used as the 200% zoom-equivalent check measured `scrollWidth === innerWidth === 640`.
- Final console inspection returned no errors or warnings.

## PWA and recovery verification

- Manifest, icons, standalone mode, shortcuts, and Web Share Target are served from the production build.
- Share Target created one Inbox Task containing the shared title, text, and URL.
- With the local server stopped, the installed Service Worker still opened Today.
- Two Tasks were captured offline, the page was reloaded while offline, and both remained in the collapsed unscheduled section.
- Returning online restored normal navigation.
- Service Worker tests cover API bypass, notification-route sanitization, existing-window focus/navigation, and old-cache cleanup.

## Automated verification

- TypeScript: passed.
- Frontend: 25 test files, 168 tests passed.
- Server: 9 tests passed.
- Server TypeScript build: passed.
- Production build: passed.
- Alfred workflow structure and executable scripts: passed.
- Production chunks: App 341.27 KB, React vendor 180.54 KB, Gantt 13.07 KB, Reports 8.27 KB, all uncompressed output.

## External acceptance boundary

Real Mac Chrome and iPhone Home Screen Web Push delivery cannot be truthfully verified on localhost. It still requires an HTTPS deployment, VAPID secrets, real notification permissions, and physical-device testing. Importing the signed Shortcut and configured Alfred workflow with real device tokens is also a deployment acceptance step, not a remaining visual defect.

final result: passed
