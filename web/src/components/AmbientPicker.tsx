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
          {data ? <span className="count"> ({data.selected.length} seçili)</span> : null}
        </button>
        {onManage ? (
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
            onClick={onManage}
          >
            Ambiance klasörü
          </button>
        ) : null}
      </div>

      {open ? (
        <div style={{ marginTop: 8 }}>
          {error ? <p className="form-error">{error}</p> : null}
          {data === null && !error ? <p className="field-hint">Yükleniyor...</p> : null}
          {data?.error ? <p className="form-error">{data.error}</p> : null}

          {data ? (
            <>
              <p className="field-hint">
                Seçtiğin sesler videonun <strong>tamamı boyunca</strong> arka planda çalar.
                {saved ? <strong> ✓ Kaydedildi</strong> : null}
              </p>
              {/* Seviye sorusu kullanıcıya bırakılmıyor: montaj müziği ölçüp
                  ambiance'ı ona göre ayarlıyor (steps/03-ambient-mix.js). Kaç
                  ses seçilirse seçilsin TOPLAM aynı kalıyor, bu yüzden "hangisi
                  baskın" diye karar vermek gerekmiyor. */}
              <p className="field-hint">
                Ses seviyesini sen ayarlamıyorsun: montaj önce müziğin seviyesini
                ölçüyor, ambiance'ı <strong>{Math.abs(data.volumeDb ?? data.defaultVolumeDb)} LU
                daha sessiz</strong> olacak şekilde ayarlıyor. Kaç ses seçersen seç
                toplamı aynı kalır — müziğin önüne geçmez.
              </p>

              {data.available.length === 0 ? (
                <p className="field-hint">
                  Ortak klasörde ses yok: <code>{data.dir}</code>
                </p>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {data.available.map((item) => {
                    const isSelected = selectedNames.has(item.name);
                    const isPlaying = playing === item.name;
                    return (
                      <span
                        key={item.name}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        {/* Dinleme seçimden ayrı: sesi seçmeden de duyabilsin */}
                        <button
                          type="button"
                          className="button"
                          aria-label={`${item.name} sesini ${isPlaying ? 'durdur' : 'dinle'}`}
                          aria-pressed={isPlaying}
                          title={isPlaying ? 'Durdur' : 'Dinle'}
                          style={{
                            fontSize: 12, minHeight: 28, padding: '2px 8px',
                            borderTopRightRadius: 0, borderBottomRightRadius: 0,
                          }}
                          onClick={() => togglePlay(item.name)}
                        >
                          {isPlaying ? '■' : '▶'}
                        </button>
                        <button
                          type="button"
                          className={isSelected ? 'button button-selected' : 'button'}
                          aria-pressed={isSelected}
                          style={{
                            fontSize: 12, minHeight: 28, padding: '2px 10px',
                            borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                            marginLeft: -1,
                          }}
                          onClick={() => void toggle(item.name)}
                          disabled={saving}
                        >
                          {isSelected ? '✓' : '+'} {item.name}
                        </button>
                      </span>
                    );
                  })}
                </div>
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
        </div>
      ) : null}
    </div>
  );
}
