# TODO

## Product

- [ ] Allow editing the title and description of an existing work item.
  - Current behavior: `Title` and `Description` are available when a work item is created, but `Plan > Outline` only offers schedule, move, Todo conversion, and completion actions afterward.
  - Scope: phase, task, milestone, and hammock work items.
  - Acceptance criteria:
    - Add an `Edit work item` action that opens the existing values for `Title` and `Description`.
    - Save changes without replacing the work item ID or altering its parent, kind, schedule, progress, dependencies, evidence, or recurrence.
    - Record title and description diffs in a `ChangeSet` and sync the updated workspace immediately.
    - Add a regression test proving both fields survive save and reload.
    - Verify the flow for at least one task and one milestone in production after deployment.
