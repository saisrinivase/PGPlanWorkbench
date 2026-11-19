import { contextRelationName, findContextRelation, type DatabaseContext } from "./database-context.ts";
import { indexCandidate, qualifyIndexCandidate } from "./index-candidate.ts";
import { statisticsDiagnosis } from "./statistics-diagnosis.ts";
import type { Analysis, EvidenceClassification, PlanVisualNode } from "./types.ts";

export interface CatalogCheck {
  topic: "Existing indexes" | "Column types" | "Statistics" | "Visibility";
  classification: EvidenceClassification;
  evidence: string;
  nextAction: string;
}
export interface CatalogRecommendation { path: string; checks: CatalogCheck[] }

export function contextSnapshotLabel(context: DatabaseContext) {
  return context.provenance.collector === "legacy-v1" && context.provenance.collectedAt === new Date(0).toISOString()
    ? "not captured (legacy import)" : context.provenance.collectedAt;
}

export function qualifyOperation(node: PlanVisualNode, context: DatabaseContext): CatalogRecommendation {
  const relation = findContextRelation(context, contextRelationName(node));
  const unknown = (topic: CatalogCheck["topic"], evidence: string, nextAction: string): CatalogCheck => ({ topic, classification: "unknown", evidence, nextAction });
  if (!relation) return { path: node.path, checks: [unknown("Existing indexes", "No unique schema/relation match. Catalog evidence cannot be assigned safely.", "Capture schema-qualified relation metadata from the same environment; do not create an index from this match.")] };
  const checks: CatalogCheck[] = [];
  const candidate = indexCandidate(node);
  if (context.availability.indexStats.status !== "captured") checks.push(unknown("Existing indexes", "Index inventory is unavailable; an empty list does not prove absence.", "Import index inventory before recommending another index."));
  else if (candidate) {
    const qualification = qualifyIndexCandidate(candidate, context);
    checks.push({ topic: "Existing indexes", classification: qualification.status === "existing-index" ? "observed" : qualification.status === "qualified-candidate" ? "suspected" : "unknown", evidence: qualification.detail,
      nextAction: qualification.status === "existing-index" ? "Investigate the existing index and operator/type compatibility; do not create a duplicate." : "Resolve overlap, type and selectivity prerequisites before any controlled index experiment." });
  } else {
    const existing = node.indexName ? relation.indexes.find((index) => index.name === node.indexName) : undefined;
    checks.push(existing ? { topic: "Existing indexes", classification: "observed",
      evidence: `${existing.name} is captured: valid ${existing.valid ?? "unknown"}, ready ${existing.ready ?? "unknown"}, keys (${existing.columns.join(", ")}), INCLUDE (${existing.includeColumns?.join(", ") || "none captured"}). INCLUDE columns are not search keys.`,
      nextAction: existing.valid === false || existing.ready === false ? "Plan/index metadata disagree; verify snapshot time and environment before any change." : "Review the captured access path; a present index does not prove optimal key order or a need for another index."
    } : unknown("Existing indexes", "No exact used-index match or supported plain-column candidate was established.", "Review index definitions, expression/partial predicates and operator classes. Do not infer index absence."));
  }
  // Match identifiers only at this scan's relation/alias boundary, never through a join or SQL literal.
  const masked = node.predicate.replace(/'(?:''|[^'])*'/g, " ");
  const tokens = masked.match(/[a-z_][\w$]*(?:\.[a-z_][\w$]*)?/gi) ?? [];
  const columns = relation.columns.filter((column) => tokens.some((token) => {
    const parts = token.split(".");
    return parts.at(-1) === column.name && (parts.length === 1 || parts[0] === node.aliasName || parts[0] === relation.name);
  }));
  checks.push(context.availability.columnStats.status === "captured" && columns.length
    ? { topic: "Column types", classification: "observed", evidence: columns.map((column) => `${column.name}: ${column.type}`).join("; ") + ". Catalog types do not prove expression, parameter or UNION output types.", nextAction: "Compare these types with the plan predicate and originating SQL/view definitions before changing casts. Operator-class and collation compatibility remain unverified." }
    : unknown("Column types", "Predicate columns or type metadata could not be matched safely.", "Import column metadata and SQL/view lineage; do not guess the source type from a cast target."));
  const statistics = statisticsDiagnosis([node], context);
  checks.push({ topic: "Statistics", classification: statistics.classification,
    evidence: `${statistics.summary} ${statistics.evidence} Last ANALYZE: ${relation.lastAnalyze ?? "not captured"}; last auto-ANALYZE: ${relation.lastAutoAnalyze ?? "not captured"}. ${statistics.unknown}`,
    nextAction: statistics.nextAction });
  if (/Index Only Scan/i.test(node.nodeType)) {
    const pages = relation.relationPages, visible = relation.allVisiblePages;
    if (context.availability.relationStats.status !== "captured" || pages == null || visible == null || pages <= 0)
      checks.push(unknown("Visibility", "Visibility-page estimates are unavailable or the relation has no captured pages. Dead tuples or vacuum dates alone do not establish visibility-map coverage.", "Collect relpages/relallvisible and maintenance timestamps; retain the plan's captured Heap Fetches as execution evidence."));
    else checks.push({ topic: "Visibility", classification: "derived",
      evidence: `${visible}/${pages} pages (${(100 * visible / pages).toFixed(1)}%) estimated all-visible in the catalog snapshot. Heap Fetches in the plan: ${node.heapFetches ?? "not captured"}. Last vacuum: ${relation.lastVacuum ?? "not captured"}; auto-vacuum: ${relation.lastAutoVacuum ?? "not captured"}. Catalog estimates are not a live visibility-map scan or the coverage of pages this query visited.`,
      nextAction: "Verify snapshot alignment, visibility-map coverage and normal vacuum health. Do not assume VACUUM will fix runtime; require a controlled, repeated before/after comparison." });
  }
  return { path: node.path, checks };
}

export function catalogRecommendations(result: Analysis, context: DatabaseContext | null): CatalogRecommendation[] {
  if (!context) return [];
  const paths = new Set([...result.findings.map((finding) => finding.nodePath), ...result.runtimeRanking?.operations.map((operation) => operation.path) ?? []]);
  return result.planMap.filter((node) => node.loops > 0 && node.relation !== "—" && (paths.has(node.path) || /Index Only Scan/i.test(node.nodeType) || (node.estimateRatio ?? 0) >= 10 || indexCandidate(node) != null))
    .slice(0, 20).map((node) => qualifyOperation(node, context));
}
