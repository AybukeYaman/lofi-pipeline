import type { ProjectSummary } from '../types';

/**
 * Ana proje + alt projeleri arasında geçiş şeridi.
 *
 * Aynı kullanım hem Projects sayfasındaki kartta hem de proje çalışma
 * ekranının üstünde var. İkisi ayrı ayrı yazılmıştı (biri CSS sınıfları,
 * diğeri satır içi stillerle) ve görünümleri birbirinden kaymıştı; tek
 * bileşen ikisini de karşılıyor. Fark yalnızca seçimin ne yaptığı:
 * kartta yerel sekme değişimi, çalışma ekranında o projeye gitmek.
 */
export type TabProject = {
  id: string;
  name: string;
  thumbnailUrl?: string | null;
  kind?: ProjectSummary['kind'];
};

type ProjectTabsProps = {
  main: TabProject;
  subprojects: TabProject[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Ana sekmenin yazısı — çalışma ekranı "(Ana)" ekler. */
  mainLabel?: string;
  /** Kartta ana sekme alt proje sayısını rozet olarak gösterir. */
  showCount?: boolean;
  /** Verilirse şeridin sonuna "alt proje ekle" düğmesi gelir. */
  onAddSubproject?: () => void;
  ariaLabel?: string;
};

export function ProjectTabs({
  main,
  subprojects,
  activeId,
  onSelect,
  mainLabel,
  showCount = false,
  onAddSubproject,
  ariaLabel,
}: ProjectTabsProps) {
  return (
    <div className="project-tabs" role="tablist" aria-label={ariaLabel ?? `${main.name} projeleri`}>
      <ProjectTab
        project={main}
        label={mainLabel ?? main.name}
        isMain
        selected={activeId === main.id}
        count={showCount && subprojects.length > 0 ? subprojects.length : undefined}
        onSelect={onSelect}
      />
      {subprojects.map((sub) => (
        <ProjectTab
          key={sub.id}
          project={sub}
          label={sub.name}
          selected={activeId === sub.id}
          onSelect={onSelect}
        />
      ))}
      {onAddSubproject ? (
        <button
          type="button"
          className="project-tab project-tab-add"
          title="Bu ana projeye yeni bir alt proje ekle"
          onClick={onAddSubproject}
        >
          ＋ Alt Proje
        </button>
      ) : null}
    </div>
  );
}

function ProjectTab({
  project,
  label,
  selected,
  count,
  isMain = false,
  onSelect,
}: {
  project: TabProject;
  label: string;
  selected: boolean;
  count?: number;
  isMain?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      className="project-tab"
      aria-selected={selected}
      title={project.name}
      onClick={() => onSelect(project.id)}
    >
      {project.thumbnailUrl ? (
        <img className="project-tab-thumb" src={project.thumbnailUrl} alt="" loading="lazy" />
      ) : (
        <span className="project-tab-thumb is-empty" aria-hidden="true">
          {isMain ? '🏠' : project.kind === 'shorts' ? '🎬' : '📄'}
        </span>
      )}
      <span className="project-tab-name">{label}</span>
      {count !== undefined ? <span className="project-tab-count">{count}</span> : null}
    </button>
  );
}
