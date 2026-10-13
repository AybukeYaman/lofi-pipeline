import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteProject, fetchProjects } from '../api';
import { EmptyState } from '../components/Feedback';
import { formatDateTime } from '../format';
import { LayoutSwitcher, useCardLayout } from '../components/LayoutSwitcher';
import { PageHeader } from '../components/PageHeader';
import { ProjectTabs } from '../components/ProjectTabs';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectSummary } from '../types';
import { useCreateShorts } from '../useCreateShorts';
import { viewWorkflow } from '../workflow';

type DashboardProps = {
  onOpenProject: (id: string) => void;
  onNewProject: (parentId?: string) => void;
};

export function Dashboard({ onOpenProject, onNewProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [layoutCols, setLayoutCols] = useCardLayout('lofi-layout-projects', 1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Shorts alt projesi açılırken o ana projenin düğmesi kilitlenir. */
  const { busyId: shortsBusyId, createShorts } = useCreateShorts(onOpenProject);

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
        title="Projeler"
        actions={
          <>
            <button
              className="button"
              type="button"
              onClick={loadProjects}
              disabled={loadState === 'loading'}
            >
              Yenile
            </button>
            <button className="button button-primary" type="button" onClick={() => onNewProject()}>
              Yeni Proje
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
          {loadState === 'loading' ? <span>Projeler yükleniyor...</span> : null}
          {mainProjects.length > 0 ? (
            <LayoutSwitcher value={layoutCols} onChange={setLayoutCols} />
          ) : null}
        </div>
      </div>

      {loadState === 'error' ? (
        <div className="state-card" role="alert">
          Projeler yüklenemedi. Sunucunun çalıştığını kontrol edip tekrar dene.
        </div>
      ) : null}

      {loadState === 'loaded' && mainProjects.length === 0 ? (
        <EmptyState
          title="Henüz proje yok."
          action={
            <button className="button button-primary" type="button" onClick={() => onNewProject()}>
              Yeni Proje
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

            // Çalışma alanıyla aynı 5 adımlı görünüm (müzik + sıralama birleşik).
            const flow = viewWorkflow(currentProject.workflow);
            const stepLabel = flow
              ? `${flow.steps.find((step) => step.id === flow.current)?.number ?? '?'}/${flow.steps.length} · ${flow.currentTitle}`
              : currentProject.step?.title ?? currentProject.step?.id ?? 'Bilinmiyor';

            return (
              <div className="project-card" key={mainProject.id}>
                {/* Alt proje sekmeleri yalnızca alt proje varsa: tek başına duran projede
                    sekme, aşağıdaki başlığın aynı adını ve küçük resmini ikinci kez gösteriyordu.
                    Tek satırda kalır (sarmaz): sarınca yan yana duran kartların başlık
                    yüksekliği birbirini tutmuyor ve ızgara kayık görünüyordu. Taşarsa yatay kayar. */}
                {subprojects.length > 0 ? (
                  <ProjectTabs
                    main={mainProject}
                    subprojects={subprojects}
                    activeId={activeId}
                    onSelect={(targetId) => handleSelectTab(mainProject.id, targetId)}
                    showCount
                  />
                ) : null}

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
                        {isViewingSub ? (
                          <span className="project-badge">
                            {currentProject.kind === 'shorts' ? 'Shorts (9:16)' : 'Alt Proje'}
                          </span>
                        ) : null}
                      </div>
                      {/* Adım ilerlemesi: 5 parçalı çubuk (dolu = tamam, vurgulu = sırada) + kısa yazı. */}
                      {flow ? (
                        <ol className="mini-steps" aria-label={`Adım ${stepLabel}`} title={`Adım ${stepLabel}`}>
                          {flow.steps.map((step) => (
                            <li key={step.id} className={`mini-step is-${step.status}`} title={step.title} />
                          ))}
                        </ol>
                      ) : null}
                      <p className="project-card-step">{stepLabel}</p>
                      <time dateTime={new Date(currentProject.mtimeMs).toISOString()}>
                        Güncellendi: {formatDateTime(currentProject.mtimeMs)}
                      </time>
                    </div>
                  </div>
                </button>

                {/* Kart altı işlemler — her kartta aynı yerde dursun diye
                    gövde ne kadar uzun olursa olsun en alta sabitlenir. */}
                {/* "Aç" düğmesi YOK: kartın gövdesi zaten projeyi açıyor, iki
                    ayrı tetik aynı işi yapıyordu. */}
                <div className="project-card-actions">
                  <button
                    className="button"
                    type="button"
                    title={`"${mainProject.name}" için yeni alt proje oluştur`}
                    onClick={() => onNewProject(mainProject.id)}
                  >
                    + Alt Proje
                  </button>
                  {/* Shorts SEÇİLİ sekmenin projesinden açılır: kullanıcı bir alt
                      projeye bakarken düğme sessizce ana projeyi kaynak alıyordu.
                      Shorts'tan Shorts açılamaz (sunucu da 400 veriyor). */}
                  {currentProject.kind !== 'shorts' ? (
                    <button
                      className="button"
                      type="button"
                      disabled={shortsBusyId !== null}
                      title={`"${currentProject.name}" videosundan 9:16 Shorts kesitleri al`}
                      onClick={() => void createShorts(currentProject.id)}
                    >
                      {shortsBusyId === currentProject.id ? 'Açılıyor...' : '🎬 + Shorts'}
                    </button>
                  ) : null}
                  <button
                    className="button project-delete"
                    type="button"
                    onClick={() => handleDelete(currentProject)}
                    disabled={deletingId !== null}
                    aria-label={`${currentProject.name} projesini sil`}
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
