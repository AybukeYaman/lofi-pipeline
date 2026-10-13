import { useEffect, useState, type FormEvent } from 'react';

import { POMODORO_PRESETS } from '../../../core/pomodoro-plan.js';
import { validateVideoName } from '../../../core/project-name.js';
import { createProject, fetchProjects, ApiError } from '../api';
import { PageHeader } from '../components/PageHeader';
import { StatusEditor } from '../components/StatusEditor';
import { statusesPayload, type PomodoroChoice } from '../pomodoroSetup';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectSummary } from '../types';

type FormErrors = Partial<Record<'name' | 'mode' | 'form', string>>;

/** "Bu video nasıl olacak?" — sihirbazın geri kalanı bu cevaba göre uyarlanır. */
type VideoMode = 'ambiance' | 'pomodoro';

/** Pomodoro seçilince ilk düğmeler: 50/10 ve 2 saat (2 tur), sesler açık. */
const DEFAULT_POMODORO: PomodoroChoice = {
  statuses: POMODORO_PRESETS[0].statuses.map((status: PomodoroChoice['statuses'][number]) => ({ ...status })),
  rounds: 2,
};

// Görsel kaynağı (tek resim / döngü videosu) burada sorulmaz: tek yeri
// workspace'in 2. adımı (VideoStage). Proje varsayılan `clip` ile kurulur;
// kırpma o adımda "kaydet" denince açıkça yazılır.

const PROJECT_DRAFT_KEY = 'lofi_new_project_draft';

export function NewProject({
  initialParentId,
  onCancel,
  onCreated,
}: {
  initialParentId?: string;
  onCancel: () => void;
  onCreated?: (id: string) => void;
}) {
  // "+ Alt Proje" ile gelindiyse üst proje kararı önceki ekranda verilmiştir:
  // tekrar sormak yerine onaylatıp değiştirme imkânı bırakılır. Değer rotadan
  // gelir (router.parseRoute `?parent=`i çözer); burada adres çubuğu okunmaz.
  const presetParentId = initialParentId || '';

  const [name, setName] = useState('');
  const [concept, setConcept] = useState('');
  // Bilerek başlangıç değeri yok: tür her projede AÇIKÇA seçilir.
  const [mode, setMode] = useState<VideoMode | null>(null);
  const [pomodoro, setPomodoro] = useState<PomodoroChoice>(DEFAULT_POMODORO);
  const [parentId, setParentId] = useState<string>(presetParentId);
  const [isEditingParent, setIsEditingParent] = useState(!presetParentId);
  const [errors, setErrors] = useState<FormErrors>({});
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [namesState, setNamesState] = useState<LoadState>('loading');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [restoredDraftTime, setRestoredDraftTime] = useState<string | null>(null);

  const [availableProjects, setAvailableProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROJECT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft) return;
      if (draft.name) setName(draft.name);
      if (draft.concept) setConcept(draft.concept);
      if (draft.mode === 'ambiance' || draft.mode === 'pomodoro') setMode(draft.mode);
      // Eski taslaklar (çalışma/mola dakikası) durum listesi taşımaz: onlar atılır, varsayılan kalır.
      if (draft.pomodoro && Array.isArray(draft.pomodoro.statuses) && draft.pomodoro.statuses.length > 0) {
        setPomodoro({
          statuses: draft.pomodoro.statuses,
          rounds: Number.isInteger(draft.pomodoro.rounds) ? draft.pomodoro.rounds : DEFAULT_POMODORO.rounds,
        });
      }
      if (draft.parentId && !presetParentId) {
        setParentId(draft.parentId);
        setIsEditingParent(true);
      }
      setRestoredDraftTime(draft.savedAt || 'Önceki oturum');
    } catch {}
  }, []);

  useEffect(() => {
    if (presetParentId) {
      setParentId(presetParentId);
      setIsEditingParent(false);
    }
  }, [presetParentId]);

  useEffect(() => {
    let isActive = true;
    fetchProjects()
      .then((projects) => {
        if (!isActive) return;
        setAvailableProjects(projects);
        setExistingNames(projects.map((project) => project.name.toLowerCase()));
        setNamesState('loaded');
      })
      .catch(() => {
        if (isActive) setNamesState('error');
      });

    return () => {
      isActive = false;
    };
  }, []);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setErrors((prev) => ({ ...prev, form: undefined }));
    setServerProblems([]);
  };

  const saveDraft = () => {
    try {
      if (name || concept || parentId) {
        localStorage.setItem(
          PROJECT_DRAFT_KEY,
          JSON.stringify({
            name,
            concept,
            mode,
            pomodoro,
            parentId,
            savedAt: new Date().toLocaleTimeString(),
          }),
        );
      }
    } catch {}
  };

  const clearDraft = () => {
    try {
      localStorage.removeItem(PROJECT_DRAFT_KEY);
    } catch {}
    setRestoredDraftTime(null);
    setName('');
    setConcept('');
    setMode(null);
    setPomodoro(DEFAULT_POMODORO);
    setParentId(presetParentId);
    setIsEditingParent(!presetParentId);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors: FormErrors = validate({ name, existingNames });
    if (mode === null) nextErrors.mode = 'Önce videonun türünü seç: Ambiance ya da Pomodoro.';
    setErrors(nextErrors);
    setServerProblems([]);

    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const response = await createProject({
        name: name.trim(),
        concept: concept.trim() || undefined,
        parentId: parentId || undefined,
        // Ambiance'ta hiç gönderilmez: proje bugünkü gibi kurulur.
        ...(mode === 'pomodoro'
          ? {
            pomodoro: {
              statuses: statusesPayload(pomodoro.statuses),
              rounds: pomodoro.rounds,
            },
          }
          : {}),
      });

      try {
        localStorage.removeItem(PROJECT_DRAFT_KEY);
      } catch {}

      showSuccess(`"${response.project.name || name}" projesi başarıyla oluşturuldu!`, 'Proje Başlatıldı');

      if (onCreated) {
        onCreated(response.project.id);
      }
    } catch (err: unknown) {
      showError(err, 'Proje oluşturulamadı.');
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrors({ name: err.message });
        } else if (err.status === 422) {
          setErrors({ form: err.message });
          if (err.problems && err.problems.length > 0) {
            setServerProblems(err.problems);
          }
        } else {
          setErrors({ form: err.message });
        }
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'Proje oluşturulamadı.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Vazgeçmek taslağı sessizce saklar: "sakla mı, sil mi" kararı burada
  // sorulmaz, geri dönünce bildirim şeridinden sıfırlanabilir.
  const handleCancelWithDraft = () => {
    saveDraft();
    onCancel();
  };

  const parentName =
    availableProjects.find((project) => project.id === parentId)?.name || parentId;

  return (
    <section className="page narrow">
      <PageHeader
        eyebrow="YENİ PROJE"
        title="Yeni Proje"
        description="Klasörü kur ve albüm konseptini ver." 
      />

      {restoredDraftTime ? (
        <div
          className="notice"
          style={{
            borderColor: '#e5dccb',
            background: '#faf7f0',
            color: '#5c523b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <div>
            <strong>📝 Yarım kalan proje taslağı yüklendi</strong> <span className="muted">({restoredDraftTime})</span>
          </div>
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, padding: '2px 8px' }}
            onClick={clearDraft}
          >
            🗑️ Taslağı Sıfırla
          </button>
        </div>
      ) : null}

      <form className="panel form" onSubmit={handleSubmit} noValidate>
        {errors.form ? (
          <div className="state-card" role="alert" style={{ borderColor: '#b5654f', color: '#97432c' }}>
            <strong>{errors.form}</strong>
            {serverProblems.length > 0 ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {serverProblems.map((prob, idx) => (
                  <li key={idx}>{prob}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Bu video nasıl olacak?</legend>
          <div className="choice-cards" role="radiogroup" aria-label="Video türü">
            {([
              ['ambiance', 'Ambiance', 'Sakin lofi: müzik ve arka plan sesi. Video, müziğin süresi kadar olur.'],
              ['pomodoro', 'Pomodoro', '2 dk GET READY, sonra çalışma ve mola oturumları: ekranda STUDY/BREAK yazısı, sayaç ve her oturumun sonunda bip.'],
            ] as const).map(([value, title, text]) => (
              <label key={value} className={mode === value ? 'choice-card selected' : 'choice-card'}>
                <span className="choice-card-head">
                  <strong>{title}</strong>
                  <input
                    type="radio"
                    name="video-mode"
                    checked={mode === value}
                    disabled={isSubmitting}
                    onChange={() => edit(setMode)(value)}
                  />
                </span>
                <span className="muted">{text}</span>
              </label>
            ))}
          </div>
          {errors.mode ? <p className="field-error" role="alert">{errors.mode}</p> : null}
          {mode === 'pomodoro' ? (
            <div style={{ marginTop: 8 }}>
              <StatusEditor
                value={pomodoro}
                disabled={isSubmitting}
                onChange={edit(setPomodoro)}
              />
              <p className="field-hint" style={{ marginTop: 8 }}>
                Her durum için ayrı görüntü sonraki adımda (Video) seçilir. Bunları sonradan da değiştirebilirsin.
              </p>
            </div>
          ) : null}
        </fieldset>

        <div className="field">
          <label htmlFor="project-name">Proje adı</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => edit(setName)(event.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby="project-name-hint"
            autoComplete="off"
            placeholder="video10-rainy-tokyo"
            disabled={isSubmitting}
          />
          <p id="project-name-hint" className={errors.name ? 'field-error' : 'field-hint'}>
            {errors.name ??
              (namesState === 'loading'
                ? 'Mevcut proje adları kontrol ediliyor...'
                : namesState === 'error'
                  ? 'Mevcut adlar kontrol edilemedi.'
                  : 'videolar\\ altındaki klasör adı olarak kullanılır.')}
          </p>
        </div>

        <div className="field">
          <label htmlFor={isEditingParent ? 'project-parent' : undefined}>Üst proje</label>
          {isEditingParent ? (
            <>
              <select
                id="project-parent"
                value={parentId}
                onChange={(event) => edit(setParentId)(event.target.value)}
                disabled={isSubmitting}
              >
                <option value="">(Yok — bağımsız ana proje)</option>
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.parentId ? `   ↳ ${p.name}` : `📁 ${p.name}`}
                  </option>
                ))}
              </select>
              <p className="field-hint">Boş bırakılabilir</p>
            </>
          ) : (
            <p className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
              <span>
                📁 <strong>{parentName}</strong> altında alt proje olarak oluşturulacak.
              </span>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, padding: '2px 8px' }}
                disabled={isSubmitting}
                onClick={() => setIsEditingParent(true)}
              >
                Değiştir
              </button>
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="project-concept">Albüm konsepti</label>
          <textarea
            id="project-concept"
            value={concept}
            onChange={(event) => edit(setConcept)(event.target.value)}
            rows={3}
            placeholder="Late night rain over a quiet Tokyo apartment"
            disabled={isSubmitting}
          />
          <p className="field-hint">
            Opsiyonel · albümün kısa tanımı
          </p>
        </div>

        <div className="form-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="button" type="button" onClick={handleCancelWithDraft} disabled={isSubmitting}>
            Vazgeç
          </button>
          <button className="button button-primary" type="submit" disabled={isSubmitting} style={{ marginLeft: 'auto' }}>
            {isSubmitting ? 'Proje oluşturuluyor...' : 'Projeyi Oluştur'}
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 8, marginBottom: 0 }}>
          Vazgeçsen de taslak saklanır
        </p>
      </form>
    </section>
  );
}

/** Testlerden de çağrılıyor (web/src/pages/NewProject.validate.test.ts). */
export function validate({
  name,
  existingNames,
}: {
  name: string;
  existingNames: string[];
}): FormErrors {
  const errors: FormErrors = {};
  const trimmed = name.trim();

  // Klasör adı kuralları sunucuyla tek kaynaktan (core/project-name.js).
  // Form eskiden kendi regex'ini taşıyordu ve sapmıştı: boşluğu yasaklıyordu
  // (projenin kendi düzeni "video3-Neo Tokyo Night" reddediliyordu), ayrılmış
  // adları (CON, NUL...) ise kaçırıp sunucudan 422 almaya bırakıyordu.
  const problems = validateVideoName(trimmed);

  if (problems.length > 0) {
    errors.name = problems.join(' · ');
  } else if (trimmed.length > 80) {
    // Yalnızca formda: Windows yol uzunluğu için pratik sınır.
    errors.name = 'En fazla 80 karakter kullan.';
  } else if (existingNames.includes(trimmed.toLowerCase())) {
    errors.name = 'Bu adda bir proje zaten var.';
  }

  return errors;
}
