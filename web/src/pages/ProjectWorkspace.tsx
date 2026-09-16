import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchProject, ProjectNotFoundError } from '../api';
import { EmptyState } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import type { LoadState, ProjectDetail } from '../types';
import { getWorkflowStatus, workflowSteps } from '../workflow';
import { deriveAssets, styleName } from './workspace/assetState';
import {
  BuildStage,
  MasterStage,
  MusicStage,
  OutputStage,
  sectionAnchor,
  StyleStage,
  VideoStage,
} from './workspace/StageSections';

const stageComponents = {
  style: StyleStage,
  master: MasterStage,
  video: VideoStage,
  music: MusicStage,
  build: BuildStage,
  completed: OutputStage,
} as const;

export function ProjectWorkspace({ id, onBack }: { id: string; onBack: () => void }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState('Could not load project.');

  useEffect(() => {
    let isActive = true;
    setLoadState('loading');
    setProject(null);
    setErrorMessage('Could not load project.');

    fetchProject(id)
      .then((nextProject) => {
        if (!isActive) return;
        setProject(nextProject);
        setLoadState('loaded');
      })
      .catch((error: unknown) => {
        if (!isActive) return;
        setErrorMessage(
          error instanceof ProjectNotFoundError ? 'Project not found.' : 'Could not load project.',
        );
        setLoadState('error');
      });

    return () => {
      isActive = false;
    };
  }, [id]);

  return (
    <section className="page workspace">
      <button className="back-button" type="button" onClick={onBack}>
        ← Back to Projects
      </button>

      {loadState === 'loading' ? <div className="state-card">Loading project...</div> : null}

      {loadState === 'error' ? (
        <div role="alert">
          <EmptyState
            title={errorMessage}
            action={
              <button className="button" type="button" onClick={onBack}>
                Back to Projects
              </button>
            }
          />
        </div>
      ) : null}

      {project ? (
        <WorkspaceContent project={project} onProjectUpdate={(updated) => setProject(updated)} />
      ) : null}
    </section>
  );
}

function WorkspaceContent({
  project,
  onProjectUpdate,
}: {
  project: ProjectDetail;
  onProjectUpdate: (project: ProjectDetail) => void;
}) {
  const currentStepId = project.step?.id;
  const assets = useMemo(() => deriveAssets(project), [project]);

  return (
    <>
      <PageHeader
        eyebrow="PROJECT WORKSPACE"
        title={project.name}
        actions={
          <div className="current-step">
            <span>Current step</span>
            <strong>{project.step?.title ?? project.step?.id ?? 'Unknown'}</strong>
          </div>
        }
      />

      {project.step?.detail ? <p className="step-detail">{project.step.detail}</p> : null}

      <section className="workspace-grid">
        <div className="panel">
          <h2>Workflow</h2>
          <div className="stepper">
            {workflowSteps.map((step, index) => {
              const status = getWorkflowStatus(step.section, currentStepId, project.readiness);
              return (
                <button
                  className={`workflow-step ${status}`}
                  key={step.id}
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(sectionAnchor(step.section))
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  <span>{index + 1}</span>
                  <strong>{step.label}</strong>
                  <em>{status}</em>
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2>Project Assets</h2>
          <dl className="asset-list">
            <AssetRow label="Style" value={styleName(project)} />
            <AssetRow label="References" value={<StatusBadge status={assets.references} label={`${project.references?.length ?? 0}`} />} />
            <AssetRow label="Master Frame" value={<StatusBadge status={assets.master} />} />
            <AssetRow label="Video Clip" value={<StatusBadge status={assets.clip} />} />
            <AssetRow label="Music" value={<StatusBadge status={assets.music} />} />
            <AssetRow label="Ambient" value={<StatusBadge status={assets.ambient} />} />
            <AssetRow label="Output" value={<StatusBadge status={assets.output} />} />
          </dl>
        </div>
      </section>

      {workflowSteps.map((step) => {
        const Stage = stageComponents[step.section];
        return (
          <Stage
            key={step.section}
            project={project}
            assets={assets}
            stageStatus={getWorkflowStatus(step.section, currentStepId, project.readiness)}
            onProjectUpdate={onProjectUpdate}
          />
        );
      })}

      <details className="panel evidence-panel">
        <summary>Filesystem Evidence</summary>
        <dl className="evidence-list">
          <AssetRow label="Project folder" value={project.dir} />
          <AssetRow label="Prompts" value={project.promptsPath} />
          <AssetRow label="Master frame" value={project.master} />
          <AssetRow label="Video clip" value={project.clip?.path ?? project.clip?.value} />
          <AssetRow
            label="Video crop"
            value={
              project.projectJson?.data?.video?.cropBottom !== undefined
                ? `${project.projectJson.data.video.cropBottom}px`
                : undefined
            }
          />
          <AssetRow label="Audio directory" value={project.audioDir} />
          <AssetRow label="Output file" value={project.output?.path} />
        </dl>
      </details>
    </>
  );
}

function AssetRow({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === undefined || value === null || value === '' ? 'Unknown' : value}</dd>
    </div>
  );
}
