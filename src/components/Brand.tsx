export function Brand({ onHome }: { onHome: () => void }) {
  return <button className="brand" onClick={onHome} aria-label="PGPlanWorkbench home"><span className="brand-mark">PG</span><span>PGPlan<b>Workbench</b><small>v1.0.0 · PostgreSQL-native</small></span></button>;
}
