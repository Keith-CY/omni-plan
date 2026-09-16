function run(argv) {
  const query = String(argv[0] || "").trim();
  if (!query) throw new Error("请输入任务标题。");
  const fields = query.split("|").map((value) => value.trim()).filter(Boolean);
  const title = fields.shift();
  if (!title) throw new Error("请输入任务标题。");

  const notes = [];
  let estimateSeconds;
  let plannedForDate;
  let plannedStart;
  for (const field of fields) {
    const effort = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr)$/i.exec(field);
    if (effort) {
      const amount = Number(effort[1]);
      estimateSeconds = Math.round(amount * (/^h/i.test(effort[2]) ? 3600 : 60));
      continue;
    }
    const dateTime = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?$/.exec(field);
    if (dateTime) {
      plannedForDate = dateTime[1];
      if (dateTime[2]) {
        const local = new Date(`${dateTime[1]}T${dateTime[2]}:00`);
        if (Number.isNaN(local.getTime())) throw new Error("计划时间无效。");
        plannedStart = local.toISOString();
      }
      continue;
    }
    notes.push(field);
  }

  return JSON.stringify({
    title: title.slice(0, 500),
    ...(notes.length ? { note: notes.join(" | ").slice(0, 4000) } : {}),
    ...(estimateSeconds === undefined ? {} : { estimateSeconds }),
    ...(plannedForDate ? { plannedForDate } : {}),
    ...(plannedStart ? { plannedStart } : {}),
    source: "alfred"
  });
}
