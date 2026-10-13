/**
 * Pomodoro görüntü seçimi — Video adımında, YALNIZCA Pomodoro açıkken. Video adımının
 * Ambiance'a ait parçaları (görsel kaynağı, klip yükleme, ana görüntü listesi) Pomodoro'da
 * gösterilmez: ekranda yalnızca bu sekmeler var.
 *
 * Sekme çubuğu  GET READY | STUDY | BREAK | …  — programın adım adlarından gelir; her
 * sekmede küçük resimli seçici, yükleme ve "Boş bırak". Seçim anında kaydedilir. Aynı
 * adlı adımlar tek sekmeyi paylaşır (her sette birlikte güncellenir).
 *
 * Ana görüntüyü (`clip`) sunucu durum görüntülerinden türetir (`prep/project-file.js`
 * `pomodoroMainVisual`: ilk çalışma adımının görüntüsü → ilk görüntülü adım → GET READY).
 * Boş bırakılan durum o görüntüyü kullanır; sistem onu ayrıca boyut, canlı yayın paketi ve
 * küçük resim için kullanır.
 *
 * Yeni durum eklemek/silmek Müzik adımındaki Pomodoro kutusunda yapılır.
 * Tür (resim / döngü videosu) dosya uzantısından anlaşılır.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchProject, getProjectVisualUrl, updateProjectPomodoro, uploadProjectClip, uploadProjectImage } from '../api';
import { errorText } from '../format';
import { IMAGE_ACCEPT, isImageName } from '../imageTypes';
import { UploadButton } from '../pages/workspace/StepWidgets';
import {
  INTRO_TAB,
  bareVisual,
  readinessPayload,
  statusTabs,
  setsPayload,
  visualOfTab,
  withTabVisual,
} from '../pomodoroSetup';
import type { ProjectDetail } from '../types';

type StatusTabsProps = {
  project: ProjectDetail;
  onProjectUpdate?: (project: ProjectDetail) => void;
};

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Küçük resim: resimse <img>, videoysa ilk kare (indirmeden, yalnızca metadata). */
function Thumb({ projectId, name }: { projectId: string; name: string }) {
  const url = getProjectVisualUrl(projectId, name);
  return isImageName(name)
    ? <img src={url} alt="" draggable={false} />
    : <video src={`${url}#t=0.1`} muted playsInline preload="metadata" />;
}

export function StatusTabs({ project, onProjectUpdate }: StatusTabsProps) {
  const [activeKey, setActiveKey] = useState<string>(INTRO_TAB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pomodoro = project.readiness?.pomodoro?.enabled ? project.readiness.pomodoro : null;
  const statuses = pomodoro?.statuses ?? [];
  const intro = pomodoro?.intro ?? { visual: null };
  const tabs = statusTabs(statuses);
  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const candidates = project.visualCandidates ?? [];

  const savedVisual = visualOfTab(active.key, statuses, intro);
  const savedName = savedVisual ? nameOf(savedVisual) : null;
  // Kayıtlı dosya silinmişse uyarılır: sekme boş görünmesin, sessizce yanlış çıkmasın.
  const evidence = project.pomodoroVisuals;
  const index = statuses.findIndex((status) => status.name === active.key);
  const savedExists = active.key === INTRO_TAB
    ? (evidence?.intro.exists ?? true)
    : (evidence?.statuses[index]?.exists ?? true);
  const missing = savedVisual !== null && !savedExists;
  // Boş bırakılan durumların kullandığı görüntü: sunucunun türettiği ana görüntü.
  const fallbackName = project.clip?.exists && project.clip.value ? nameOf(project.clip.value) : null;
  const shownName = savedName && !missing ? savedName : fallbackName;
  const anyVisual = intro.visual !== null || statuses.some((status) => status.visual !== null);

  const save = async (tabKey: string, visual: string | null) => {
    if (!pomodoro) return;
    setBusy(true);
    setError(null);
    try {
      // Aynı adlı adımlar (her sette) aynı görüntüyü paylaşır: hepsi birlikte güncellenir.
      const next = withTabVisual(tabKey, visual, pomodoro.sets ?? [], intro);
      await updateProjectPomodoro(project.id, readinessPayload(pomodoro, {
        sets: setsPayload(next.sets),
        intro: next.intro.visual ? { visual: next.intro.visual } : {},
      }));
      onProjectUpdate?.(await fetchProject(project.id));
    } catch (err: unknown) {
      setError(errorText(err, 'Görüntü kaydedilemedi. Tekrar dene.'));
    } finally {
      setBusy(false);
    }
  };

  // Eski projeler: görüntüler seçilmiş ama ana görüntü hiç yazılmamış (bu kural yokken
  // kurulmuş). Ayarı olduğu gibi bir kez yeniden kaydetmek sunucunun ana görüntüyü
  // türetmesine yeter; kullanıcıdan bir şey istenmez.
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !pomodoro || !anyVisual || project.clip?.value) return;
    synced.current = true;
    void (async () => {
      try {
        await updateProjectPomodoro(project.id, readinessPayload(pomodoro));
        onProjectUpdate?.(await fetchProject(project.id));
      } catch {
        synced.current = false;
      }
    })();
  }, [pomodoro, anyVisual, project.clip?.value, project.id, onProjectUpdate]);

  const handleUpload = async (files: File[]) => {
    const before = new Set(candidates);
    let latest = project;
    for (const file of files) {
      latest = isImageName(file.name)
        ? await uploadProjectImage(project.id, file)
        : await uploadProjectClip(project.id, file);
    }
    onProjectUpdate?.(latest);
    // Yüklenen dosya bu sekmenin görüntüsü olsun: ayrıca seçtirmeyelim.
    const added = (latest.visualCandidates ?? []).find((path) => !before.has(path));
    if (added) await save(active.key, added);
  };

  return (
    <section className="stage-subsection" aria-labelledby="status-tabs-title">
      <h3 id="status-tabs-title">Hangi görüntü ne zaman?</h3>
      <p className="field-hint">
        Her durum için bir resim ya da döngü videosu seç. Boş bıraktığın durum ilk çalışma adımının görüntüsünü kullanır.
      </p>
      {anyVisual ? null : (
        <p className="field-hint field-error" role="status">
          Henüz hiçbir duruma görüntü seçilmedi: montaj için en az bir görüntü gerekli.
        </p>
      )}

      <div className="status-tabbar" role="tablist" aria-label="Durumlar">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`status-tab-${tab.key}`}
            aria-selected={tab.key === active.key}
            className={tab.key === active.key ? 'status-tab is-active' : 'status-tab'}
            onClick={() => { setActiveKey(tab.key); setError(null); }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-labelledby={`status-tab-${active.key}`} className="status-panel">
        <div className="status-panel-preview">
          <span className={savedName && !missing ? 'visual-slot-frame' : 'visual-slot-frame is-dim'}>
            {shownName ? <Thumb projectId={project.id} name={shownName} /> : <span className="muted">Seçilmedi</span>}
          </span>
          <div>
            <strong>{active.label}</strong>
            <p className="muted" style={{ margin: 0 }}>
              {savedName && !missing
                ? savedName
                : fallbackName ? `Boş: ${fallbackName} kullanılır` : 'Boş'}
            </p>
          </div>
        </div>

        {missing ? (
          <p className="field-hint field-error" role="alert">
            Seçili görüntü bulunamadı: {savedName}. Aşağıdan başka bir dosya seç ya da “Boş bırak”ı seç.
          </p>
        ) : null}

        <div className="visual-picker" role="radiogroup" aria-label={`${active.label} görüntüsü`}>
          <button
            type="button"
            role="radio"
            aria-checked={savedVisual === null}
            className={savedVisual === null ? 'visual-tile visual-tile-text selected' : 'visual-tile visual-tile-text'}
            disabled={busy}
            title="Bu durum ilk çalışma adımının görüntüsünü kullanır"
            onClick={() => void save(active.key, null)}
          >
            Boş bırak
          </button>
          {candidates.map((path) => {
            const name = nameOf(path);
            const selected = savedVisual !== null && bareVisual(savedVisual) === path;
            return (
              <button
                key={path}
                type="button"
                role="radio"
                aria-checked={selected}
                title={name}
                className={selected ? 'visual-tile selected' : 'visual-tile'}
                disabled={busy}
                onClick={() => void save(active.key, path)}
              >
                <Thumb projectId={project.id} name={name} />
              </button>
            );
          })}
        </div>
        {candidates.length === 0 ? (
          <p className="field-hint">Henüz dosya yok. Aşağıdan bir resim ya da döngü videosu yükle.</p>
        ) : null}

        <UploadButton
          label={`${active.label} için dosya yükle (resim ya da .mp4)`}
          accept={`.mp4,${IMAGE_ACCEPT}`}
          primary={false}
          disabled={busy}
          onFiles={handleUpload}
        />
      </div>

      <p className="field-hint">
        Durum eklemek, silmek ya da adını değiştirmek için Müzik adımındaki Pomodoro kutusunu kullan.
      </p>
      {error ? <p className="field-hint field-error" role="alert">{error}</p> : null}
    </section>
  );
}
