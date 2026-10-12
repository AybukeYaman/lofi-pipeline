/**
 * Pomodoro mola görüntüsü — Video adımında, YALNIZCA Pomodoro açıkken görünür.
 *
 * Çalışma görüntüsü bugünkü klip seçimidir (üstteki liste); burada yalnızca
 * mola için ikinci bir görüntü verilir. Resim de olur, döngü videosu da —
 * tür dosya uzantısından anlaşılır, ayrıca sorulmaz. Seçim anında kaydedilir
 * (Kaydet düğmesi yok); "Mola da aynı olsun" işaretliyse hiçbir şey yazılmaz
 * ve sistem eskisi gibi tek görüntüyle çalışır.
 */

import { useEffect, useState } from 'react';

import { fetchProject, setProjectBreakClip, uploadProjectClip, uploadProjectImage } from '../api';
import { IMAGE_ACCEPT, isImageName } from '../imageTypes';
import { UploadButton } from '../pages/workspace/StepWidgets';
import { errorText } from '../format';
import type { ProjectDetail } from '../types';

type BreakVisualPickerProps = {
  project: ProjectDetail;
  onProjectUpdate?: (project: ProjectDetail) => void;
};

/** "./videolar/mola.mp4" → "videolar/mola.mp4" (adaylar ve kayıt aynı biçimde karşılaşsın). */
function bare(path: string): string {
  return path.replace(/^\.\//, '');
}

export function BreakVisualPicker({ project, onProjectUpdate }: BreakVisualPickerProps) {
  const candidates = project.breakCandidates ?? [];
  const saved = project.breakClip?.value ? bare(project.breakClip.value) : null;
  const savedMissing = Boolean(saved) && !project.breakClip?.exists;

  // "Mola da aynı" yalnızca kayıt yokken işaretli; kaldırınca seçim beklenir (henüz yazılmaz).
  const [same, setSame] = useState(saved === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setSame(saved === null); }, [saved]);

  const save = async (breakClip: string) => {
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

  const handleSame = async (checked: boolean) => {
    setSame(checked);
    if (checked && saved !== null) await save('');
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
    // Yüklenen dosya mola görüntüsü olsun: yeni aday varsa onu seç (ayrıca seçtirmeyelim).
    const added = (latest.breakCandidates ?? []).find((path) => !before.has(path));
    if (added) await save(added);
  };

  return (
    <section className="stage-subsection" aria-labelledby="break-visual-title">
      <h3 id="break-visual-title">Mola görüntüsü</h3>
      <p className="field-hint">
        Çalışma oturumlarında yukarıda seçtiğin görüntü, mola oturumlarında bu görüntü gösterilir.
      </p>

      <label className="option">
        <input
          type="checkbox"
          checked={same}
          disabled={busy}
          onChange={(event) => void handleSame(event.target.checked)}
        />
        <span>Mola da aynı görüntüyü kullansın</span>
      </label>

      {same ? null : (
        <>
          {savedMissing ? (
            <p className="field-hint field-error" role="alert">
              Seçili mola görüntüsü bulunamadı: {saved}. Aşağıdan başka bir dosya seç.
            </p>
          ) : null}

          {candidates.length > 0 ? (
            <div className="option-list" role="radiogroup" aria-label="Mola görüntüsü">
              {candidates.map((path) => (
                <label key={path} className={saved === path ? 'option selected' : 'option'}>
                  <input
                    type="radio"
                    name={`break-clip-${project.id}`}
                    checked={saved === path}
                    disabled={busy}
                    onChange={() => void save(path)}
                  />
                  <span>{path.split('/').pop()}</span>
                  <span className="count">{isImageName(path) ? 'resim' : 'video'}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="field-hint">Henüz dosya yok. Aşağıdan bir resim ya da döngü videosu yükle.</p>
          )}

          <UploadButton
            label="Mola görüntüsü yükle (resim ya da .mp4)"
            accept={`.mp4,${IMAGE_ACCEPT}`}
            primary={false}
            disabled={busy}
            onFiles={handleUpload}
          />
        </>
      )}

      {error ? <p className="field-hint field-error" role="alert">{error}</p> : null}
    </section>
  );
}
