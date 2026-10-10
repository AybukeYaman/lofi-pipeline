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
  missing: 'Yok',
  waiting: 'Bekliyor',
  ready: 'Hazır',
  processing: 'İşleniyor',
  completed: 'Tamam',
  optional: 'Opsiyonel',
  selected: 'Seçili',
  failed: 'Başarısız',
};

export function StatusBadge({ status, label }: { status: AssetStatus; label?: string }) {
  return <span className={`status-badge status-${status}`}>{label ?? labels[status]}</span>;
}
