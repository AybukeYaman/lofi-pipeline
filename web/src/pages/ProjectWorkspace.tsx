import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';

import { fetchProject, fetchProjects, ProjectNotFoundError } from '../api';
import { EmptyState } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ProjectTabs } from '../components/ProjectTabs';
import { StatusBadge } from '../components/StatusBadge';
import type { LoadState, ProjectDetail, ProjectSummary, WorkflowStepId } from '../types';
import { isStepReachable, nextStepId, previousStep, stepInfo } from '../workflow';
import { ShortsWorkspace } from './ShortsWorkspace';
import { deriveAssets } from './workspace/assetState';
import { OrderStage, ProjectStartStage } from './workspace/CanonicalStages';
import {
  BuildStage,
  MusicStage,
  OutputStage,
  VideoStage,
  type StageProps,
} from './workspace/StageSections';
import { errorText } from '../format';
import { StepGuide } from './workspace/StepWidgets';
import { useCreateShorts } from '../useCreateShorts';

/** Canonical 6 adımın ekranları — sıra workflow.ts STEP_ORDER'dır. */
const stageComponents: Record<WorkflowStepId, ComponentType<StageProps>> = {
  project: ProjectStartStage,
  video: VideoStage,
  music: MusicStage,
  order: OrderStage,
  build: BuildStage,
  publish: OutputStage,
};

export function ProjectWorkspace({
  id,
  onBack,
  onOpenProject,
  onNewProject,
}: {
  id: string;
  onBack: () => void;
  onOpenProject?: (id: string) => void;
  onNewProject?: (parentId?: string) => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState('Could not load project.');
  const [allProjects, setAllProjects] = useState<ProjectSummary[]>([]);
  const { busyId: shortsBusyId, createShorts } = useCreateShorts(onOpenProject);

  useEffect(() => {
    fetchProjects().then(setAllProjects).catch(() => {});
  }, []);

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

  // Projenin ait olduğu ana proje ve alt projeler grubu
  const rootParentId = project?.parentId || project?.id;
  const siblingSubprojects = useMemo(() => {
    if (!rootParentId) return [];
    return allProjects.filter((p) => p.parentId === rootParentId);
  }, [allProjects, rootParentId]);

  const hasSubprojectGroup = Boolean(project?.parentId || siblingSubprojects.length > 0);

  // Ana proje listede yoksa (henüz yüklenmediyse) kimliğiyle gösterilir.
  const mainTabProject = useMemo(
    () => allProjects.find((p) => p.id === rootParentId)
      ?? { id: rootParentId ?? '', name: rootParentId ?? '' },
    [allProjects, rootParentId],
  );

  return (
    <section className="page workspace">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <button className="back-button" type="button" onClick={onBack} style={{ margin: 0 }}>
          ← Back to Projects
        </button>

        {/* Ana proje + alt projeler şeridi — Projects sayfasındaki kartla
            aynı bileşen. Burada seçim o projeye gider. Tek proje varsa şerit
            yerine sade bir "alt proje aç" düğmesi durur. */}
        {hasSubprojectGroup && rootParentId ? (
          <ProjectTabs
            main={mainTabProject}
            subprojects={siblingSubprojects}
            activeId={project?.id ?? rootParentId}
            onSelect={(targetId) => onOpenProject?.(targetId)}
            mainLabel={`${rootParentId} (Ana)`}
            onAddSubproject={() => onNewProject?.(rootParentId)}
            ariaLabel="Proje sekmeleri"
          />
        ) : (
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => onNewProject?.(project?.id)}
          >
            ➕ Bu Projeye Alt Proje Aç
          </button>
        )}

        {/* Shorts alt projesi: bu projenin videosundan 9:16 kesitler almak için. */}
        {project && project.kind !== 'shorts' ? (
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled={shortsBusyId !== null}
            title="Bu projenin videosundan 9:16 Shorts kesitleri al"
            onClick={() => void createShorts(project.id)}
          >
            {shortsBusyId === project.id ? 'Açılıyor...' : '🎬 Shorts Alt Projesi'}
          </button>
        ) : null}
      </div>

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
        project.kind === 'shorts' ? (
          // Shorts alt projesinin akışı ayrı: montaj sihirbazı (6 adım)
          // yerine timeline + kadraj + kesit listesi.
          <ShortsWorkspace id={project.id} onBack={onBack} />
        ) : (
          <WorkspaceContent project={project} onProjectUpdate={(updated) => setProject(updated)} />
        )
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
  const workflow = project.workflow;
  // Shorts projeleri bu bileşene hiç girmiyor (ayrı ekran); `current` bu
  // yüzden her zaman canonical akışın bir adımı.
  const current = (workflow?.current ?? 'project') as WorkflowStepId;
  const assets = useMemo(() => deriveAssets(project), [project]);

  // Açılışta diskten hesaplanan ilk açık adım gösterilir. Bir işlem ilk açık
  // adımı değiştirirse (adım tamamlandı / yeniden açıldı) oraya geçilir;
  // kullanıcı geri döndüyse ve ilk açık adım aynı kaldıysa bulunduğu yerde kalır.
  const [activeStep, setActiveStep] = useState<WorkflowStepId>(current);
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (lastCurrent.current !== current) {
      lastCurrent.current = current;
      setActiveStep(current);
    }
  }, [current]);

  const goTo = useCallback(
    (step: WorkflowStepId) => {
      if (!isStepReachable(workflow, step)) return;
      setActiveStep(step);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [workflow],
  );

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      onProjectUpdate(await fetchProject(project.id));
    } catch (error: unknown) {
      setRefreshError(errorText(error, 'Proje durumu okunamadı.'));
    } finally {
      setIsRefreshing(false);
    }
  };

  const active = stepInfo(workflow, activeStep);
  const Stage = stageComponents[activeStep];
  const previous = previousStep(activeStep);
  const next = nextStepId(activeStep);
  const canGoNext = next !== null && active?.status === 'done' && isStepReachable(workflow, next);

  return (
    <>
      <PageHeader
        eyebrow={project.parentId ? `ALT PROJE (ANA: ${project.parentId})` : 'PROJECT WORKSPACE'}
        title={project.name}
        actions={
          <div className="current-step">
            <span>Kaldığın adım</span>
            <strong>
              {stepInfo(workflow, current)?.number}. {workflow?.currentTitle ?? 'Bilinmiyor'}
            </strong>
          </div>
        }
      />

      {!project.projectJson?.ok && project.projectJson?.error ? (
        <p className="field-hint field-error" role="alert">
          project.json okunamadı: {project.projectJson.error}
        </p>
      ) : null}

      <nav className="panel wizard-steps" aria-label="İş akışı">
        <ol className="stepper stepper-horizontal">
          {(workflow?.steps ?? []).map((rawStep) => {
            // Bu sihirbaz yalnızca canonical akış için çalışıyor (Shorts
            // projeleri ayrı ekranda), adım kimliği bu yüzden daraltılabilir.
            const step = rawStep as typeof rawStep & { id: WorkflowStepId };
            const reachable = isStepReachable(workflow, step.id);
            const classes = [
              'workflow-step',
              step.status === 'done' ? 'completed' : step.status,
              step.id === activeStep ? 'active' : '',
            ].join(' ');
            return (
              <li key={step.id}>
                <button
                  className={classes}
                  type="button"
                  disabled={!reachable}
                  aria-current={step.id === activeStep ? 'step' : undefined}
                  onClick={() => goTo(step.id)}
                >
                  <span>{step.status === 'done' ? '✓' : step.number}</span>
                  <strong>
                    {step.title}
                    {step.optional ? ' (opsiyonel)' : ''}
                  </strong>
                  <em>{step.skipped ? 'atlandı' : step.status === 'done' ? 'tamam' : step.status === 'current' ? 'sırada' : 'bekliyor'}</em>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <StepGuide stepId={activeStep} />

      <Stage
        key={activeStep}
        project={project}
        assets={assets}
        stageStatus={active?.status ?? 'pending'}
        onProjectUpdate={onProjectUpdate}
        onGoToStep={goTo}
      />

      <div className="wizard-nav">
        <button className="button" type="button" disabled={!previous} onClick={() => previous && goTo(previous)}>
          ← Geri dön
        </button>
        <button className="button" type="button" disabled={isRefreshing} onClick={refresh}>
          {isRefreshing ? 'Kontrol ediliyor...' : '🔄 Klasörü yeniden kontrol et'}
        </button>
        {activeStep !== current && active?.status === 'done' ? (
          <button className="button" type="button" onClick={() => goTo(current)}>
            Kaldığım adıma dön ({workflow?.currentTitle})
          </button>
        ) : null}
        <button className="button button-primary" type="button" disabled={!canGoNext} onClick={() => next && goTo(next)}>
          İleri →
        </button>
      </div>
      {refreshError ? (
        <p className="field-hint field-error" role="alert">
          {refreshError}
        </p>
      ) : null}
      {!canGoNext && next && active?.status !== 'done' ? (
        <p className="field-hint">Bu adım tamamlanınca sonraki adıma otomatik geçilir.</p>
      ) : null}

      <details className="panel evidence-panel">
        <summary>Project Assets & Filesystem Evidence</summary>
        <dl className="asset-list">
          {project.parentId ? <AssetRow label="Parent Project" value={project.parentId} /> : null}
          <AssetRow label="Video Clip" value={<StatusBadge status={assets.clip} />} />
          <AssetRow label="Music" value={<StatusBadge status={assets.music} />} />
          <AssetRow label="Ambient" value={<StatusBadge status={assets.ambient} />} />
          <AssetRow label="Output" value={<StatusBadge status={assets.output} />} />
        </dl>
        <dl className="evidence-list">
          <AssetRow label="Project folder" value={project.dir} />
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
          <AssetRow label="Track order" value={project.projectJson?.data?.order?.join(' → ')} />
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
