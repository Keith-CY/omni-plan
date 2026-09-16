import { Check, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./quick-task-capture.css";

export interface QuickTaskCaptureProps {
  onCapture: (title: string) => string | undefined;
  onUndo: (taskId: string) => void;
  inputId?: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  syncLabel?: string;
}

export function QuickTaskCapture({
  onCapture,
  onUndo,
  inputId,
  placeholder = "想到什么，先记下来…",
  className = "",
  autoFocus = false,
  syncLabel = "本地已保存 · 正在同步"
}: QuickTaskCaptureProps) {
  const [title, setTitle] = useState("");
  const [composing, setComposing] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string; title: string }>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!receipt) return;
    const timeout = window.setTimeout(() => setReceipt(undefined), 8000);
    return () => window.clearTimeout(timeout);
  }, [receipt]);

  const capture = () => {
    const trimmed = title.trim();
    if (!trimmed || composing) return;
    const id = onCapture(trimmed);
    if (!id) return;
    setReceipt({ id, title: trimmed });
    setTitle("");
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className={`quickTaskCaptureStack ${className}`.trim()}>
      <form
        className="quickTaskCapture"
        onSubmit={(event) => {
          event.preventDefault();
          capture();
        }}
      >
        <Plus aria-hidden="true" />
        <input
          id={inputId}
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          placeholder={placeholder}
          aria-label="快速记录任务"
          aria-keyshortcuts="Meta+N Control+N"
          autoComplete="off"
          autoFocus={autoFocus}
        />
        <span className="quickTaskCaptureHint">Enter 保存</span>
        <button type="submit" disabled={!title.trim() || composing}>保存</button>
      </form>
      {receipt && (
        <div className="quickTaskCaptureReceipt" role="status">
          <Check aria-hidden="true" />
          <span>已保存“{receipt.title}” · {syncLabel}</span>
          <button
            type="button"
            onClick={() => {
              onUndo(receipt.id);
              setReceipt(undefined);
            }}
          ><RotateCcw aria-hidden="true" />撤销</button>
        </div>
      )}
    </div>
  );
}
