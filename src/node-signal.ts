import type { PlanVisualNode } from "./types.ts";

export type NodeSignalLevel = "critical" | "review" | "healthy" | "unknown";
export interface NodeSignal { level: NodeSignalLevel; symbol: string; label: string; reason: string }

const passesRowsThrough = (nodeType: string) => /^(sort|incremental sort|limit|gather|gather merge|materialize|memoize|unique|lockrows|result)$/i.test(nodeType);

export function nodeSignal(node: PlanVisualNode): NodeSignal {
  if (node.timing?.status === "never-executed") return { level: "unknown", symbol: "?", label: "Never executed", reason: "Actual Loops = 0; no access-path efficiency or estimate accuracy was measured" };
  if (node.loops <= 0) return { level: "unknown", symbol: "?", label: "Unknown", reason: "Actual execution counters are unavailable" };
  if (node.spillRole === "direct") {
    return { level: "critical", symbol: "×", label: "Spill source", reason: `${node.spillMethod || "Operator-specific spill evidence"}. Temporary I/O counters may include child work.` };
  }
  if ((node.estimateRatio ?? 0) >= 100) return passesRowsThrough(node.nodeType)
    ? { level: "critical", symbol: "×", label: "Estimate issue", reason: `${node.estimateRatio?.toFixed(1)}× row-estimate mismatch is visible at this ${node.nodeType}, but this operator commonly inherits rows; trace the first child where actual rows diverge` }
    : { level: "critical", symbol: "×", label: "Estimate issue", reason: `${node.estimateRatio?.toFixed(1)}× row-estimate mismatch; verify statistics, selectivity, correlation, and data skew at this row-producing operation` };
  if (node.loops >= 1_000 && node.timeShare >= 20 && (!node.timing || node.timing.scope === "serial" && node.timing.selfMs != null)) return { level: "critical", symbol: "×", label: "Bottleneck", reason: `${node.loops.toLocaleString()} loops amplify a material share of runtime` };
  if ((node.estimateRatio ?? 0) >= 10) return passesRowsThrough(node.nodeType)
    ? { level: "review", symbol: "!", label: "Review estimate", reason: `${node.estimateRatio?.toFixed(1)}× row-estimate mismatch is visible here; trace the child branch before attributing the cause to ${node.nodeType}` }
    : { level: "review", symbol: "!", label: "Review estimate", reason: `${node.estimateRatio?.toFixed(1)}× row-estimate mismatch; verify statistics, selectivity, and correlation` };
  if (node.loops >= 500) return { level: "review", symbol: "!", label: "Review", reason: `${node.loops.toLocaleString()} executions may amplify inner work` };
  if (node.spillRole === "inherited") return { level: "review", symbol: "!", label: "Inclusive temp I/O", reason: `${node.tempReadBlocks.toLocaleString()} temp blocks read and ${node.tempWrittenBlocks.toLocaleString()} written; these counters can include child work and do not establish a spill source` };
  if (node.flags.includes("scan")) return { level: "review", symbol: "!", label: "Review", reason: "Sequential scan; validate selectivity and rows removed before changing the access path" };
  return { level: "healthy", symbol: "✓", label: "Within checks", reason: "No deterministic node threshold was crossed" };
}
