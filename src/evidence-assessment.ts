import type { Analysis, EvidenceClaim, Finding } from "./types.ts";

function suspectedCause(finding: Finding, result: Analysis) {
  if (finding.id === "MEM-002") return "Temporary I/O was captured, but the producing operation and cause remain unknown.";
  if (finding.id.startsWith("MEM")) return "The spill may be material to elapsed time; captured temp I/O timing and a controlled after plan are needed to prove impact.";
  if (finding.id.startsWith("EST")) {
    const node = result.planMap.find(item => item.path === finding.nodePath);
    if (!node) return "Cause not established. Locate the executed operation and compare its estimated and actual rows before choosing a statistics change.";
    if (/join/i.test(node.nodeType)) return "Cause not established. Compare both input branches first: accurate inputs with a mismatched join output point to join selectivity; a mismatched input needs investigation on that branch. Neither proves stale statistics.";
    if (/scan/i.test(node.nodeType)) return "Cause not established. Check the scan predicate, captured parameter values and relevant column statistics before deciding whether a statistics change is justified.";
    return "Cause not established. Compare this operation with its input rows and inspect the estimate-changing predicate or grouping before proposing a change.";
  }
  if (finding.id.startsWith("PATH")) return "An alternative access path may reduce filtering work if the predicate is selective and indexable.";
  if (finding.id.startsWith("CPU")) return "Join order or repeated inner access may be amplifying otherwise small work.";
  if (finding.id.startsWith("TYPE")) return "A UNION, view output, parameter, or environment type drift may have introduced the visible cast.";
  return "The measured signal may contribute to runtime, but causality requires a controlled comparison.";
}

export function evidenceClaims(result: Analysis, finding: Finding): EvidenceClaim[] {
  const missing = result.checks.filter((check) => !check.present).map((check) => `${check.label}: ${check.value}`);
  return [
    { classification: "observed", status: "available", label: "Captured fact", detail: finding.evidence },
    { classification: "derived", status: "available", label: "Rule result", detail: finding.detail },
    { classification: "suspected", status: "available", label: "Cause to test", detail: suspectedCause(finding, result) },
    { classification: "unknown", status: "available", label: "Not established", detail: [...missing, "Catalog indexes, statistics freshness, data distribution, concurrency, and representative cache state are not proven by the plan."].join(" ") },
    { classification: "verified", status: "not-established", label: "After-plan proof", detail: finding.id === "MEM-002"
      ? "Not established. Identify the source before proposing or validating a change."
      : "Not verified. Apply one controlled change and pass Fix Validation with comparable SQL, parameters, settings, cache state, concurrency, and repeated execution." },
  ];
}
