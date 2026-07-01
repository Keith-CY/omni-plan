import type { Dependency, MonteCarloResult, Project, WorkItem } from "./types";
import { addSeconds } from "./time";
import { scheduleProject } from "./scheduler";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function triangular(random: number, min: number, mode: number, max: number): number {
  if (max <= min) return mode;
  const c = (mode - min) / (max - min);
  if (random < c) return min + Math.sqrt(random * (max - min) * (mode - min));
  return max - Math.sqrt((1 - random) * (max - min) * (max - mode));
}

function splitDuration(item: WorkItem): number {
  if (!item.splitSegments?.length) return item.durationSeconds;
  return item.splitSegments.reduce(
    (finish, segment) => Math.max(finish, segment.offsetSeconds + segment.durationSeconds),
    0
  );
}

export function runMonteCarlo(
  project: Project,
  items: WorkItem[],
  dependencies: Dependency[],
  simulations = 500,
  seed = 42
): MonteCarloResult {
  const random = mulberry32(seed);
  const finishes: string[] = [];

  for (let run = 0; run < simulations; run += 1) {
    const sampled = items.map((item) => {
      const optimistic = item.estimate.optimisticSeconds ?? item.estimate.mostLikelySeconds;
      const pessimistic = item.estimate.pessimisticSeconds ?? item.estimate.mostLikelySeconds;
      const durationSeconds = Math.round(
        triangular(random(), optimistic, item.estimate.mostLikelySeconds, pessimistic)
      );
      const currentSplitDuration = splitDuration(item);
      const splitSegments = item.splitSegments?.length
        ? item.splitSegments.map((segment) => ({
            offsetSeconds: Math.round(segment.offsetSeconds * (durationSeconds / Math.max(1, currentSplitDuration))),
            durationSeconds: Math.max(
              1,
              Math.round(segment.durationSeconds * (durationSeconds / Math.max(1, currentSplitDuration)))
            )
          }))
        : undefined;
      return {
        ...item,
        durationSeconds,
        splitSegments,
        estimate: { ...item.estimate, mostLikelySeconds: durationSeconds }
      };
    });
    const result = scheduleProject(project, sampled, dependencies);
    const finish = result.items.reduce((max, item) => (item.finish > max ? item.finish : max), project.start);
    finishes.push(finish);
  }

  finishes.sort();
  const pick = (percentile: number) => finishes[Math.min(finishes.length - 1, Math.floor(finishes.length * percentile))];
  const buckets = new Map<string, number>();

  for (const finish of finishes) {
    const day = finish.slice(0, 10);
    const dayIso = addSeconds(`${day}T00:00:00.000Z`, 0);
    buckets.set(dayIso, (buckets.get(dayIso) ?? 0) + 1);
  }

  return {
    projectId: project.id,
    simulations,
    p50Finish: pick(0.5),
    p75Finish: pick(0.75),
    p90Finish: pick(0.9),
    finishDistribution: [...buckets.entries()].map(([finish, count]) => ({ finish, count }))
  };
}
