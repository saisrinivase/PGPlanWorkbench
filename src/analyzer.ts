import type { Analysis, Finding, NodeMetric, PlanEnvelope, PlanNode, PlanVisualNode } from "./types.ts";
import { parsePlanInput } from "./input-boundary.ts";
import { coercionEvidence } from "./type-coercion.ts";
import { indexOnlyScanDiagnosis } from "./index-only-scan-diagnosis.ts";
import { typeCoercionDiagnosis } from "./type-coercion-diagnosis.ts";
import { rankRuntime } from "./runtime-ranking.ts";
import { attributeTiming } from "./timing-attribution.ts";

const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string => value == null ? "" : String(value);

function flatten(root: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    nodes.push(node);
    (node.Plans ?? []).forEach(visit);
  };
  visit(root);
  return nodes;
}

function measuredNestedLoopInner(nodes: PlanNode[], planMap: PlanVisualNode[], executionTime: number | null) {
  if (executionTime == null || executionTime <= 0) return undefined;
  const byPath = new Map(planMap.map(node => [node.path, node]));
  let strongest: { join: PlanVisualNode; inner: PlanVisualNode; ms: number; perLoop: number; share: number } | undefined;
  nodes.forEach((join, index) => {
    if (join["Node Type"] !== "Nested Loop") return;
    const visual = planMap[index], parent = visual.timing;
    if (parent?.scope !== "serial" || parent.status !== "measured" || parent.selfMs == null || parent.inclusiveMs == null) return;
    const inputs = (join.Plans ?? []).map((child, slot) => ({ child, slot }))
      .filter(({ child }) => !/^(?:InitPlan|SubPlan)$/.test(String(child["Parent Relationship"])) && child["Subplan Name"] == null);
    if (inputs.length !== 2) return;
    const [outer, innerInput] = inputs;
    // JSON can identify the inputs explicitly. Canonical TEXT preserves their
    // order but has no ordinary Inner/Outer relationship labels.
    if (outer.child["Parent Relationship"] != null && outer.child["Parent Relationship"] !== "Outer") return;
    if (innerInput.child["Parent Relationship"] != null && innerInput.child["Parent Relationship"] !== "Inner") return;
    const inner = byPath.get(`${visual.path}.${innerInput.slot + 1}`), timing = inner?.timing;
    if (!inner || timing?.scope !== "serial" || timing.status !== "measured" || timing.selfMs == null
      || timing.loops == null || timing.loops < 2 || timing.perLoopMs == null || timing.inclusiveMs == null) return;
    const ms = timing.inclusiveMs;
    if (ms < Math.max(50, executionTime * 0.2) || ms > Math.min(parent.inclusiveMs, executionTime)) return;
    if (!strongest || ms > strongest.ms) strongest = { join: visual, inner, ms, perLoop: timing.perLoopMs, share: 100 * (ms / executionTime) };
  });
  return strongest;
}

function firstMaterialEstimateDrift(nodes: PlanNode[], planMap: PlanVisualNode[]) {
  const candidates = nodes.flatMap((node, index) => {
    const planned = node["Plan Rows"], actual = node["Actual Rows"], loops = node["Actual Loops"];
    const visual = planMap[index];
    if (typeof planned !== "number" || planned < 1 || typeof actual !== "number" || actual < 0
      || typeof loops !== "number" || !Number.isSafeInteger(loops) || loops < 1 || visual.timing?.scope !== "serial") return [];
    const ratio = Math.max(actual / planned, planned / Math.max(actual, 1));
    const measuredMs = visual.timing.status === "measured" ? visual.timing.inclusiveMs ?? 0 : 0;
    if (ratio < 10 || Math.abs(actual - planned) < 100 || (actual < 100 && measuredMs < 50)) return [];
    return [{ visual, planned, actual, ratio, measuredMs }];
  });
  const qualifyingAncestors = new Set<string>();
  for (const { visual } of candidates) {
    let path = visual.path;
    while (path.includes(".")) {
      path = path.slice(0, path.lastIndexOf("."));
      qualifyingAncestors.add(path);
    }
  }
  return candidates.filter(({ visual }) => !qualifyingAncestors.has(visual.path))
    .sort((a, b) => b.measuredMs - a.measuredMs || Math.abs(b.actual - b.planned) - Math.abs(a.actual - a.planned) || a.visual.rank - b.visual.rank)[0];
}

function directSpillEvidence(node: PlanNode): string {
  if (node["Actual Loops"] === 0) return "";
  const kind = text(node["Node Type"]);
  if (/^(Sort|Incremental Sort)$/.test(kind)) {
    const diskSort = (item: Record<string, unknown>) => item["Sort Space Type"] === "Disk"
      || /^external (merge|sort)\b/i.test(text(item["Sort Method"]));
    if (diskSort(node)) return "disk-backed sort";
    for (const key of ["Full-sort Groups", "Pre-sorted Groups"]) {
      const group = node[key] as Record<string, unknown> | undefined;
      if (group && number((group["Sort Space Disk"] as Record<string, unknown> | undefined)?.["Peak Sort Space Used"]) > 0)
        return "disk-backed incremental sort group";
    }
  }
  if (kind === "Hash") {
    const batches = number(node["Hash Batches"] ?? node.Batches);
    if (batches > 1) return `${batches.toLocaleString()} hash batches`;
  }
  if (kind === "Aggregate" && /^(Hashed|Mixed)$/.test(text(node.Strategy))) {
    const batches = number(node["HashAgg Batches"]);
    const disk = number(node["Disk Usage"]);
    if (disk > 0 || batches > 1) return [batches > 1 ? `${batches.toLocaleString()} hash aggregate batches` : "", disk > 0 ? `${disk.toLocaleString()} kB disk usage` : ""].filter(Boolean).join("; ");
  }
  return "";
}

function buildPlanMap(root: PlanNode, executionTime: number | null): PlanVisualNode[] {
  const rows: PlanVisualNode[] = [];
  const visit = (node: PlanNode, depth: number, path: string) => {
    const item = metric(node, rows.length + 1);
    const children = node.Plans ?? [];
    const childTime = children.reduce((sum, child) => sum + number(child["Actual Total Time"]) * number(child["Actual Loops"]), 0);
    const flags: string[] = [];
    const tempReadBlocks = number(node["Temp Read Blocks"]), tempWrittenBlocks = number(node["Temp Written Blocks"]);
    const spillMethod = directSpillEvidence(node);
    const directSpill = Boolean(spillMethod);
    if (directSpill) flags.push("spill");
    else if (item.tempBlocks > 0) flags.push("inherited-spill");
    if ((item.estimateRatio ?? 0) >= 10) flags.push("estimate");
    if (item.loops >= 500) flags.push("loops");
    if (/Seq Scan$/i.test(text(node["Node Type"]))) flags.push("scan");
    const expressionKeys = ["Index Cond", "Recheck Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "Output", "Sort Key", "Group Key"] as const;
    const expressions = expressionKeys.flatMap((source) => {
      const value = node[source];
      if (Array.isArray(value)) return value.map((entry) => ({ source, text: text(entry) })).filter((entry) => entry.text);
      const expression = text(value);
      return expression ? [{ source, text: expression }] : [];
    });
    if (coercionEvidence(expressions).length) flags.push("coercion");
    rows.push({
      ...item,
      schemaName: typeof node.Schema === "string" ? node.Schema : undefined,
      aliasName: typeof node.Alias === "string" ? node.Alias : undefined,
      indexName: typeof node["Index Name"] === "string" ? node["Index Name"] : undefined,
      depth,
      path,
      selfTime: Math.max(0, item.totalTime - childTime),
      timeShare: executionTime && executionTime > 0 ? Math.min(100, item.totalTime / executionTime * 100) : 0,
      flags,
      workersPlanned: number(node["Workers Planned"]),
      workersLaunched: number(node["Workers Launched"]),
      predicate: text(node["Index Cond"] ?? node["Recheck Cond"] ?? node["Hash Cond"] ?? node["Merge Cond"] ?? node["Join Filter"] ?? node["Filter"]),
      actualTimingCaptured: typeof node["Actual Total Time"] === "number" && typeof node["Actual Rows"] === "number" && typeof node["Actual Loops"] === "number",
      heapFetches: typeof node["Heap Fetches"] === "number" ? node["Heap Fetches"] : null,
      rowsRemovedByFilter: number(node["Rows Removed by Filter"]),
      sharedHits: number(node["Shared Hit Blocks"]),
      tempReadBlocks,
      tempWrittenBlocks,
      tempReadTime: number(node["Temp I/O Read Time"]),
      tempWriteTime: number(node["Temp I/O Write Time"]),
      spillRole: directSpill ? "direct" : item.tempBlocks > 0 ? "inherited" : null,
      spillMethod,
      expressions,
    });
    children.forEach((child, index) => visit(child, depth + 1, `${path}.${index + 1}`));
  };
  visit(root, 0, "1");
  return rows;
}

function normalizeSettings(value: PlanEnvelope["Settings"]): Array<{ name: string; value: string }> {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => Object.entries(item).map(([name, setting]) => ({ name, value: text(setting) })));
  }
  return Object.entries(value).map(([name, setting]) => ({ name, value: text(setting) }));
}

function memoryMb(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*(kb|mb|gb)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "kb").toLowerCase();
  return amount * (unit === "gb" ? 1024 : unit === "mb" ? 1 : 1 / 1024);
}

function metric(node: PlanNode, rank: number): NodeMetric {
  const actual = number(node["Actual Rows"]);
  const planned = number(node["Plan Rows"]);
  return {
    rank,
    nodeType: text(node["Node Type"]) || "Unknown node",
    relation: text(node["Relation Name"] ?? node["Index Name"]) || "—",
    totalTime: number(node["Actual Total Time"]) * number(node["Actual Loops"]),
    rows: actual,
    plannedRows: planned,
    loops: number(node["Actual Loops"]),
    estimateRatio: node["Actual Loops"] === 0 ? null : planned > 0 ? Math.max(actual / planned, planned / Math.max(actual, 1)) : null,
    tempBlocks: number(node["Temp Read Blocks"]) + number(node["Temp Written Blocks"]),
    sharedReads: number(node["Shared Read Blocks"]),
  };
}

export function analyzePlan(source: string): Analysis {
  const envelope = parsePlanInput(source);
  const nodes = flatten(envelope.Plan);
  const settings = normalizeSettings(envelope.Settings);
  const settingsCaptured = Object.prototype.hasOwnProperty.call(envelope, "Settings");
  const runtime = typeof envelope["Execution Time"] === "number" || nodes.some((node) => typeof node["Actual Total Time"] === "number");
  const buffers = nodes.some((node) => "Shared Read Blocks" in node || "Shared Hit Blocks" in node);
  const temp = nodes.some((node) => number(node["Temp Read Blocks"]) + number(node["Temp Written Blocks"]) > 0);
  const wal = nodes.some((node) => "WAL Records" in node || "WAL Bytes" in node);
  const planningTime = typeof envelope["Planning Time"] === "number" ? envelope["Planning Time"] : null;
  const executionTime = typeof envelope["Execution Time"] === "number" ? envelope["Execution Time"] : null;
  const planMap = buildPlanMap(envelope.Plan, executionTime);
  const attribution = attributeTiming(envelope.Plan);
  planMap.forEach((node, index) => { node.timing = attribution[index]; });
  const root = envelope.Plan;
  const maxRowsRemoved = Math.max(0, ...nodes.map((node) => (number(node["Rows Removed by Filter"]) + number(node["Rows Removed by Join Filter"])) * Math.max(1, number(node["Actual Loops"]))));
  const maxLoops = Math.max(0, ...nodes.map((node) => number(node["Actual Loops"])));
  const maxHashBatches = Math.max(0, ...nodes.map((node) => number(node["HashAgg Batches"]) || number(node["Hash Batches"]) || number(node.Batches)));
  const workersPlanned = Math.max(0, ...nodes.map((node) => number(node["Workers Planned"])));
  const workersLaunched = Math.max(0, ...nodes.map((node) => number(node["Workers Launched"])));
  const metrics = {
    rootSharedHits: number(root["Shared Hit Blocks"]), rootSharedReads: number(root["Shared Read Blocks"]),
    rootTempBlocks: number(root["Temp Read Blocks"]) + number(root["Temp Written Blocks"]),
    rootWalRecords: number(root["WAL Records"]), rootWalBytes: number(root["WAL Bytes"]),
    maxRowsRemoved, maxLoops, maxHashBatches, workersPlanned, workersLaunched,
  };
  const checks = [
    { label: "Runtime", present: runtime, value: runtime ? "Actual node timing present" : "Estimated-only capture" },
    { label: "Buffers", present: buffers, value: buffers ? "Buffer counters present" : "No buffer counters" },
    { label: "Settings", present: settingsCaptured, value: !settingsCaptured ? "Not captured" : settings.length ? `${settings.length} non-default` : "Captured; no non-default values" },
    { label: "WAL", present: wal, value: wal ? "WAL counters present" : "Not captured" },
  ];
  const score = Math.min(100, 25 + (runtime ? 30 : 0) + (buffers ? 20 : 0) + (settingsCaptured ? 15 : 0) + (wal ? 10 : 0));
  const findings: Finding[] = [];
  const hotspots = nodes.map((node, index) => metric(node, index + 1)).sort((a, b) => b.totalTime - a.totalTime).slice(0, 8).map((item, index) => ({ ...item, rank: index + 1 }));
  const elevatedWorkMem = settings.find((setting) => setting.name.toLowerCase() === "work_mem" && memoryMb(setting.value) >= 512);
  const spillSource = planMap.find((node) => node.spillRole === "direct");
  const spill = spillSource ?? (temp ? planMap.find((node) => node.tempBlocks > 0) : undefined);
  const badEstimate = firstMaterialEstimateDrift(nodes, planMap);
  const seqScans = nodes.flatMap((node, index) => {
    if (!/Seq Scan$/i.test(text(node["Node Type"]))) return [];
    const loops = Math.max(1, number(node["Actual Loops"]));
    const removed = number(node["Rows Removed by Filter"]) * loops;
    const returned = number(node["Actual Rows"]) * loops;
    if (removed < 10000 || removed < Math.max(10000, returned * 5)) return [];
    return [{ node, removed, visualNode: planMap[index], treeOrder: index }];
  }).sort((left, right) => right.removed - left.removed
    || right.visualNode.sharedReads - left.visualNode.sharedReads
    || right.visualNode.totalTime - left.visualNode.totalTime
    || left.treeOrder - right.treeOrder);
  const seqScan = seqScans[0]?.node;
  const seqScanPath = seqScans[0]?.visualNode.path;
  const seqScanPriority = seqScans.length > 1
    ? `It is prioritized among ${seqScans.length} qualifying scans by filtered-row count, then captured shared reads and node time to break ties; the other qualifying scans remain visible in the plan. This is an investigation priority, not a runtime-cost ranking.`
    : "This is prioritized by filtered-row count, then captured shared reads and node time to break ties; these are investigation-priority signals, not a runtime-cost ranking.";
  const repeatedInner = measuredNestedLoopInner(nodes, planMap, executionTime);
  const parallelSuppressed = settings.some((setting) => setting.name === "max_parallel_workers_per_gather" && setting.value === "0") && nodes.some((node) => node["Node Type"] === "Seq Scan" && number(node["Actual Rows"]) >= 100000);
  const writeWal = /ModifyTable|Insert|Update|Delete/.test(text(root["Node Type"])) && (metrics.rootWalRecords >= 1000 || metrics.rootWalBytes >= 1048576);
  const limitNode = nodes.find((node) => node["Node Type"] === "Limit");
  const largeOffset = limitNode && (limitNode.Plans ?? []).some((child) => number(child["Actual Rows"]) >= Math.max(10000, number(limitNode["Actual Rows"]) * 100));
  const coercions = planMap.flatMap((node) => coercionEvidence(node.expressions ?? []).map((evidence) => ({ node, evidence })));
  const coercionDiagnosis = typeCoercionDiagnosis(planMap, null);
  const indexOnlyReview = planMap.map((node) => ({ node, diagnosis: indexOnlyScanDiagnosis(node) }))
    .filter((item) => item.diagnosis?.review)
    .sort((a, b) => b.node.totalTime - a.node.totalTime)[0];
  if (!runtime) findings.push({ id: "EV-001", title: "Runtime evidence is missing", detail: "This capture can describe shape and cost, but it cannot prove where elapsed time was spent.", severity: "critical", evidence: "Execution Time / Actual timing absent", nextAction: "Capture EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, WAL, FORMAT JSON)." });
  if (elevatedWorkMem) findings.push({ id: "ENV-001", title: "Elevated work_mem may make this capture non-representative", detail: `The plan was captured with work_mem=${elevatedWorkMem.value}. Memory can multiply across active sort/hash operators and concurrent sessions.`, severity: "critical", evidence: `Settings.work_mem = ${elevatedWorkMem.value}`, nextAction: "Re-test under normal environment guardrails and review PostgreSQL/RDS memory logs." });
  if (spill) {
    if (spillSource) {
      findings.push({ id: "MEM-001", nodePath: spillSource.path, title: `Direct spill at ${spillSource.nodeType}`,
        evidence: `Operation ${spillSource.rank} · ${spillSource.nodeType}: ${spillSource.spillMethod}`,
        detail: "Operator-specific evidence identifies a spill here. Temporary block and I/O timing counters at this operation can include its children; they do not isolate spill cost or establish that it dominates runtime.",
        severity: "warning", nextAction: "In staging, test one bounded transaction-local work_mem adjustment only after checking memory headroom and concurrency. Compare the same operation and repeated runtime." });
    } else {
      findings.push({ id: "MEM-002", title: "Temporary I/O source not established",
        evidence: `Operation ${spill.rank} · ${spill.nodeType}: ${spill.tempReadBlocks.toLocaleString()} temporary blocks read, ${spill.tempWrittenBlocks.toLocaleString()} written (inclusive)`,
        detail: "These counters can include child operations. Without operator-specific evidence the source is unknown; do not label this node a spill or assume a memory change will help.",
        severity: "info", nextAction: "Recapture a representative read-only query in staging with EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) and inspect sort methods, disk usage, and hash batches before changing settings." });
    }
  }
  if (badEstimate) {
    const { visual, planned, actual, ratio } = badEstimate;
    findings.push({ id: "EST-001", nodePath: visual.path, title: "Cardinality estimate drift",
      evidence: `Operation ${visual.rank} · ${visual.nodeType}: ${planned.toLocaleString()} estimated vs ${actual.toLocaleString()} actual rows per execution`,
      detail: `The planner ${actual > planned ? "underestimated" : "overestimated"} rows ${actual === 0 ? "and the operation returned none" : `by about ${ratio.toFixed(1)}×`}. This is a qualifying divergence with no qualifying descendant on its branch. Row counts do not establish runtime impact, stale statistics, or a missing index.`,
      severity: "warning", nextAction: "Inspect statistics for the affected predicate or join keys in staging. If you confirm a stale-statistics hypothesis, test refreshing only the affected table’s statistics in a disposable staging copy." });
  }
  if (seqScan) findings.push({ id: "PATH-001", nodePath: seqScanPath, title: "High-volume sequential scan filtering", detail: `${text(seqScan["Relation Name"]) || "A relation"} recorded ${(number(seqScan["Rows Removed by Filter"]) * Math.max(1, number(seqScan["Actual Loops"]))).toLocaleString()} rows removed by the filter relative to its returned rows. ${seqScanPriority}`, severity: "warning", evidence: "Rows Removed by Filter is at least 5× returned rows and at least 10,000", nextAction: "Validate predicate selectivity and indexability before proposing an index." });
  if (indexOnlyReview?.diagnosis) findings.push({ id: "IOS-001", nodePath: indexOnlyReview.node.path, title: indexOnlyReview.diagnosis.summary, detail: indexOnlyReview.diagnosis.evidence, severity: "warning", evidence: `${indexOnlyReview.diagnosis.classification}: ${indexOnlyReview.node.nodeType} at operation ${indexOnlyReview.node.rank}`, nextAction: indexOnlyReview.diagnosis.nextAction });
  if (repeatedInner) {
    const { join, inner, ms, perLoop, share } = repeatedInner;
    findings.push({ id: "CPU-001", nodePath: inner.path, title: "Repeated nested-loop inner work",
      evidence: `Operation ${inner.rank} · ${inner.nodeType}: ${inner.loops.toLocaleString()} loops at ${perLoop.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms average per loop`,
      detail: `The inner input of Nested Loop operation ${join.rank} accumulated about ${ms.toFixed(1)} ms of inclusive time (${share.toFixed(1)}% of captured execution). Do not add this to parent time. This locates work; it does not establish CPU usage, a bad join choice, or a missing index.`,
      severity: "warning", nextAction: "In staging only, compare the unchanged query with a transaction-local enable_nestloop = off setting. If no alternative plan appears, the experiment is inconclusive." });
  }
  if (parallelSuppressed) findings.push({ id: "PAR-001", title: "Parallel execution was explicitly suppressed", detail: "A high-volume scan ran with max_parallel_workers_per_gather=0.", severity: "warning", evidence: "Settings.max_parallel_workers_per_gather = 0 with a high-volume Seq Scan", nextAction: "Compare under normal parallel settings; verify workers launch and runtime improves before changing production policy." });
  if (writeWal) findings.push({ id: "WAL-001", title: "Material WAL generation", detail: `${metrics.rootWalRecords.toLocaleString()} WAL records and ${metrics.rootWalBytes.toLocaleString()} WAL bytes were measured at the modifying root.`, severity: "warning", evidence: "ModifyTable root WAL counters", nextAction: "Validate replica lag, WAL bandwidth, checkpoint pressure, and batch size under representative concurrency." });
  if (largeOffset) findings.push({ id: "PAGE-001", title: "Large OFFSET discards substantial index work", detail: `The child node processed ${number(limitNode?.Plans?.[0]?.["Actual Rows"]).toLocaleString()} rows to return ${number(limitNode?.["Actual Rows"]).toLocaleString()}.`, severity: "warning", evidence: "Limit child Actual Rows is at least 100× output rows", nextAction: "Test keyset pagination using the last seen ordering key and compare runtime and buffer accesses." });
  if (coercions.length) {
    findings.push({ id: "TYPE-001", nodePath: coercionDiagnosis.node?.path, title: "Plan-visible type coercion", detail: `${coercionDiagnosis.summary} ${coercionDiagnosis.unknown}`, severity: coercionDiagnosis.cast?.context === "predicate" ? "warning" : "info", evidence: coercionDiagnosis.evidence, nextAction: coercionDiagnosis.nextAction });
  }
  const planningDominates = planningTime != null && executionTime != null && planningTime >= 10 && planningTime > executionTime * 2;
  const runtimeRanking = rankRuntime(root, planMap, executionTime);
  const measuredIndexHotspot = indexOnlyReview?.node;
  const measuredHotspot = planMap.find((node) => node.path === runtimeRanking.operations[0]?.path);
  const hotspotLeads = Boolean(measuredIndexHotspot && measuredHotspot?.path === measuredIndexHotspot.path);
  if (measuredHotspot && !elevatedWorkMem && !planningDominates) {
    const position = findings.findIndex((finding) => finding.nodePath === measuredHotspot.path
      && ["IOS-001", "MEM-001", "PATH-001", "CPU-001"].includes(finding.id));
    if (position >= 0) findings.unshift(...findings.splice(position, 1));
  }
  const primarySignal = !runtime ? "Capture quality" : elevatedWorkMem ? "Capture guardrail" : planningDominates ? "Planning overhead" : hotspotLeads ? "Index-only access" : spillSource ? "Memory / spill" : spill ? "Temporary I/O (unattributed)" : writeWal ? "WAL / write pressure" : largeOffset ? "Pagination work" : parallelSuppressed ? "Parallelism" : badEstimate ? "Estimate drift" : indexOnlyReview ? "Index-only access" : repeatedInner ? "Loop amplification" : seqScan ? "Access path" : coercions.length ? "Type coercion" : "No dominant risk detected";
  if (!findings.length) findings.push({ id: "BASE-001", title: "No high-confidence risk crossed the current thresholds", detail: "The captured evidence does not show a dominant spill, estimate, scan, or loop-amplification signal.", severity: "info", evidence: `${nodes.length} nodes analyzed`, nextAction: "Compare against a known slow baseline before accepting a tuning change." });
  return {
    format: envelope.__format ?? "JSON", postgresMajor: envelope.__postgresMajor ?? null, adapter: envelope.__postgresMajor ? `PostgreSQL ${envelope.__postgresMajor} normalized` : "PostgreSQL canonical",
    score, evidenceLevel: score >= 80 ? "Strong" : score >= 55 ? "Usable" : "Weak",
    executionTime, planningTime, nodeCount: nodes.length, primarySignal,
    headline: measuredHotspot && !elevatedWorkMem && !planningDominates
      ? `${measuredHotspot.nodeType} has approximately ${runtimeRanking.operations[0].selfShare.toFixed(1)}% of captured execution in derived self time. This locates measured work, not its root cause; estimate drift and other findings remain separate investigations.`
      : runtime ? `${primarySignal} is an investigation signal in this capture, not proof of the dominant runtime cause.` : "Evidence is too weak for runtime hotspot claims.",
    runtimeRanking, checks, findings, hotspots, planMap, settings, metrics,
    metricCapture: {
      rootBuffers: ["Shared Read Blocks", "Shared Hit Blocks", "Temp Read Blocks", "Temp Written Blocks"].some((key) => key in root),
      rootWal: "WAL Bytes" in root,
      rootRows: "Actual Rows" in root,
      rootPlanRows: "Plan Rows" in root,
    },
  };
}
