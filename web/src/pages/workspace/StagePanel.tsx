/** Adım ekranlarının ortak çerçevesi: başlık, "sıradaki adım" rozeti, durum rozeti. */
import type { ReactNode } from 'react';
import { StatusBadge, type AssetStatus } from '../../components/StatusBadge';
import type { ProjectDetail } from '../../types';
import type { ViewStepId } from '../../workflow';
import type { ProjectAssets } from './assetState';

/** Adımın canonical akıştaki durumu (backend workflow.steps[].status). */
export type StageStatus = 'done' | 'current' | 'pending';

export type StageProps = {
  project: ProjectDetail;
  assets: ProjectAssets;
  stageStatus: StageStatus;
  onProjectUpdate?: (updatedProject: ProjectDetail) => void;
  onGoToStep?: (step: ViewStepId) => void;
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
        <div className="stage-title-row">
          <h2 id={`${sectionAnchor(section)}-title`}>{title}</h2>
          {stageStatus === 'current' ? <span className="stage-current-chip">Sıradaki adım</span> : null}
        </div>
        <div className="stage-meta">
          {status ? <StatusBadge status={status} label={statusLabel} /> : null}
        </div>
      </header>
      {children}
    </section>
  );
}
