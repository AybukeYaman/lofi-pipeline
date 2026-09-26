import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteProject, fetchProjects } from '../api';
import { EmptyState } from '../components/Feedback';
import { LayoutSwitcher, useCardLayout } from '../components/LayoutSwitcher';
import { PageHeader } from '../components/PageHeader';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectSummary } from '../types';

type DashboardProps = {
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
};

export function Dashboard({ onOpenProject, onNewProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [layoutCols, setLayoutCols] = useCardLayout('lofi-layout-projects', 1);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoadState('loading');
    try {
      const nextProjects = await fetchProjects();
      setProjects(nextProjects);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleDelete = async (project: ProjectSummary) => {
    if (!window.confirm(
      `"${project.name}" projesi silinsin mi?\n\nKlasörün tamamı (resimler, müzik, çıktı videosu) Geri Dönüşüm Kutusu'na taşınır.`,
    )) {
      return;
    }
    setDeletingId(project.id);
    try {
      await deleteProject(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      showSuccess(`"${project.name}" Geri Dönüşüm Kutusu'na taşındı.`, 'Proje silindi');
    } catch (err: unknown) {
      showError(err, 'Proje silinemedi.');
    } finally {
      setDeletingId(null);
    }
  };

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.mtimeMs - a.mtimeMs),
    [projects],
  );

  return (
    <section className="page">
      <PageHeader
        eyebrow="LOFI PIPELINE"
        title="Projects"
        actions={
          <>
            <button
              className="button"
              type="button"
              onClick={loadProjects}
              disabled={loadState === 'loading'}
            >
              Refresh
            </button>
            <button className="button button-primary" type="button" onClick={onNewProject}>
              New Project
            </button>
          </>
        }
      />

      <div className="summary-row" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{projects.length} Projects</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {loadState === 'loading' ? <span>Loading projects...</span> : null}
          {projects.length > 0 ? (
            <LayoutSwitcher value={layoutCols} onChange={setLayoutCols} storageKey="lofi-layout-projects" />
          ) : null}
        </div>
      </div>

      {loadState === 'error' ? (
        <div className="state-card" role="alert">
          Projects could not be loaded.
        </div>
      ) : null}

      {loadState === 'loaded' && projects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          action={
            <button className="button button-primary" type="button" onClick={onNewProject}>
              New Project
            </button>
          }
        />
      ) : null}

      {projects.length > 0 ? (
        <div className={`card-grid-layout cols-${layoutCols}`}>
          {sortedProjects.map((project) => (
            <div className="project-card" key={project.id}>
              <button
                className="project-card-open"
                type="button"
                onClick={() => onOpenProject(project.id)}
                disabled={deletingId === project.id}
              >
                <div className="project-card-main">
                  {project.thumbnailUrl ? (
                    <img className="project-thumb" src={project.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="project-thumb" aria-hidden="true" />
                  )}
                  <div className="project-card-text">
                    <h2>{project.name}</h2>
                    <p>
                      Adım:{' '}
                      {project.workflow
                        ? `${project.workflow.steps.find((step) => step.id === project.workflow?.current)?.number ?? '?'}/10 · ${project.workflow.currentTitle}`
                        : project.step?.title ?? project.step?.id ?? 'Unknown'}
                    </p>
                  </div>
                </div>
                <time dateTime={new Date(project.mtimeMs).toISOString()}>
                  Updated: {formatUpdatedAt(project.mtimeMs)}
                </time>
              </button>
              <button
                className="button project-delete"
                type="button"
                onClick={() => handleDelete(project)}
                disabled={deletingId !== null}
                aria-label={`Delete project ${project.name}`}
                title="Geri Dönüşüm Kutusu'na taşı"
              >
                {deletingId === project.id ? 'Siliniyor…' : 'Sil'}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function formatUpdatedAt(mtimeMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(mtimeMs));
}
