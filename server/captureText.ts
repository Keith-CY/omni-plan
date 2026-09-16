export interface ParsedCaptureText {
  title: string;
  note?: string;
  estimateSeconds?: number;
  plannedForDate?: string;
  localStartTime?: string;
}

/**
 * One-line syntax shared by external capture clients:
 * title | optional note | YYYY-MM-DD HH:mm | 30m / 1.5h
 *
 * Local clock values stay local until the encrypted Workspace consumes them,
 * because the capture service deliberately does not know the owner's time zone.
 */
export function parseCaptureText(value: string): ParsedCaptureText | undefined {
  const parts = value.split("|").map((part) => part.trim()).filter(Boolean);
  const title = parts.shift();
  if (!title) return undefined;

  const notes: string[] = [];
  let estimateSeconds: number | undefined;
  let plannedForDate: string | undefined;
  let localStartTime: string | undefined;

  for (const part of parts) {
    const dateTime = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(part);
    if (dateTime && !plannedForDate) {
      plannedForDate = dateTime[1];
      localStartTime = dateTime[2];
      continue;
    }
    const effort = /^(\d+(?:\.\d+)?)\s*(m|min|mins|分钟|h|hr|hrs|小时)$/i.exec(part);
    if (effort && estimateSeconds === undefined) {
      const amount = Number(effort[1]);
      const hours = /^(h|hr|hrs|小时)$/i.test(effort[2]);
      estimateSeconds = Math.round(amount * (hours ? 3600 : 60));
      continue;
    }
    notes.push(part);
  }

  return {
    title,
    ...(notes.length ? { note: notes.join(" | ") } : {}),
    ...(estimateSeconds === undefined ? {} : { estimateSeconds }),
    ...(plannedForDate ? { plannedForDate } : {}),
    ...(localStartTime ? { localStartTime } : {})
  };
}
