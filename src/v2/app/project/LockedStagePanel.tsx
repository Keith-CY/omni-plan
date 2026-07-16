import type { UserLifecycleStage } from "../../domain/selectors";

import { USER_STAGE_LABELS } from "./LifecycleNav";

export interface LockedStagePanelProps {
  stage: UserLifecycleStage;
  reason: string;
  nextCommand: string;
}

export function LockedStagePanel({
  stage,
  reason,
  nextCommand,
}: LockedStagePanelProps) {
  const label = USER_STAGE_LABELS[stage];
  return (
    <section
      className="v2-locked-stage"
      aria-label={`${stage} stage locked`}
      data-stage={stage}
      data-readonly="true"
    >
      <p className="v2-eyebrow">Locked lifecycle stage</p>
      <h2>{label} is locked</h2>
      <dl>
        <div>
          <dt>Unlock condition</dt>
          <dd>{reason}</dd>
        </div>
        <div>
          <dt>Permitted next command</dt>
          <dd><code>{nextCommand}</code></dd>
        </div>
      </dl>
    </section>
  );
}
