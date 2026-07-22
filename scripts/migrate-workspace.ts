import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  downgradeWorkspaceToSchema2,
  migrateWorkspaceToSchema3,
  validateWorkspaceIntegrity,
  WorkspaceIntegrityError
} from "../src/domain/workspaceMigration";

interface MigrationCliOptions {
  inputPath: string;
  outputPath: string;
  reportPath: string;
  rollbackPath: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await assertSafeTargets(options);

  const sourceText = await readFile(options.inputPath, "utf8");
  const source = JSON.parse(sourceText) as unknown;
  const migrated = migrateWorkspaceToSchema3(source);
  const rollback = downgradeWorkspaceToSchema2(migrated.envelope);
  const roundTrip = await publishValidatedArtifacts(options, migrated.envelope, migrated.report, rollback.envelope);

  process.stdout.write(`${JSON.stringify({
    input: options.inputPath,
    output: options.outputPath,
    report: options.reportPath,
    rollback: options.rollbackPath,
    migration: migrated.report,
    roundTripDirection: roundTrip.report.direction
  }, null, 2)}\n`);
}

async function publishValidatedArtifacts(
  options: MigrationCliOptions,
  schema3: unknown,
  report: unknown,
  rollback: unknown
) {
  const token = `${process.pid}-${Date.now()}`;
  const artifacts = [
    { target: options.outputPath, staged: `${options.outputPath}.staged-${token}`, value: schema3 },
    { target: options.reportPath, staged: `${options.reportPath}.staged-${token}`, value: report },
    { target: options.rollbackPath, staged: `${options.rollbackPath}.staged-${token}`, value: rollback }
  ];
  const published: string[] = [];

  try {
    const writes = await Promise.allSettled(artifacts.map((artifact) => writeJson(artifact.staged, artifact.value)));
    const failedWrite = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedWrite) throw failedWrite.reason;

    const roundTripText = await readFile(artifacts[0].staged, "utf8");
    const roundTrip = migrateWorkspaceToSchema3(JSON.parse(roundTripText) as unknown);
    const integrityErrors = validateWorkspaceIntegrity(roundTrip.snapshot)
      .filter((issue) => issue.severity === "error");
    if (integrityErrors.length) {
      throw new Error(`Staged schema 3 workspace failed validation with ${integrityErrors.length} errors.`);
    }

    for (const artifact of artifacts) {
      // A hard link publishes the already-validated bytes and fails if a target
      // appeared after the initial safety check; it never overwrites a file.
      await link(artifact.staged, artifact.target);
      published.push(artifact.target);
    }
    return roundTrip;
  } catch (error) {
    await Promise.allSettled(published.map(removeIfPresent));
    throw error;
  } finally {
    await Promise.allSettled(artifacts.map((artifact) => removeIfPresent(artifact.staged)));
  }
}

function parseOptions(args: string[]): MigrationCliOptions {
  if (args.length !== 4) {
    throw new Error("Usage: bun run workspace:migrate -- <input.json> <schema3.json> <report.json> <schema2-rollback.json>");
  }
  const [input, output, report, rollback] = args.map((value) => resolve(value));
  return {
    inputPath: input,
    outputPath: output,
    reportPath: report,
    rollbackPath: rollback
  };
}

async function assertSafeTargets(options: MigrationCliOptions) {
  const targets = [options.outputPath, options.reportPath, options.rollbackPath];
  if (new Set(targets).size !== targets.length) {
    throw new Error("Schema 3, report, and rollback outputs must use separate files.");
  }
  if (targets.includes(options.inputPath)) {
    throw new Error("Migration outputs must not overwrite the source backup.");
  }
  await Promise.all(targets.map(async (target) => {
    try {
      await stat(target);
      throw new Error(`Refusing to overwrite existing migration artifact: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }));
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function removeIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

void main().catch((error) => {
  if (error instanceof WorkspaceIntegrityError) {
    process.stderr.write(`${JSON.stringify({ message: error.message, issues: error.issues }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
