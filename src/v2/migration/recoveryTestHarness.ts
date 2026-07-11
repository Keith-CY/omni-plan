import type {
  BrowserMigrationResult,
  MigrateBrowserWorkspaceInput,
  V1WorkspaceMapper,
} from "./recovery";
import { migrateBrowserWorkspaceWithMapperInternal } from "./recovery";

/**
 * Test-only mapper fault-injection seam. The coordinator still invokes the
 * production migration validator; tests cannot replace or bypass it.
 */
export function migrateBrowserWorkspaceWithTestMapper(
  input: MigrateBrowserWorkspaceInput,
  mapper: V1WorkspaceMapper,
): Promise<BrowserMigrationResult> {
  return migrateBrowserWorkspaceWithMapperInternal(input, mapper);
}
