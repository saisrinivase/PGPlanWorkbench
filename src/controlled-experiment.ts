import type { Finding } from "./types.ts";

export interface ControlledExperiment {
  hypothesis: string;
  prerequisites: string[];
  action: string;
  successCriteria: string[];
  rollback: string;
}

export function controlledExperiment(finding: Finding): ControlledExperiment {
  const common = {
    prerequisites: ["Use the same SQL and representative parameter values.", "Capture normal settings, comparable cache state, and representative concurrency."],
    successCriteria: ["Repeated execution time improves materially, not only once.", "The measured evidence behind this finding falls without a material read, temp, WAL, or concurrency regression."],
    rollback: "Remove or revert only the tested change if the after-plan gate fails or workload risk increases.",
  };
  if (finding.id.startsWith("EST")) return {
    ...common,
    hypothesis: "If stale statistics explain this mismatch, refreshing them may improve the estimate and plan choice.",
    action: finding.nextAction,
    prerequisites: [...common.prerequisites, "Confirm a plausible statistics freshness issue first; otherwise do not run this experiment. Use a disposable staging copy and change nothing else."],
    successCriteria: ["Compare the corresponding operation and verify the estimate moves closer to actual rows. Separately verify equivalent results.", ...common.successCriteria],
    rollback: "Discard the staging copy or restore its baseline snapshot. Do not apply a production change based on the row mismatch alone.",
  };
  if (finding.id.startsWith("PATH")) return { ...common, hypothesis: "A selective, type-compatible access path can reduce rows filtered and buffer work.", action: finding.nextAction, prerequisites: [...common.prerequisites, "Confirm existing indexes, operator classes, column types, selectivity, write cost, and table size."], successCriteria: ["Rows removed and shared reads fall at the scan.", ...common.successCriteria] };
  if (finding.id === "MEM-001") return { ...common,
    hypothesis: "A bounded memory change may reduce the observed spill; the current capture does not prove a runtime benefit.",
    action: finding.nextAction,
    prerequisites: [...common.prerequisites, "Use a disposable staging environment and a read-only query. Review work_mem, hash memory, parallel workers, and concurrent operators before changing the setting."],
    successCriteria: ["At the matching operation, verify the disk sort disappears or observed hash batches or disk usage fall. Review temporary counters as inclusive evidence, not as isolated spill cost.", ...common.successCriteria],
    rollback: "End the staging transaction to discard the local memory setting. Do not raise production memory limits from this capture alone.",
  };
  if (finding.id === "MEM-002") return {
    hypothesis: "The observed temporary I/O may include descendant work; the producing operator is not established.",
    action: finding.nextAction,
    prerequisites: ["Use a representative read-only query in a safe staging environment. Leave memory and query settings unchanged while collecting attribution evidence."],
    successCriteria: ["Find operator-specific spill evidence or retain the unknown-source classification. A repeated inclusive count alone does not establish the source."],
    rollback: "No setting or query change is proposed at this stage.",
  };
  if (finding.id.startsWith("TYPE")) return { ...common, hypothesis: "Aligning the originating expression type will remove the plan-visible coercion and restore type-compatible comparison/index use.", action: finding.nextAction, successCriteria: ["The cast disappears from the same plan expression.", ...common.successCriteria] };
  if (finding.id === "CPU-001") return {
    hypothesis: "An alternative join plan may avoid materially repeated inner work; the capture does not prove it will be faster.",
    action: finding.nextAction,
    prerequisites: [...common.prerequisites, "Use a disposable staging environment and a read-only query. Change only the transaction-local join preference; the setting discourages nested loops but cannot always eliminate them. No index change is proposed."],
    successCriteria: ["Use at least three independent captures per side and separately confirm equivalent results.", "Confirm repeated inner work falls or disappears without moving the cost elsewhere.", ...common.successCriteria],
    rollback: "End the staging transaction to discard the local setting. Do not promote the setting to production; retain the baseline if the comparison fails or is inconclusive.",
  };
  return { ...common, hypothesis: finding.detail, action: finding.nextAction };
}
