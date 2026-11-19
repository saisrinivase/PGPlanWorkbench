import type { PlanNode } from "./types.ts";

export interface OperationTiming {
  path: string;
  scope: "serial" | "parallel" | "subplan" | "shared";
  status: "measured" | "never-executed" | "unknown";
  perLoopMs: number | null;
  loops: number | null;
  inclusiveMs: number | null;
  selfMs: number | null;
  reason: string;
  workers: Array<{ number: number | null; loops: number | null; perLoopMs: number | null; processMs: number | null }>;
}

const nonnegative = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const loopCount = (value: unknown): number | null => {
  const count = nonnegative(value);
  return count != null && Number.isSafeInteger(count) ? count : null;
};

/** Preserve captured process times; never add workers to an already aggregated node. */
export function attributeTiming(root: PlanNode): OperationTiming[] {
  const result: OperationTiming[] = [];
  const visit = (node: PlanNode, path: string, inherited: OperationTiming["scope"]): boolean => {
    const workers = Array.isArray(node.Workers) ? node.Workers.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))) : [];
    const parallel = node["Parallel Aware"] === true || /Gather|^Parallel /.test(String(node["Node Type"])) || Number(node["Workers Launched"]) > 0 || workers.length > 0;
    const subplan = /SubPlan|InitPlan/.test(String(node["Parent Relationship"])) || typeof node["Subplan Name"] === "string";
    const shared = /CTE Scan|WorkTable Scan|Recursive Union/.test(String(node["Node Type"])) || node["Async Capable"] === true;
    const scope = inherited !== "serial" ? inherited : parallel ? "parallel" : subplan ? "subplan" : shared ? "shared" : "serial";
    const perLoopMs = nonnegative(node["Actual Total Time"]), loops = loopCount(node["Actual Loops"]), rows = nonnegative(node["Actual Rows"]);
    const valid = perLoopMs != null && loops != null && rows != null && !(loops === 0 && (perLoopMs !== 0 || rows !== 0));
    const accumulated = valid ? perLoopMs! * loops! : null;
    const item: OperationTiming = {
      path, scope, status: valid && accumulated != null && Number.isFinite(accumulated) ? loops === 0 ? "never-executed" : "measured" : "unknown",
      perLoopMs, loops, inclusiveMs: accumulated != null && Number.isFinite(accumulated) ? accumulated : null, selfMs: null,
      reason: "Actual time, rows or loops are missing or inconsistent; self time is unknown.",
      workers: workers.map((worker) => {
        const count = loopCount(worker["Actual Loops"]), mean = nonnegative(worker["Actual Total Time"]);
        const total = count != null && mean != null && !(count === 0 && mean !== 0) ? count * mean : null;
        return { number: loopCount(worker["Worker Number"]), loops: count, perLoopMs: mean,
          processMs: total != null && Number.isFinite(total) ? total : null };
      }),
    };
    result.push(item);
    const children: OperationTiming[] = [];
    let uncertainChild = false;
    (node.Plans ?? []).forEach((child, index) => {
      const position = result.length;
      uncertainChild = visit(child, `${path}.${index + 1}`, scope) || uncertainChild;
      children.push(result[position]);
    });
    if (item.status === "never-executed" && !children.some((child) => (child.inclusiveMs ?? 0) > 0)) {
      item.inclusiveMs = 0; item.selfMs = 0;
      item.reason = "Never executed (0 loops); zero captured work is not evidence of an efficient access path.";
    } else if (item.inclusiveMs != null && scope !== "serial") {
      item.reason = scope === "parallel"
        ? "Inclusive time is accumulated process time, not query wall time. Workers overlap and may be included in the node average; do not add worker times to it. Self time is withheld."
        : "Subplan/CTE/async inclusive time is shown separately. Parent inclusion or reuse is not established; self time is withheld.";
    } else if (item.inclusiveMs != null && !uncertainChild && children.every((child) => child.inclusiveMs != null)) {
      const childMs = children.reduce((sum, child) => sum + child.inclusiveMs!, 0);
      const tolerance = Math.min(Math.max(item.inclusiveMs, 1) * 0.01, 0.001 * ((loops ?? 0) + children.reduce((sum, child) => sum + (child.loops ?? 0), 0)));
      if (childMs <= item.inclusiveMs + tolerance) {
        item.selfMs = Math.max(0, item.inclusiveMs - childMs);
        item.reason = "Approximate self = accumulated inclusive time minus direct-child accumulated time. Not CPU time; do not add parent inclusive and child times.";
      } else item.reason = "Child time exceeds parent inclusive time beyond rounding tolerance; self time is unknown.";
    } else if (item.inclusiveMs != null) item.reason = "A descendant has ambiguous or missing timing; subtracting it could double-count or misattribute work. Parent self time is withheld.";
    return scope !== "serial" || item.selfMs == null;
  };
  visit(root, "1", "serial");
  return result;
}
