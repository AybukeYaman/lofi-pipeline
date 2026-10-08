import { useEffect, useState, type FormEvent } from 'react';

import { validateVideoName } from '../../../core/project-name.js';
import { createProject, fetchProjects, ApiError } from '../api';
import { PageHeader } from '../components/PageHeader';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectSummary, VideoSource } from '../types';

type FormErrors = Partial<Record<'name' | 'form', string>>;

/**
 * Görsel kaynağı burada kalır (workspace'te de var) çünkü yalnızca kuruluş
 * anında seçilirse doğru kırpma varsayılanı yazılır: prep/scaffold.js tek resim
 * için cropBottom 0, klip için 150 verir. Sonradan kaynağı değiştirmek
 * (prep/project-file.js) kırpmayı bilerek korur, yani 0'a dönmez.
 */
const VIDEO_SOURCE_OPTIONS: Array<{ id: VideoSource; name: string; description: string }> = [
  { id: 'clip', name: 'Döngü videosu (.mp4)', description: 'Watermark payı için alttan 150 px kırpma ile başlar.' },
  { id: 'image', name: 'Tek resim', description: 'Tek görsel video boyunca ekranda kalır; kırpma 0 ile başlar.' },
];

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
  const [parentId, setParentId] = useState<string>(presetParentId);
  const [isEditingParent, setIsEditingParent] = useState(!presetParentId);
  const [videoSource, setVideoSource] = useState<VideoSource>('clip');
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
      if (draft.parentId && !presetParentId) {
        setParentId(draft.parentId);
        setIsEditingParent(true);
      }
      if (draft.videoSource === 'clip' || draft.videoSource === 'image') setVideoSource(draft.videoSource);
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
            parentId,
            videoSource,
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
    setParentId(presetParentId);
    setIsEditingParent(!presetParentId);
    setVideoSource('clip');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate({ name, existingNames });
    setErrors(nextErrors);
    setServerProblems([]);

    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const response = await createProject({
        name: name.trim(),
        videoSource,
        concept: concept.trim() || undefined,
        parentId: parentId || undefined,
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

  const selectedVideoSource =
    VIDEO_SOURCE_OPTIONS.find((option) => option.id === videoSource) ?? VIDEO_SOURCE_OPTIONS[0];

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
            Opsiyonel · parça başlıkları ve Suno prompt'ları buradan üretilir
          </p>
        </div>

        {/* Dropdown: iki seçenek iki büyük kart yerine tek satır. Seçilenin
            kırpma etkisi altta tek satır olarak görünür. */}
        <div className="field">
          <label htmlFor="project-video-source">Görsel kaynağı</label>
          <select
            id="project-video-source"
            value={videoSource}
            onChange={(event) => edit(setVideoSource)(event.target.value as VideoSource)}
            disabled={isSubmitting}
          >
            {VIDEO_SOURCE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <p className="field-hint">{selectedVideoSource.description}</p>
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
