import type {
  Actual,
  Baseline,
  ChangeSet,
  Dependency,
  Evidence,
  Project,
  Resource,
  WorkItem,
  WorkspaceSnapshot
} from "./types";

const hour = 3600;
const day = 8 * hour;

export const projects: Project[] = [
  {
    id: "p-omni",
    name: "OmniPlan Personal",
    status: "active",
    mode: "build",
    priority: 5,
    northStar: "Replace OmniPlan Pro for new AI-era personal projects.",
    currentOutcome: "Make multi-project scheduling trustworthy under rapid agent-assisted execution.",
    horizon: "2026-09-30T00:00:00.000Z",
    start: "2026-07-01T00:00:00.000Z",
    reviewCadenceDays: 7,
    directionCard: {
      targetUser: "Chen Yu as a heavy Apple/PWA personal project operator.",
      userProblem: "Fast project execution can hide direction drift and false progress.",
      businessGoal: "Reduce wasted deep work and make new projects safe to run outside OmniPlan Pro.",
      coreHypothesis: "Binding evidence and contrarian audit gates to professional scheduling catches wrong direction before speed amplifies it.",
      successMetric: "Three active projects can be planned, reviewed, and adjusted from one Portfolio dashboard.",
      failureCondition: "If the app cannot explain schedule risk and stop reasons, it should not replace OmniPlan.",
      validationMethod: "Use on new projects for two weekly reviews.",
      timeboxDays: 45,
      opportunityCost: "Not improving existing OmniPlan templates and manual review checklists."
    }
  },
  {
    id: "p-launch",
    name: "Agent Launch System",
    status: "active",
    mode: "ship",
    priority: 4,
    northStar: "Ship agent-produced work without losing product judgment.",
    currentOutcome: "Create a repeatable evidence report for launch decisions.",
    horizon: "2026-08-18T00:00:00.000Z",
    start: "2026-07-05T00:00:00.000Z",
    reviewCadenceDays: 7,
    directionCard: {
      targetUser: "Solo builder managing several public releases.",
      userProblem: "Release checklists track output but not whether the direction still deserves launch.",
      businessGoal: "Improve launch decision quality.",
      coreHypothesis: "A weekly evidence report with stop reasons lowers weak launches.",
      successMetric: "Every release has a continue evidence and stop reason before scope expansion.",
      failureCondition: "Reports become generic status summaries.",
      validationMethod: "Run on two launches.",
      timeboxDays: 21,
      opportunityCost: "Manual notes remain faster for small releases."
    }
  },
  {
    id: "p-research",
    name: "Scheduling Risk Research",
    status: "waiting",
    mode: "explore",
    priority: 2,
    northStar: "Understand which risk signals predict personal project stalls.",
    currentOutcome: "Collect examples before adding more automation.",
    horizon: "2026-10-01T00:00:00.000Z",
    start: "2026-07-10T00:00:00.000Z",
    reviewCadenceDays: 14
  }
];

export const resources: Resource[] = [
  {
    id: "r-chen",
    name: "Chen Yu",
    role: "Owner / operator",
    capacityByAttention: {
      deep: 4 * hour,
      medium: 3 * hour,
      shallow: 2 * hour
    },
    hourlyRate: 1
  }
];

export const workItems: WorkItem[] = [
  {
    id: "w-core",
    projectId: "p-omni",
    kind: "phase",
    title: "Scheduling Core",
    outline: "1",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    assignmentIds: [],
    percentComplete: 45
  },
  {
    id: "w-domain",
    projectId: "p-omni",
    parentId: "w-core",
    kind: "task",
    title: "Define project domain schema and change sets",
    outline: "1.1",
    durationSeconds: 2 * day,
    estimate: { optimisticSeconds: day, mostLikelySeconds: 2 * day, pessimisticSeconds: 4 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "deep", effortSeconds: 5 * hour }],
    percentComplete: 80,
    isKeyTask: true
  },
  {
    id: "w-scheduler",
    projectId: "p-omni",
    parentId: "w-core",
    kind: "task",
    title: "Implement deterministic scheduler",
    outline: "1.2",
    durationSeconds: 3 * day,
    estimate: { optimisticSeconds: 2 * day, mostLikelySeconds: 3 * day, pessimisticSeconds: 6 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "deep", effortSeconds: 7 * hour }],
    percentComplete: 45,
    splitSegments: [
      { offsetSeconds: 0, durationSeconds: day },
      { offsetSeconds: 2 * day, durationSeconds: day }
    ],
    isKeyTask: true,
    isFastDelivery: true
  },
  {
    id: "w-monte",
    projectId: "p-omni",
    parentId: "w-core",
    kind: "task",
    title: "Add Monte Carlo and EVM",
    outline: "1.3",
    durationSeconds: 2 * day,
    estimate: { optimisticSeconds: day, mostLikelySeconds: 2 * day, pessimisticSeconds: 5 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "deep", effortSeconds: 6 * hour }],
    percentComplete: 20,
    isKeyTask: true
  },
  {
    id: "w-milestone",
    projectId: "p-omni",
    kind: "milestone",
    title: "Core engine trustworthy enough for UI",
    outline: "1.4",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    assignmentIds: [],
    percentComplete: 100,
    evidenceRequired: true
  },
  {
    id: "w-hammock",
    projectId: "p-omni",
    kind: "hammock",
    title: "Contrarian audit window",
    outline: "1.5",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    assignmentIds: [{ resourceId: "r-chen", attention: "medium", effortSeconds: 2 * hour }],
    percentComplete: 15,
    hammockStartId: "w-domain",
    hammockFinishId: "w-milestone"
  },
  {
    id: "w-launch-brief",
    projectId: "p-launch",
    kind: "task",
    title: "Write launch direction card",
    outline: "1",
    durationSeconds: day,
    estimate: { optimisticSeconds: 4 * hour, mostLikelySeconds: day, pessimisticSeconds: 2 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "deep", effortSeconds: 4 * hour }],
    percentComplete: 100,
    evidenceRequired: true
  },
  {
    id: "w-launch-report",
    projectId: "p-launch",
    kind: "task",
    title: "Generate evidence report",
    outline: "2",
    durationSeconds: 2 * day,
    estimate: { optimisticSeconds: day, mostLikelySeconds: 2 * day, pessimisticSeconds: 4 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "medium", effortSeconds: 5 * hour }],
    percentComplete: 35,
    isScopeExpansion: true
  },
  {
    id: "w-research-cases",
    projectId: "p-research",
    kind: "task",
    title: "Collect stall examples",
    outline: "1",
    durationSeconds: 5 * day,
    estimate: { optimisticSeconds: 3 * day, mostLikelySeconds: 5 * day, pessimisticSeconds: 8 * day },
    assignmentIds: [{ resourceId: "r-chen", attention: "shallow", effortSeconds: 3 * hour }],
    percentComplete: 5
  }
];

export const dependencies: Dependency[] = [
  { id: "d-domain-scheduler", projectId: "p-omni", fromId: "w-domain", toId: "w-scheduler", type: "FS", lagSeconds: 0 },
  { id: "d-domain-monte-probe", projectId: "p-omni", fromId: "w-domain", toId: "w-monte", type: "SS", lagSeconds: 24 * hour },
  { id: "d-scheduler-monte", projectId: "p-omni", fromId: "w-scheduler", toId: "w-monte", type: "FS", lagSeconds: 24 * hour },
  { id: "d-monte-milestone", projectId: "p-omni", fromId: "w-monte", toId: "w-milestone", type: "FF", lagSeconds: 0 },
  { id: "d-launch", projectId: "p-launch", fromId: "w-launch-brief", toId: "w-launch-report", type: "FS", lagSeconds: 0 }
];

export const evidence: Evidence[] = [
  {
    id: "e-domain",
    kind: "doc",
    summary: "Domain model includes direction cards, evidence, change sets, audit decisions, and baselines.",
    projectId: "p-omni",
    workItemId: "w-domain",
    createdAt: "2026-07-02T09:00:00.000Z",
    confidence: 0.8,
    tags: ["schema", "manual"]
  },
  {
    id: "e-launch",
    kind: "note",
    summary: "Launch project needs evidence report before scope expansion.",
    projectId: "p-launch",
    workItemId: "w-launch-brief",
    createdAt: "2026-07-06T10:30:00.000Z",
    confidence: 0.7,
    tags: ["direction"]
  }
];

export const actuals: Actual[] = [
  {
    workItemId: "w-domain",
    actualStart: "2026-07-01T09:00:00.000Z",
    actualWorkSeconds: 5 * hour,
    remainingWorkSeconds: hour,
    actualCost: 5,
    recordedAt: "2026-07-02T18:00:00.000Z"
  },
  {
    workItemId: "w-launch-brief",
    actualStart: "2026-07-05T09:00:00.000Z",
    actualFinish: "2026-07-05T15:00:00.000Z",
    actualWorkSeconds: 4 * hour,
    remainingWorkSeconds: 0,
    actualCost: 4,
    recordedAt: "2026-07-05T15:00:00.000Z"
  }
];

export const changeSets: ChangeSet[] = [
  {
    id: "cs-baseline-risk",
    projectId: "p-omni",
    title: "Move engine milestone after Monte Carlo spike",
    status: "queued-audit",
    createdAt: "2026-07-04T11:00:00.000Z",
    reason: "Risk simulation work must be proven before UI depends on the engine.",
    diffs: [
      {
        entity: "Baseline",
        entityId: "b-initial",
        field: "plannedFinishByItem.w-milestone",
        before: "2026-07-08T00:00:00.000Z",
        after: "2026-07-10T00:00:00.000Z"
      }
    ],
    rollbackToken: "rollback-cs-baseline-risk",
    auditGateIds: []
  }
];

export const baselines: Baseline[] = [
  {
    id: "b-initial",
    projectId: "p-omni",
    name: "Initial committed plan",
    capturedAt: "2026-07-01T00:00:00.000Z",
    plannedStartByItem: {
      "w-domain": "2026-07-01T00:00:00.000Z",
      "w-scheduler": "2026-07-03T00:00:00.000Z",
      "w-monte": "2026-07-06T00:00:00.000Z",
      "w-milestone": "2026-07-08T00:00:00.000Z"
    },
    plannedFinishByItem: {
      "w-domain": "2026-07-03T00:00:00.000Z",
      "w-scheduler": "2026-07-06T00:00:00.000Z",
      "w-monte": "2026-07-08T00:00:00.000Z",
      "w-milestone": "2026-07-08T00:00:00.000Z"
    },
    plannedWorkSecondsByItem: {
      "w-domain": 5 * hour,
      "w-scheduler": 7 * hour,
      "w-monte": 6 * hour,
      "w-milestone": 0
    }
  }
];

export const sampleWorkspace: WorkspaceSnapshot = {
  schemaVersion: 3,
  timeZone: "Asia/Tokyo",
  todos: [],
  conversionHistory: [],
  projects,
  workItems,
  recurringOccurrences: [],
  dependencies,
  resources,
  capacities: [],
  baselines,
  actuals,
  evidence,
  decisions: [],
  changeSets,
  auditGates: [],
  auditDecisions: []
};
