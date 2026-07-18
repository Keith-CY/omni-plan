import type { CloseDecisionDraft } from "../../../domain/commands";
import {
  followUpDirectionBriefId,
  returnedInboxItemId,
} from "../../../domain/close";
import type { ProjectWorkItem } from "../../../domain/types";

export function CloseConsequences({
  decision,
  unfinished,
}: {
  decision: CloseDecisionDraft;
  unfinished: ProjectWorkItem[];
}) {
  const generatedInboxIds = decision.unfinishedDisposition === "return_to_inbox"
    ? unfinished.map((item) => returnedInboxItemId(decision.id, item.id))
    : [];
  const followUpBriefId =
    decision.unfinishedDisposition === "follow_up_project" &&
    decision.followUpProjectId !== undefined
      ? followUpDirectionBriefId(decision.id, decision.followUpProjectId)
      : undefined;

  return (
    <section className="v2-close-consequences" aria-label="Exact Close consequences">
      <h3>Exact irreversible consequences</h3>
      {unfinished.length === 0 ? (
        <p>No unfinished Work Item is affected and no disposition artifact is generated.</p>
      ) : (
        <>
          <p>
            These {unfinished.length} source Work Item{unfinished.length === 1 ? "" : "s"}
            {" "}remain immutable in the closed Project history:
          </p>
          <ul>
            {unfinished.map((item) => (
              <li key={item.id}><strong>{item.title}</strong> <code>{item.id}</code></li>
            ))}
          </ul>
        </>
      )}
      {decision.unfinishedDisposition === "return_to_inbox" ? (
        <>
          <p>
            Close creates {generatedInboxIds.length} new untriaged Inbox item{generatedInboxIds.length === 1 ? "" : "s"};
            it does not move or rewrite the source Work Items.
          </p>
          <ul>
            {generatedInboxIds.map((id) => <li key={id}><code>{id}</code></li>)}
          </ul>
        </>
      ) : decision.unfinishedDisposition === "follow_up_project" &&
        decision.followUpProjectId !== undefined && followUpBriefId !== undefined ? (
          <>
            <p>Close creates one follow-up Project and one empty Direction brief:</p>
            <ul>
              <li>Project <code>{decision.followUpProjectId}</code></li>
              <li>Direction brief <code>{followUpBriefId}</code></li>
            </ul>
            <p>The new records cite every unfinished Work Item above; no Inbox item is generated.</p>
          </>
        ) : decision.unfinishedDisposition === "discard" ? (
          <p>
            Discard generates no Inbox item or follow-up Project. It preserves the source
            Work Items as immutable unfinished history rather than deleting them.
          </p>
        ) : (
          <p>
            Historical incomplete generates no Inbox item or follow-up Project. The source
            Work Items remain visibly unfinished in immutable history.
          </p>
        )}
    </section>
  );
}
