/** Adım ekranlarının ortak parçaları: yönerge kutusu, kopyalanabilir prompt, dosya yükleme. */

import { useRef, useState } from 'react';

import { errorText } from '../../format';
import type { WorkflowStepId } from '../../types';
import { STEP_GUIDE } from '../../workflow';

export function StepGuide({ stepId }: { stepId: WorkflowStepId }) {
  const guide = STEP_GUIDE[stepId];
  return (
    <div className="step-guide" role="note">
      <strong>{guide.who === 'system' ? 'Sistem yapacak' : 'Senin yapman gereken'}</strong>
      {guide.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

type CopyPromptProps = {
  label: string;
  prompt: string | null | undefined;
  error?: string | null;
  buttonLabel?: string;
};

/** Hazır metin + panoya kopyalama (prompt ya da tracklist). */
export function CopyPrompt({ label, prompt, error, buttonLabel = 'Promptu Kopyala' }: CopyPromptProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  if (!prompt) {
    return (
      <p className="field-hint field-error" role="alert">
        {error ?? 'Prompt yüklenemedi.'}
      </p>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Prompt panoya kopyalanamadı; metni elle seçip kopyala.');
    }
  };

  return (
    <div className="prompt-box">
      <div className="prompt-box-header">
        <strong>{label}</strong>
        <button className="button" type="button" onClick={handleCopy}>
          {copied ? '✓ Kopyalandı' : buttonLabel}
        </button>
      </div>
      <textarea readOnly rows={6} value={prompt} aria-label={label} />
      {copyError ? (
        <p className="field-hint field-error" role="alert">
          {copyError}
        </p>
      ) : null}
    </div>
  );
}

type UploadButtonProps = {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => Promise<void>;
};

/** Dosya seçtirir, yüklemeyi bekler; hata ve başarı mesajını kendisi gösterir. */
export function UploadButton({ label, accept, multiple, disabled, onFiles }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await onFiles(files);
      setSuccess(files.length === 1 ? `${files[0].name} yüklendi.` : `${files.length} dosya yüklendi.`);
    } catch (err: unknown) {
      setError(errorText(err, 'Dosya yüklenemedi.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="upload-button">
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="visually-hidden" onChange={handleChange} />
      <button
        className="button button-primary"
        type="button"
        disabled={busy || disabled}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Yükleniyor...' : label}
      </button>
      {error ? (
        <p className="field-hint field-error" role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className="field-hint field-success">✓ {success}</p> : null}
    </div>
  );
}
