import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
};

export function EmptyState({ title, children, action, compact }: EmptyStateProps) {
  return (
    <div className={compact ? 'empty-state compact' : 'state-card empty-state'}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

/** Marks UI that runs on local sample data, not on pipeline state. */
export function SampleDataNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="notice">
      <strong>Preview</strong>
      <span>{children ?? 'Sample data. Not connected to the pipeline yet; nothing is saved.'}</span>
    </p>
  );
}
