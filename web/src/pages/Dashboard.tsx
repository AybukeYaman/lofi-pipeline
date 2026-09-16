import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchProjects } from '../api';
import { EmptyState } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import type { LoadState, ProjectSummary } from '../types';

type DashboardProps = {
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
};

export function Dashboard({ onOpenProject, onNewProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');

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

      <div className="summary-row" aria-live="polite">
        <span>{projects.length} Projects</span>
        {loadState === 'loading' ? <span>Loading projects...</span> : null}
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
        <div className="project-list">
          {sortedProjects.map((project) => (
            <button
              className="project-card project-card-button"
              key={project.id}
              type="button"
              onClick={() => onOpenProject(project.id)}
            >
              <div>
                <h2>{project.name}</h2>
                <p>Step: {project.step?.title ?? project.step?.id ?? 'Unknown'}</p>
              </div>
              <time dateTime={new Date(project.mtimeMs).toISOString()}>
                Updated: {formatUpdatedAt(project.mtimeMs)}
              </time>
            </button>
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
