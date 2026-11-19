import type { Analysis } from "../types.ts";
import { useState } from "react";
import "../runtime-ranking.css";

export function RuntimeHotspots({ result, onViewNode }: { result: Analysis; onViewNode?: (rank: number) => void }) {
  const [timingOpen, setTimingOpen] = useState(false);
  const ranking = result.runtimeRanking;
  const special = result.planMap.filter((node) => node.timing && (node.timing.scope !== "serial" || node.timing.selfMs == null || node.timing.status === "never-executed"));
  if (!ranking) return null;
  return <section className="recommendation-section" aria-label="Measured runtime ranking">
    <header><strong>Where execution time went</strong><small>Derived self time · separate from suspected causes</small></header>
    <div className="runtime-ranking-body">
      <p>{ranking.reason}</p>
      {ranking.status === "no-material-hotspot" && <p>No operation crossed both 50 ms and 20% of execution in approximate self time. This does not prove the query is efficient.</p>}
      {ranking.operations.map((operation) => {
        const node = result.planMap.find((item) => item.path === operation.path)!;
        return <div className="runtime-ranking-operation" key={operation.path}>
          <strong>{node.nodeType}{node.relation !== "—" ? ` on ${node.relation}` : ""}</strong>
          <span>{operation.selfMs.toFixed(2)} ms approximate self ({operation.selfShare.toFixed(1)}%) · {operation.inclusiveMs.toFixed(2)} ms inclusive · {node.loops.toLocaleString()} loop(s)</span>
          <small>A measured hotspot is not proof of a missing index, stale statistics or CPU saturation.</small>
          {onViewNode && <button type="button" onClick={() => onViewNode(node.rank)}>Inspect timed operation {node.rank}</button>}
        </div>;
      })}
      {special.length > 0 && <details onToggle={(event) => setTimingOpen(event.currentTarget.open)}>
        <summary>Timing attribution: {special.length} operation(s) with caveats</summary>
        {timingOpen && special.slice(0, 50).map((node) => {
          const timing = node.timing!;
          const value = (amount: number | null) => amount == null ? "Unknown" : `${amount.toFixed(2)} ms`;
          return <div className="runtime-ranking-operation" key={node.path}>
            <strong>Operation {node.rank}: {node.nodeType}{node.relation !== "—" ? ` on ${node.relation}` : ""} · {timing.status}</strong>
            <span>{timing.loops ?? "Unknown"} loops · per-loop inclusive {value(timing.perLoopMs)} · accumulated inclusive {value(timing.inclusiveMs)} · approximate self {value(timing.selfMs)}</span>
            <small>{timing.reason}</small>
            {timing.workers.slice(0, 10).map((worker, index) => <small key={index}>Worker {worker.number ?? "unknown"}: {worker.loops ?? "unknown"} loops · mean inclusive {value(worker.perLoopMs)} · accumulated process time {value(worker.processMs)}. Not added to node time.</small>)}
            {timing.workers.length > 10 && <small>Showing first 10 of {timing.workers.length} captured workers.</small>}
            {onViewNode && <button type="button" onClick={() => onViewNode(node.rank)}>Inspect attribution operation {node.rank}</button>}
          </div>;
        })}
        {timingOpen && special.length > 50 && <p>Showing first 50 operations. Export the report for all timing caveats.</p>}
      </details>}
    </div>
  </section>;
}
