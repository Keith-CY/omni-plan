export const v1FixtureNames = [
  "empty",
  "current-sample",
  "active-incomplete",
  "shape-up-bet",
  "completed-archived",
  "legacy-archived-status",
  "malformed-optional-fields",
] as const;

export type V1FixtureName = (typeof v1FixtureNames)[number];

const entityKeys = [
  "projects",
  "workItems",
  "dependencies",
  "resources",
  "capacities",
  "baselines",
  "actuals",
  "evidence",
  "decisions",
  "changeSets",
  "auditGates",
  "auditDecisions",
] as const;

export type V1EntityKey = (typeof entityKeys)[number];

export interface V1FixtureManifest {
  counts: Record<V1EntityKey, number>;
  ids: {
    projects: readonly string[];
    workItems: readonly string[];
    dependencies: readonly string[];
    resources: readonly string[];
    baselines: readonly string[];
    evidence: readonly string[];
    decisions: readonly string[];
    changeSets: readonly string[];
    auditGates: readonly string[];
    auditDecisions: readonly string[];
  };
  capacityKeys: readonly string[];
  actualKeys: readonly string[];
}

const noIds = {
  projects: [],
  workItems: [],
  dependencies: [],
  resources: [],
  baselines: [],
  evidence: [],
  decisions: [],
  changeSets: [],
  auditGates: [],
  auditDecisions: [],
} as const;

export const expectedV1FixtureManifest = {
  empty: {
    counts: {
      projects: 0,
      workItems: 0,
      dependencies: 0,
      resources: 0,
      capacities: 0,
      baselines: 0,
      actuals: 0,
      evidence: 0,
      decisions: 0,
      changeSets: 0,
      auditGates: 0,
      auditDecisions: 0,
    },
    ids: noIds,
    capacityKeys: [],
    actualKeys: [],
  },
  "current-sample": {
    counts: {
      projects: 3,
      workItems: 9,
      dependencies: 5,
      resources: 1,
      capacities: 0,
      baselines: 1,
      actuals: 2,
      evidence: 2,
      decisions: 0,
      changeSets: 1,
      auditGates: 0,
      auditDecisions: 0,
    },
    ids: {
      projects: ["p-launch", "p-omni", "p-research"],
      workItems: [
        "w-core",
        "w-domain",
        "w-hammock",
        "w-launch-brief",
        "w-launch-report",
        "w-milestone",
        "w-monte",
        "w-research-cases",
        "w-scheduler",
      ],
      dependencies: [
        "d-domain-monte-probe",
        "d-domain-scheduler",
        "d-launch",
        "d-monte-milestone",
        "d-scheduler-monte",
      ],
      resources: ["r-chen"],
      baselines: ["b-initial"],
      evidence: ["e-domain", "e-launch"],
      decisions: [],
      changeSets: ["cs-baseline-risk"],
      auditGates: [],
      auditDecisions: [],
    },
    capacityKeys: [],
    actualKeys: [
      "w-domain+2026-07-02T18:00:00.000Z+0",
      "w-launch-brief+2026-07-05T15:00:00.000Z+1",
    ],
  },
  "active-incomplete": {
    counts: {
      projects: 3,
      workItems: 3,
      dependencies: 0,
      resources: 2,
      capacities: 2,
      baselines: 0,
      actuals: 0,
      evidence: 0,
      decisions: 0,
      changeSets: 0,
      auditGates: 0,
      auditDecisions: 0,
    },
    ids: {
      projects: [
        "p-active-incomplete",
        "p-paused-incomplete",
        "p-waiting-incomplete",
      ],
      workItems: [
        "w-active-incomplete",
        "w-paused-incomplete",
        "w-waiting-incomplete",
      ],
      dependencies: [],
      resources: ["r-owner", "r-reviewer"],
      baselines: [],
      evidence: [],
      decisions: [],
      changeSets: [],
      auditGates: [],
      auditDecisions: [],
    },
    capacityKeys: [
      "2024-02-29T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z",
    ],
    actualKeys: [],
  },
  "shape-up-bet": {
    counts: {
      projects: 1,
      workItems: 2,
      dependencies: 1,
      resources: 1,
      capacities: 1,
      baselines: 1,
      actuals: 1,
      evidence: 1,
      decisions: 1,
      changeSets: 1,
      auditGates: 1,
      auditDecisions: 1,
    },
    ids: {
      projects: ["p-shape-up"],
      workItems: ["w-shape-core", "w-shape-export"],
      dependencies: ["d-shape-export"],
      resources: ["r-shape"],
      baselines: ["b-shape-up"],
      evidence: ["e-shape-up"],
      decisions: ["decision-shape-up"],
      changeSets: ["cs-shape-up"],
      auditGates: ["gate-shape-up"],
      auditDecisions: ["ad-shape-up"],
    },
    capacityKeys: ["2023-10-03T00:00:00.000Z"],
    actualKeys: ["w-shape-core+2023-10-04T17:00:00.000Z+0"],
  },
  "completed-archived": {
    counts: {
      projects: 2,
      workItems: 2,
      dependencies: 0,
      resources: 1,
      capacities: 1,
      baselines: 0,
      actuals: 1,
      evidence: 1,
      decisions: 1,
      changeSets: 0,
      auditGates: 0,
      auditDecisions: 0,
    },
    ids: {
      projects: ["p-completed", "p-completed-archived"],
      workItems: ["w-completed", "w-completed-archived"],
      dependencies: [],
      resources: ["r-historian"],
      baselines: [],
      evidence: ["e-completed"],
      decisions: ["decision-completed"],
      changeSets: [],
      auditGates: [],
      auditDecisions: [],
    },
    capacityKeys: ["2022-07-01T00:00:00.000Z"],
    actualKeys: [
      "w-completed-archived+2022-06-30T10:00:00.000Z+0",
    ],
  },
  "legacy-archived-status": {
    counts: {
      projects: 1,
      workItems: 0,
      dependencies: 0,
      resources: 0,
      capacities: 0,
      baselines: 0,
      actuals: 0,
      evidence: 0,
      decisions: 0,
      changeSets: 0,
      auditGates: 1,
      auditDecisions: 0,
    },
    ids: {
      ...noIds,
      projects: ["p-legacy-archived-status"],
      auditGates: ["gate-legacy-archived"],
    },
    capacityKeys: [],
    actualKeys: [],
  },
  "malformed-optional-fields": {
    counts: {
      projects: 1,
      workItems: 1,
      dependencies: 0,
      resources: 0,
      capacities: 0,
      baselines: 1,
      actuals: 1,
      evidence: 1,
      decisions: 0,
      changeSets: 0,
      auditGates: 0,
      auditDecisions: 0,
    },
    ids: {
      ...noIds,
      projects: ["p-malformed-optionals"],
      workItems: ["w-malformed-optionals"],
      baselines: ["b-malformed-optionals"],
      evidence: ["e-malformed-optionals"],
    },
    capacityKeys: [],
    actualKeys: [
      "w-malformed-optionals+2020-01-02T10:00:00.000Z+0",
    ],
  },
} as const satisfies Record<V1FixtureName, V1FixtureManifest>;

export { entityKeys as v1EntityKeys };
