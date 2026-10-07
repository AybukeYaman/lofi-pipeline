/**
 * Prompt kütüphanesinden kopyalama kutusu — adım panellerinin içinde kullanılır.
 *
 * Kütüphanenin kendisi Promptlar sayfasında yönetilir (ekle/düzenle/sil); bu
 * bileşen yalnızca OKUR ve kopyalar, böylece adım paneli kalabalıklaşmıyor.
 * `tag` verilirse sadece o etiketli promptlar gelir (ör. Müzik adımında
 * `music`), ama kullanıcı "Tümü"ne basıp hepsine ulaşabilir.
 */

import { useEffect, useState } from 'react';

import { copyTextToClipboard, fetchPromptLibrary } from '../api';
import type { LibraryPrompt, PromptTag } from '../types';

type PromptPickerProps = {
  /** Öntanımlı süzgeç; verilmezse tüm promptlar listelenir. */
  tag?: PromptTag;
  /** Kutunun başlığı. */
  label?: string;
  /** Promptlar sayfasına gitmek için (yoksa bağlantı gösterilmez). */
  onManage?: () => void;
};

export function PromptPicker({ tag, label = 'Kayıtlı promptlarım', onManage }: PromptPickerProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<LibraryPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [onlyTagged, setOnlyTagged] = useState(true);

  // Yalnızca kutu açılınca yüklenir: her adım panelinde boşuna istek atılmasın.
  useEffect(() => {
    if (!open || prompts !== null) return;
    let active = true;
    fetchPromptLibrary()
      .then((data) => { if (active) setPrompts(data.prompts); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Promptlar yüklenemedi.'); });
    return () => { active = false; };
  }, [open, prompts]);

  const handleCopy = async (prompt: LibraryPrompt) => {
    const ok = await copyTextToClipboard(prompt.text);
    if (ok) {
      setCopiedId(prompt.id);
      window.setTimeout(() => setCopiedId(null), 2000);
      setError(null);
    } else {
      setError('Panoya kopyalanamadı — Promptlar sayfasından elle kopyalayabilirsin.');
    }
  };

  const visible = (prompts ?? []).filter((prompt) =>
    !tag || !onlyTagged || prompt.tags.includes(tag));

  return (
    <div style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: '8px 12px', margin: '12px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button"
          style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} {label}
          {prompts ? <span className="count"> ({visible.length})</span> : null}
        </button>
        {onManage ? (
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
            onClick={onManage}
          >
            Promptları yönet
          </button>
        ) : null}
      </div>

      {open ? (
        <div style={{ marginTop: 8 }}>
          {error ? <p className="form-error">{error}</p> : null}
          {prompts === null && !error ? <p className="field-hint">Yükleniyor...</p> : null}

          {tag && prompts !== null ? (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6 }}>
              <input type="checkbox" checked={onlyTagged} onChange={() => setOnlyTagged(!onlyTagged)} />
              Sadece bu adımla ilgili olanlar
            </label>
          ) : null}

          {prompts !== null && visible.length === 0 ? (
            <p className="field-hint">
              Kayıtlı prompt yok. Promptlar sayfasından ekleyebilirsin.
            </p>
          ) : null}

          <div style={{ display: 'grid', gap: 6 }}>
            {visible.map((prompt) => (
              <div
                key={prompt.id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {prompt.title}
                </span>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: 12, minHeight: 26, padding: '2px 10px', flexShrink: 0 }}
                  onClick={() => void handleCopy(prompt)}
                  disabled={Boolean(prompt.error)}
                >
                  {copiedId === prompt.id ? '✓ Kopyalandı' : 'Kopyala'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
