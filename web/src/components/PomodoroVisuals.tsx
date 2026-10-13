/**
 * Pomodoro görüntü eşleştirmesi — Video adımında, YALNIZCA Pomodoro açıkken.
 *
 * İki kart yan yana, hangi görüntünün hangi anda görüneceğini küçük resimle gösterir:
 *   [ GET READY · ÇALIŞMA ]   [ MOLA ]
 * Karta tıkla → altında dosyaların küçük resimleri açılır, birine tıkla → o an için seçilir.
 * Mola kartında "Aynı" seçeneği var: mola da çalışma görüntüsünü kullanır (varsayılan).
 *
 * Çalışma görüntüsü Video adımının mevcut seçimidir (Kaydet düğmesiyle yazılır); mola
 * görüntüsü seçilir seçilmez kaydedilir. Tür (resim / döngü videosu) dosya uzantısından anlaşılır.
 */

import { useState } from 'react';

import { fetchProject, getProjectVisualUrl, setProjectBreakClip, uploadProjectClip, uploadProjectImage } from '../api';
import { errorText } from '../format';
import { IMAGE_ACCEPT, isImageName } from '../imageTypes';
import { UploadButton } from '../pages/workspace/StepWidgets';
import type { ProjectDetail } from '../types';

type Slot = 'work' | 'break';

type PomodoroVisualsProps = {
  project: ProjectDetail;
  /** Çalışma görüntüsü olarak SEÇİLİ dosya (VideoStage'in seçimi; henüz kaydedilmemiş olabilir). */
  workPath: string | null;
  /** Çalışma için seçilebilir dosyalar (VideoStage'in mevcut kaynak listesi). */
  workCandidates: string[];
  onPickWork: (path: string) => void;
  onProjectUpdate?: (project: ProjectDetail) => void;
};

const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** "./videolar/mola.mp4" → "videolar/mola.mp4" (adaylarla kayıt aynı biçimde karşılaşsın). */
const bare = (path: string) => path.replace(/^\.\//, '');

/** Küçük resim: resimse <img>, videoysa ilk kare (indirmeden, yalnızca metadata). */
function Thumb({ projectId, name }: { projectId: string; name: string }) {
  const url = getProjectVisualUrl(projectId, name);
  return isImageName(name)
    ? <img src={url} alt="" draggable={false} />
    : <video src={`${url}#t=0.1`} muted playsInline preload="metadata" />;
}

export function PomodoroVisuals({
  project, workPath, workCandidates, onPickWork, onProjectUpdate,
}: PomodoroVisualsProps) {
  const [active, setActive] = useState<Slot>('work');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedBreak = project.breakClip?.value ? bare(project.breakClip.value) : null;
  const breakMissing = savedBreak !== null && !project.breakClip?.exists;
  const workName = workPath ? nameOf(workPath) : null;
  const breakName = savedBreak && !breakMissing ? nameOf(savedBreak) : null;
  const sameAsWork = breakName === null;
  const breakCandidates = project.breakCandidates ?? [];

  const saveBreak = async (breakClip: string) => {
    setBusy(true);
    setError(null);
    try {
      await setProjectBreakClip(project.id, breakClip);
      onProjectUpdate?.(await fetchProject(project.id));
    } catch (err: unknown) {
      setError(errorText(err, 'Mola görüntüsü kaydedilemedi.'));
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (files: File[]) => {
    const before = new Set(breakCandidates);
    let latest = project;
    for (const file of files) {
      latest = isImageName(file.name)
        ? await uploadProjectImage(project.id, file)
        : await uploadProjectClip(project.id, file);
    }
    onProjectUpdate?.(latest);
    // Yüklenen dosya mola görüntüsü olsun: ayrıca seçtirmeyelim.
    const added = (latest.breakCandidates ?? []).find((path) => !before.has(path));
    if (added) await saveBreak(added);
  };

  const frame = (name: string | null, dim = false) => (
    <span className={dim ? 'visual-slot-frame is-dim' : 'visual-slot-frame'}>
      {name ? <Thumb projectId={project.id} name={name} /> : <span className="muted">Seçilmedi</span>}
    </span>
  );

  return (
    <section className="stage-subsection" aria-labelledby="pomodoro-visuals-title">
      <h3 id="pomodoro-visuals-title">Hangi görüntü ne zaman?</h3>

      <div className="visual-slots" role="group" aria-label="Görüntü eşleştirmesi">
        <button
          type="button"
          className={active === 'work' ? 'visual-slot is-active' : 'visual-slot'}
          aria-pressed={active === 'work'}
          onClick={() => setActive('work')}
        >
          {frame(workName)}
          <strong>GET READY · ÇALIŞMA</strong>
          <span className="muted">{workName ?? 'Aşağıdan seç'}</span>
        </button>
        <button
          type="button"
          className={active === 'break' ? 'visual-slot is-active' : 'visual-slot'}
          aria-pressed={active === 'break'}
          onClick={() => setActive('break')}
        >
          {frame(breakName ?? workName, sameAsWork)}
          <strong>MOLA</strong>
          <span className="muted">{breakName ?? 'Çalışmayla aynı'}</span>
        </button>
      </div>

      {breakMissing ? (
        <p className="field-hint field-error" role="alert">
          Seçili mola görüntüsü bulunamadı: {savedBreak}. Aşağıdan başka bir dosya seç.
        </p>
      ) : null}

      <p className="field-hint">
        {active === 'work' ? 'Çalışma ve GET READY için bir görüntü seç:' : 'Mola için bir görüntü seç:'}
      </p>

      <div className="visual-picker" role="radiogroup" aria-label={active === 'work' ? 'Çalışma görüntüsü' : 'Mola görüntüsü'}>
        {active === 'break' ? (
          <button
            type="button"
            role="radio"
            aria-checked={sameAsWork}
            className={sameAsWork ? 'visual-tile visual-tile-text selected' : 'visual-tile visual-tile-text'}
            disabled={busy}
            onClick={() => void saveBreak('')}
          >
            Aynı
          </button>
        ) : null}

        {(active === 'work' ? workCandidates : breakCandidates).map((path) => {
          const name = nameOf(path);
          const selected = active === 'work'
            ? workPath !== null && nameOf(workPath) === name
            : savedBreak !== null && nameOf(savedBreak) === name;
          return (
            <button
              key={path}
              type="button"
              role="radio"
              aria-checked={selected}
              title={name}
              className={selected ? 'visual-tile selected' : 'visual-tile'}
              disabled={busy}
              onClick={() => (active === 'work' ? onPickWork(path) : void saveBreak(path))}
            >
              <Thumb projectId={project.id} name={name} />
            </button>
          );
        })}
      </div>

      {(active === 'work' ? workCandidates : breakCandidates).length === 0 ? (
        <p className="field-hint">Henüz dosya yok. Aşağıdan bir resim ya da döngü videosu yükle.</p>
      ) : null}

      {active === 'break' ? (
        <UploadButton
          label="Mola için dosya yükle (resim ya da .mp4)"
          accept={`.mp4,${IMAGE_ACCEPT}`}
          primary={false}
          disabled={busy}
          onFiles={handleUpload}
        />
      ) : null}

      {error ? <p className="field-hint field-error" role="alert">{error}</p> : null}
    </section>
  );
}
