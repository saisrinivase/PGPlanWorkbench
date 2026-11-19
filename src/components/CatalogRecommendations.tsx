import { useState } from "react";
import type { Analysis } from "../types.ts";
import type { DatabaseContext } from "../database-context.ts";
import { catalogRecommendations, contextSnapshotLabel } from "../catalog-recommendations.ts";

export function CatalogRecommendations({ result, context, onViewNode }: { result: Analysis; context: DatabaseContext | null; onViewNode?: (rank: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!context) return null;
  const reviews = catalogRecommendations(result, context);
  return <section className="recommendation-section" aria-label="Catalog-qualified recommendations">
    <details className="runtime-ranking-body" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Catalog-qualified next steps · {reviews.length} operation(s)</summary>
      {open && <>
        <p>Snapshot collected: {contextSnapshotLabel(context)}. Snapshot evidence only—not current catalog verification. Confirm the same environment and comparable capture time; an old timestamp alone does not prove stale statistics.</p>
        {reviews.map((review) => {
          const node = result.planMap.find((item) => item.path === review.path)!;
          return <details key={review.path}>
            <summary>Operation {node.rank}: {node.nodeType} on {node.relation}</summary>
            {review.checks.map((check) => <div className="runtime-ranking-operation" key={check.topic}>
              <strong>{check.topic} · {check.classification}</strong>
              <span>{check.evidence}</span><small>Next: {check.nextAction}</small>
            </div>)}
            {onViewNode && <button type="button" onClick={() => onViewNode(node.rank)}>Inspect catalog evidence operation {node.rank}</button>}
          </details>;
        })}
        <p>Showing up to 20 relevant operations. Catalog evidence qualifies hypotheses; it does not verify a production fix.</p>
      </>}
    </details>
  </section>;
}
