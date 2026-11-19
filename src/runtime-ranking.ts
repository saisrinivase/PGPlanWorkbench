import type { PlanNode, PlanVisualNode } from "./types.ts";

export interface RuntimeRanking {
  status: "ranked" | "unavailable" | "no-material-hotspot";
  reason: string;
  operations: Array<{ path: string; selfMs: number; selfShare: number; inclusiveMs: number }>;
}

/** Conservative serial ranking. Self time is derived, not a measured CPU time. */
export function rankRuntime(root: PlanNode, rows: PlanVisualNode[], executionMs: number | null): RuntimeRanking {
  const unavailable = (reason: string): RuntimeRanking => ({ status: "unavailable", reason, operations: [] });
  if (executionMs == null || !Number.isFinite(executionMs) || executionMs <= 0)
    return unavailable("Execution time is missing; wall-time shares cannot be established.");
  const raw: PlanNode[] = [];
  const flatten = (node: PlanNode) => { raw.push(node); (node.Plans ?? []).forEach(flatten); };
  flatten(root);
  if (raw.length !== rows.length) return unavailable("Operation mapping is incomplete.");
  if (raw.some((node) => node["Parallel Aware"] === true || /Gather|^Parallel /.test(String(node["Node Type"]))
    || Number(node["Workers Launched"]) > 0 || (Array.isArray(node.Workers) && node.Workers.length > 0)))
    return unavailable("Parallel worker time overlaps; additive wall-time ranking is withheld.");
  if (raw.some((node) => /SubPlan|InitPlan/.test(String(node["Parent Relationship"]))
    || typeof node["Subplan Name"] === "string"
    || /CTE Scan|WorkTable Scan|Recursive Union/.test(String(node["Node Type"]))))
    return unavailable("Subplan, CTE or recursive timing attribution needs separate treatment.");
  if (raw.some((node) => node["Async Capable"] === true))
    return unavailable("Asynchronous work may overlap; additive wall-time ranking is withheld.");
  for (const node of raw) {
    const time = node["Actual Total Time"], loops = node["Actual Loops"], actual = node["Actual Rows"];
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0
      || typeof loops !== "number" || !Number.isSafeInteger(loops) || loops < 0
      || typeof actual !== "number" || !Number.isFinite(actual) || actual < 0)
      return unavailable("Actual timing, rows or loops are missing or invalid.");
    if (loops === 0 && (time !== 0 || actual !== 0)) return unavailable("Never-executed operation has inconsistent measurements.");
    const inclusive = time * loops;
    const children = (node.Plans ?? []).reduce((sum, child) => sum + Number(child["Actual Total Time"]) * Number(child["Actual Loops"]), 0);
    // EXPLAIN rounds per-loop timing; tolerate only its accumulated rounding error.
    const tolerance = Math.min(executionMs * 0.01, 0.001 * (loops + (node.Plans ?? []).reduce((sum, child) => sum + Number(child["Actual Loops"]), 0)));
    if (inclusive > executionMs + tolerance || children > inclusive + tolerance)
      return unavailable("Inconsistent inclusive timing prevents reliable self-time ranking.");
  }
  const operations = rows.flatMap((node, index) => {
    const source = raw[index];
    const loops = Number(source["Actual Loops"]);
    if (!loops) return [];
    const inclusiveMs = Number(source["Actual Total Time"]) * loops;
    const childrenMs = (source.Plans ?? []).reduce((sum, child) => sum + Number(child["Actual Total Time"]) * Number(child["Actual Loops"]), 0);
    const selfMs = Math.max(0, inclusiveMs - childrenMs);
    const selfShare = selfMs / executionMs * 100;
    return selfMs >= 50 && selfShare >= 20 && selfShare <= 100 ? [{ path: node.path, selfMs, selfShare, inclusiveMs }] : [];
  }).sort((a, b) => b.selfMs - a.selfMs); // Stable tree order breaks equal-time ties.
  return { status: operations.length ? "ranked" : "no-material-hotspot",
    reason: "Approximate self time = per-loop inclusive time × loops minus direct-child accumulated time. Parent/child shares must not be added; this does not identify CPU, I/O or root cause.", operations };
}
