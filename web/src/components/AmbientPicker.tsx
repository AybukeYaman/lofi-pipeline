/**
 * Ambiance seçim kutusu — adım panellerinin içinde kullanılır.
 *
 * Tek iş: videonun TAMAMI boyunca arka planda çalacak sesleri seçmek.
 * Seçilen ses videodan kısaysa döngüye girer, uzunsa video süresinde kesilir;
 * birden fazla seçilirse hepsi birlikte çalar. Bunların hiçbiri sorulmuyor —
 * kullanıcı yalnızca "hangi sesler" diyor, gerisini montaj hallediyor.
 *
 * Mod (katman/sıra), döngü harmanı ve parça başına ses seviyesi `project.json`
 * üzerinden hâlâ ayarlanabiliyor (bkz. core/ambient-plan.js) ama arayüze
 * konmadı: kullanıcı istemedi, varsayılanlar işini görüyor.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchProjectAmbient, getAmbientAudioUrl, updateProjectAmbient } from '../api';
import { PickerPanel } from './PickerPanel';
import type { ProjectAmbient } from '../types';

type AmbientPickerProps = {
  projectId: string;
  /** Kutunun başlığı. */
  label?: string;
  /** Ambiance sayfasına gitmek için (yoksa bağlantı gösterilmez). */
  onManage?: () => void;
};

export function AmbientPicker({ projectId, label = 'Arka plan sesi (Ambiance)', onManage }: AmbientPickerProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectAmbient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  // Tek bir <audio> paylaşılıyor: iki ses birden çalıp birbirine karışmasın.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Kutu kapanınca ya da bileşen kalkınca çalan ses susar.
  useEffect(() => {
    if (!open && audioRef.current) {
      audioRef.current.pause();
      setPlaying(null);
    }
  }, [open]);

  /** Aynı sese tekrar basmak durdurur; başka sese basmak ona geçer. */
  const togglePlay = (name: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing === name) {
      audio.pause();
      setPlaying(null);
      return;
    }
    audio.src = getAmbientAudioUrl(name);
    setPlaying(name);
    // Tarayıcı çalmayı reddedebilir (ör. otomatik oynatma kısıtı) — sessizce
    // yut, düğme durumu onEnded/onPause ile kendini düzeltir.
    void audio.play().catch(() => setPlaying(null));
  };

  // Yalnızca kutu açılınca yüklenir: her adım panelinde boşuna istek atılmasın.
  useEffect(() => {
    if (!open || data !== null) return;
    let active = true;
    fetchProjectAmbient(projectId)
      .then((loaded) => { if (active) setData(loaded); })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Ambiance listesi yüklenemedi.');
      });
    return () => { active = false; };
  }, [open, data, projectId]);

  /**
   * Sesi seçime ekler ya da çıkarır ve hemen kaydeder.
   *
   * Sunucunun yanıtı tekrar okunuyor (iyimser güncelleme yapılmıyor): yazarken
   * bir ses kaybolmuşsa "dosya bulunamadı" işareti hemen görünsün.
   */
  const toggle = async (name: string) => {
    if (!data || saving) return;
    const selected = data.selected.some((track) => track.name === name)
      ? data.selected.filter((track) => track.name !== name)
      : [...data.selected, { name, volumeDb: null, missing: false }];

    setSaving(true);
    setError(null);
    try {
      setData(await updateProjectAmbient(projectId, { tracks: selected.map((t) => t.name) }));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ambiance seçimi kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  const selectedNames = new Set((data?.selected ?? []).map((track) => track.name));
  // Seçili olup klasörde bulunamayan sesler de listede kalsın: dosya taşınmışsa
  // kullanıcı neyin eksik olduğunu görsün, seçim sessizce kaybolmasın.
  const missing = (data?.selected ?? []).filter((track) => track.missing);

  return (
    <PickerPanel
      label={label}
      /* Seçili sesler kapalıyken de okunsun — "ne seçtim?" için açmaya gerek yok. */
      badge={
        data
          ? data.selected.length === 0
            ? '(yok)'
            : `(${data.selected.map((track) => track.name).join(', ')})`
          : undefined
      }
      open={open}
      onOpenChange={setOpen}
      actions={
        onManage ? (
          <button type="button" className="button" onClick={onManage}>
            Ambiance klasörü
          </button>
        ) : null
      }
    >
      <>
          {error ? <p className="form-error">{error}</p> : null}
          {data === null && !error ? <p className="field-hint">Yükleniyor...</p> : null}
          {data?.error ? <p className="form-error">{data.error}</p> : null}

          {data ? (
            <>
              <p className="field-hint">
                Video boyunca arka planda çalar · müzikten{' '}
                {Math.abs(data.volumeDb ?? data.defaultVolumeDb)} LU sessiz
                {saved ? <strong> · ✓ Kaydedildi</strong> : null}
              </p>

              {data.available.length === 0 ? (
                <p className="field-hint">
                  Ortak klasörde ses yok: <code>{data.dir}</code>
                </p>
              ) : (
                /* Dropdown listesi: her ses tek satır, satıra basmak seçer.
                   Yan yana dizili ▶/+ düğme çiftleri yerine okunur bir liste —
                   seçili olanlar kapalı başlıkta da yazdığı için kutuyu açmaya
                   gerek kalmıyor. */
                <ul className="ambient-options" role="group" aria-label="Arka plan sesleri">
                  {data.available.map((item) => {
                    const isSelected = selectedNames.has(item.name);
                    const isPlaying = playing === item.name;
                    return (
                      <li key={item.name}>
                        {/* Dinleme seçimden ayrı: sesi seçmeden de duyabilsin. */}
                        <button
                          type="button"
                          className="button ambient-play"
                          aria-label={`${item.name} sesini ${isPlaying ? 'durdur' : 'dinle'}`}
                          aria-pressed={isPlaying}
                          title={isPlaying ? 'Durdur' : 'Dinle'}
                          onClick={() => togglePlay(item.name)}
                        >
                          {isPlaying ? '■' : '▶'}
                        </button>
                        <button
                          type="button"
                          className="ambient-option"
                          role="checkbox"
                          aria-checked={isSelected}
                          disabled={saving}
                          onClick={() => void toggle(item.name)}
                        >
                          <span className="ambient-check" aria-hidden="true">{isSelected ? '✓' : ''}</span>
                          <span className="ambient-name">{item.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {missing.length > 0 ? (
                <p className="form-error" style={{ marginTop: 8 }}>
                  Seçili ama klasörde bulunamadı: {missing.map((track) => track.name).join(', ')}
                </p>
              ) : null}

              {/* Görünmez: oynatmayı yukarıdaki ▶ düğmeleri yönetiyor.
                  Ses bitince düğme kendini ▶ durumuna döndürüyor. */}
              <audio
                ref={audioRef}
                preload="none"
                onEnded={() => setPlaying(null)}
                onPause={() => setPlaying(null)}
                style={{ display: 'none' }}
              />
            </>
          ) : null}
      </>
    </PickerPanel>
  );
}
