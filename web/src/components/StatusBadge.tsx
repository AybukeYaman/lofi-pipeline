export type AssetStatus =
  | 'missing'
  | 'waiting'
  | 'ready'
  | 'processing'
  | 'completed'
  | 'optional'
  | 'selected'
  | 'failed';

const labels: Record<AssetStatus, string> = {
  missing: 'Missing',
  waiting: 'Waiting',
  ready: 'Ready',
  processing: 'Processing',
  completed: 'Completed',
  optional: 'Optional',
  selected: 'Selected',
  failed: 'Failed',
};

export function StatusBadge({ status, label }: { status: AssetStatus; label?: string }) {
  return <span className={`status-badge status-${status}`}>{label ?? labels[status]}</span>;
}
