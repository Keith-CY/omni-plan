export interface UnavailableBlockDraft {
  id: string;
  start: string;
  finish: string;
}

let unavailableSequence = 0;

function createUnavailableId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `unavailable:${uuid}`;
  unavailableSequence += 1;
  return `unavailable:${Date.now()}:${unavailableSequence}`;
}

export function UnavailableBlocksField({
  blocks,
  onChange,
}: {
  blocks: readonly UnavailableBlockDraft[];
  onChange(blocks: UnavailableBlockDraft[]): void;
}) {
  const update = (
    index: number,
    field: "start" | "finish",
    value: string,
  ) => {
    onChange(
      blocks.map((block, blockIndex) =>
        blockIndex === index ? { ...block, [field]: value } : block,
      ),
    );
  };

  return (
    <fieldset className="v2-capacity-section v2-unavailable-field">
      <legend>Fixed unavailable time</legend>
      <p>
        Add known appointments or blocked periods. They subtract from the work
        window; they never create more capacity.
      </p>
      <div className="v2-unavailable-list">
        {blocks.map((block, index) => (
          <fieldset
            className="v2-unavailable-block"
            key={block.id}
            aria-label={`Unavailable block ${index + 1}`}
          >
            <legend>Block {index + 1}</legend>
            <label>
              <span>Start</span>
              <input
                type="datetime-local"
                aria-label={`Unavailable start ${index + 1}`}
                value={block.start}
                onChange={(event) => update(index, "start", event.target.value)}
              />
            </label>
            <label>
              <span>Finish</span>
              <input
                type="datetime-local"
                aria-label={`Unavailable finish ${index + 1}`}
                value={block.finish}
                onChange={(event) =>
                  update(index, "finish", event.target.value)
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                onChange(blocks.filter((_, blockIndex) => blockIndex !== index))
              }
            >
              Remove block {index + 1}
            </button>
          </fieldset>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          onChange([
            ...blocks,
            { id: createUnavailableId(), start: "", finish: "" },
          ])
        }
      >
        Add unavailable block
      </button>
    </fieldset>
  );
}
