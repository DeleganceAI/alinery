// Age formatters (T0-6): TaskList's Updated/Created columns, Kanban's card age slot, and the
// canvas card's detail tier. React-free on purpose — the canvas paint path may not import a
// component module, and "how old is this task" must read the same in every one of those places.
// No seconds unit: anything under a minute reads "now".

export function formatAge(epochSeconds: number | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!epochSeconds) return "—";
  const diff = Math.max(0, nowSeconds - epochSeconds);
  if (diff < 60) return "now";
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  const unit = units.find(([seconds]) => diff >= seconds);
  return unit ? `${Math.floor(diff / unit[0])}${unit[1]}` : "now";
}

export function formatAbsolute(epochSeconds: number | null | undefined) {
  return epochSeconds ? new Date(epochSeconds * 1000).toLocaleString() : "";
}
