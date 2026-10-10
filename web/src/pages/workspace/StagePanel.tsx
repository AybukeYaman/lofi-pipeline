/** Adım ekranlarının ortak çerçevesi: başlık, "sıradaki adım" rozeti, durum rozeti. */
import type { ReactNode } from 'react';
import { StatusBadge, type AssetStatus } from '../../components/StatusBadge';
import type { ProjectDetail, WorkflowStepId } from '../../types';
import type { ProjectAssets } from './assetState';

/** Adımın canonical akıştaki durumu (backend workflow.steps[].status). */
export type StageStatus = 'done' | 'current' | 'pending';

export type StageProps = {
  project: ProjectDetail;
  assets: ProjectAssets;
  stageStatus: StageStatus;
  onProjectUpdate?: (updatedProject: ProjectDetail) => void;
  onGoToStep?: (step: WorkflowStepId) => void;
};

function sectionAnchor(section: string) {
  return `stage-${section}`;
}

type StagePanelProps = {
  section: string;
  title: string;
  status?: AssetStatus;
  statusLabel?: string;
  stageStatus: StageStatus;
  children: ReactNode;
};

export function StagePanel({ section, title, status, statusLabel, stageStatus, children }: StagePanelProps) {
  return (
    <section
      className={`panel stage-panel${stageStatus === 'current' ? ' is-current' : ''}`}
      id={sectionAnchor(section)}
      aria-labelledby={`${sectionAnchor(section)}-title`}
    >
      <header className="stage-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 id={`${sectionAnchor(section)}-title`}>{title}</h2>
          {stageStatus === 'current' ? (
            <span
              className="stage-current-chip"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 6,
                background: 'var(--primary-subtle)',
                color: 'var(--primary)',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                border: '1px solid var(--border-current)',
              }}
            >
              Sıradaki adım
            </span>
          ) : null}
        </div>
        <div className="stage-meta">
          {status ? <StatusBadge status={status} label={statusLabel} /> : null}
        </div>
      </header>
      {children}
    </section>
  );
}
