/**
 * Pomodoro görüntü seçimi — Video adımında, YALNIZCA Pomodoro açıkken.
 *
 * İki parça:
 *   1. Ana görüntü: "başka görüntü seçmediğin her yerde" görünen resim/döngü videosu
 *      (Video adımının mevcut seçimi; Kaydet düğmesiyle yazılır). Başlığı Video adımındaki
 *      "Ana görüntü (n)" satırıdır; burada yalnızca küçük resimleri durur.
 *   2. Sekme çubuğu  GET READY | STUDY | BREAK | …  — durum listesinden gelir, her
 *      sekmede o durumun küçük resimli görüntü seçicisi ve "Ana görüntüyle aynı"
 *      seçeneği. Seçim anında kaydedilir. Aynı adlı durumlar tek sekmeyi paylaşır.
 *
 * Yeni durum eklemek/silmek Müzik adımındaki Pomodoro kutusunda yapılır (liste orada
 * düzenleniyor); sekmeler listeyle birlikte kendiliğinden değişir.
 * Tür (resim / döngü videosu) dosya uzantısından anlaşılır.
 */

import { useState } from 'react';

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
  /** Ana görüntü olarak SEÇİLİ dosya (VideoStage'in seçimi; henüz kaydedilmemiş olabilir). */
  workPath: string | null;
  /** Ana görüntü için seçilebilir dosyalar (VideoStage'in mevcut kaynak listesi). */
  workCandidates: string[];
  onPickWork: (path: string) => void;
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

export function StatusTabs({
  project, workPath, workCandidates, onPickWork, onProjectUpdate,
}: StatusTabsProps) {
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
  // Kayıtlı dosya silinmişse uyarılır: sekme "ana görüntü" göstermesin, sessizce yanlış çıkmasın.
  const evidence = project.pomodoroVisuals;
  const index = statuses.findIndex((status) => status.name === active.key);
  const savedExists = active.key === INTRO_TAB
    ? (evidence?.intro.exists ?? true)
    : (evidence?.statuses[index]?.exists ?? true);
  const missing = savedVisual !== null && !savedExists;
  const mainName = workPath ? nameOf(workPath) : null;
  const shownName = savedName && !missing ? savedName : mainName;

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
      <p className="field-hint">Ana görüntü: aşağıda ayrı görüntü seçmediğin her yerde bu görünür.</p>
      <div className="visual-picker" role="radiogroup" aria-label="Ana görüntü">
        {workCandidates.map((path) => {
          const name = nameOf(path);
          const selected = workPath !== null && nameOf(workPath) === name;
          return (
            <button
              key={path}
              type="button"
              role="radio"
              aria-checked={selected}
              title={name}
              className={selected ? 'visual-tile selected' : 'visual-tile'}
              onClick={() => onPickWork(path)}
            >
              <Thumb projectId={project.id} name={name} />
            </button>
          );
        })}
      </div>
      {workCandidates.length === 0 ? (
        <p className="field-hint">Henüz dosya yok. Klasöre bir resim ya da döngü videosu koy.</p>
      ) : null}

      <h3 id="status-tabs-title" style={{ marginTop: 'var(--space-4)' }}>Hangi görüntü ne zaman?</h3>
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
              {savedName && !missing ? savedName : 'Ana görüntüyle aynı'}
            </p>
          </div>
        </div>

        {missing ? (
          <p className="field-hint field-error" role="alert">
            Seçili görüntü bulunamadı: {savedName}. Aşağıdan başka bir dosya seç ya da “Ana görüntüyle aynı”yı seç.
          </p>
        ) : null}

        <div className="visual-picker" role="radiogroup" aria-label={`${active.label} görüntüsü`}>
          <button
            type="button"
            role="radio"
            aria-checked={savedVisual === null}
            className={savedVisual === null ? 'visual-tile visual-tile-text selected' : 'visual-tile visual-tile-text'}
            disabled={busy}
            onClick={() => void save(active.key, null)}
          >
            Ana görüntüyle aynı
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
