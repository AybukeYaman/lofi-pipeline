import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteProject, fetchProjects } from '../api';
import { EmptyState } from '../components/Feedback';
import { LayoutSwitcher, useCardLayout } from '../components/LayoutSwitcher';
import { PageHeader } from '../components/PageHeader';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectSummary } from '../types';

type DashboardProps = {
  onOpenProject: (id: string) => void;
  onNewProject: (parentId?: string) => void;
};

export function Dashboard({ onOpenProject, onNewProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [layoutCols, setLayoutCols] = useCardLayout('lofi-layout-projects', 1);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Her ana proje için o an hangi sekmenin seçili olduğu: { [mainProjectId]: activeProjectId }
  const [activeTabMap, setActiveTabMap] = useState<Record<string, string>>({});

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
    const isSub = Boolean(project.parentId);
    if (!window.confirm(
      `"${project.name}" ${isSub ? 'alt projesi' : 'projesi'} silinsin mi?\n\nKlasörün tamamı (resimler, müzik, çıktı videosu) Geri Dönüşüm Kutusu'na taşınır.`,
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

  // Alt projeleri parentId'ye göre eşle
  const { mainProjects, subprojectsByParent, totalSubCount } = useMemo(() => {
    const subMap = new Map<string, ProjectSummary[]>();
    const allIds = new Set(projects.map((p) => p.id));
    let subCount = 0;

    for (const p of projects) {
      if (p.parentId && allIds.has(p.parentId)) {
        subCount++;
        const list = subMap.get(p.parentId) || [];
        list.push(p);
        subMap.set(p.parentId, list);
      }
    }

    // Ana projeler: parentId'si olmayanlar veya parentId'si artık mevcut olmayanlar
    const mains = projects
      .filter((p) => !p.parentId || !allIds.has(p.parentId))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return { mainProjects: mains, subprojectsByParent: subMap, totalSubCount: subCount };
  }, [projects]);

  const handleSelectTab = (mainId: string, targetId: string) => {
    setActiveTabMap((prev) => ({ ...prev, [mainId]: targetId }));
  };

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
            <button className="button button-primary" type="button" onClick={() => onNewProject()}>
              New Project
            </button>
          </>
        }
      />

      <div className="summary-row" aria-live="polite" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <strong>{mainProjects.length}</strong> Ana Proje
          {totalSubCount > 0 ? (
            <span className="muted" style={{ marginLeft: 6 }}>
              (toplam {totalSubCount} alt proje)
            </span>
          ) : null}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {loadState === 'loading' ? <span>Loading projects...</span> : null}
          {mainProjects.length > 0 ? (
            <LayoutSwitcher value={layoutCols} onChange={setLayoutCols} storageKey="lofi-layout-projects" />
          ) : null}
        </div>
      </div>

      {loadState === 'error' ? (
        <div className="state-card" role="alert">
          Projects could not be loaded.
        </div>
      ) : null}

      {loadState === 'loaded' && mainProjects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          action={
            <button className="button button-primary" type="button" onClick={() => onNewProject()}>
              New Project
            </button>
          }
        />
      ) : null}

      {mainProjects.length > 0 ? (
        <div className={`card-grid-layout cols-${layoutCols}`}>
          {mainProjects.map((mainProject) => {
            const subprojects = subprojectsByParent.get(mainProject.id) || [];
            const activeId = activeTabMap[mainProject.id] || mainProject.id;
            // Aktif olan proje ana proje mi yoksa alt projelerden biri mi?
            const currentProject =
              activeId === mainProject.id
                ? mainProject
                : subprojects.find((s) => s.id === activeId) || mainProject;
            const isViewingSub = currentProject.id !== mainProject.id;

            const stepLabel = currentProject.workflow
              ? `${currentProject.workflow.steps.find((step) => step.id === currentProject.workflow?.current)?.number ?? '?'}/${currentProject.workflow.steps.length} · ${currentProject.workflow.currentTitle}`
              : currentProject.step?.title ?? currentProject.step?.id ?? 'Unknown';

            return (
              <div className="project-card" key={mainProject.id}>
                {/* Alt proje sekmeleri. Tek satırda kalır (sarmaz): sarınca
                    yan yana duran kartların başlık yüksekliği birbirini
                    tutmuyor ve ızgara kayık görünüyordu. Taşarsa yatay kayar. */}
                <div className="project-tabs" role="tablist" aria-label={`${mainProject.name} projeleri`}>
                  <button
                    type="button"
                    role="tab"
                    className="project-tab"
                    aria-selected={activeId === mainProject.id}
                    title={mainProject.name}
                    onClick={() => handleSelectTab(mainProject.id, mainProject.id)}
                  >
                    {mainProject.thumbnailUrl ? (
                      <img className="project-tab-thumb" src={mainProject.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="project-tab-thumb is-empty" aria-hidden="true">🏠</span>
                    )}
                    <span className="project-tab-name">{mainProject.name}</span>
                    {subprojects.length > 0 ? (
                      <span className="project-tab-count">{subprojects.length}</span>
                    ) : null}
                  </button>

                  {subprojects.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      role="tab"
                      className="project-tab"
                      aria-selected={activeId === sub.id}
                      title={sub.name}
                      onClick={() => handleSelectTab(mainProject.id, sub.id)}
                    >
                      {sub.thumbnailUrl ? (
                        <img className="project-tab-thumb" src={sub.thumbnailUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="project-tab-thumb is-empty" aria-hidden="true">📄</span>
                      )}
                      <span className="project-tab-name">{sub.name}</span>
                    </button>
                  ))}
                </div>

                {/* Seçili projenin gövdesi */}
                <button
                  className="project-card-open"
                  type="button"
                  onClick={() => onOpenProject(currentProject.id)}
                  disabled={deletingId === currentProject.id}
                >
                  <div className="project-card-main">
                    {currentProject.thumbnailUrl ? (
                      <img className="project-thumb" src={currentProject.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="project-thumb" aria-hidden="true" />
                    )}
                    <div className="project-card-text">
                      <div className="project-card-title">
                        <h2>{currentProject.name}</h2>
                        {isViewingSub ? <span className="project-badge">Alt Proje</span> : null}
                      </div>
                      <p>Adım: {stepLabel}</p>
                      <time dateTime={new Date(currentProject.mtimeMs).toISOString()}>
                        Updated: {formatUpdatedAt(currentProject.mtimeMs)}
                      </time>
                    </div>
                  </div>
                </button>

                {/* Kart altı işlemler — her kartta aynı yerde dursun diye
                    gövde ne kadar uzun olursa olsun en alta sabitlenir. */}
                <div className="project-card-actions">
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => onOpenProject(currentProject.id)}
                  >
                    Aç →
                  </button>
                  <button
                    className="button"
                    type="button"
                    title={`"${mainProject.name}" için yeni alt proje oluştur`}
                    onClick={() => onNewProject(mainProject.id)}
                  >
                    + Alt Proje
                  </button>
                  <button
                    className="button project-delete"
                    type="button"
                    onClick={() => handleDelete(currentProject)}
                    disabled={deletingId !== null}
                    aria-label={`Delete project ${currentProject.name}`}
                    title="Geri Dönüşüm Kutusu'na taşı"
                  >
                    {deletingId === currentProject.id ? 'Siliniyor…' : 'Sil'}
                  </button>
                </div>
              </div>
            );
          })}
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
