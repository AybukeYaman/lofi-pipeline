/**
 * Pomodoro ayar kutusu — adım panellerinin içinde kullanılır (AmbientPicker ile
 * aynı desen: aç/kapa, sunucuya yaz, sunucunun yanıtını geri oku).
 *
 * İki iş yapıyor:
 *   1. Düzeni seçtirmek: 50/10 ya da 30/10, kaç tur. Toplam süre anında görünür.
 *   2. MONTAJDAN ÖNCE uyarmak: seçilen müziğin toplamı ile Pomodoro timeline'ı
 *      karşılaştırılıp fazla/eksik gösterilir. Hesabı sunucu yapıyor
 *      (core/pomodoro-plan.js) — burada iki ayrı kural olup birbirinden
 *      sapmasın diye hiçbir süre hesabı tekrarlanmıyor.
 *
 * Fazla müzik kullanıcı onayıyla kırpılır ("Fazlayı kırp" düğmesi
 * `trimExcess` ayarını yazar). Eksik müzikte yapılacak bir şey yok: parça
 * eklenmesi gerekiyor, montaj başlatılmaz.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchProjectPomodoro, updateProjectPomodoro } from '../api';
import { pomodoroPayload, pomodoroSummary } from '../pomodoroSetup';
import { PickerPanel } from './PickerPanel';
import { PomodoroSetup, type PomodoroChoice } from './PomodoroSetup';
import type { ProjectPomodoro, UpdatePomodoroPayload } from '../types';

type PomodoroPickerProps = {
  projectId: string;
  label?: string;
};

/** `mm:ss` — core/pomodoro-plan.js formatClock aynası (dakika saate çevrilmez). */
function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Ekrandaki düğmelerin değeri: ayar yoksa (Pomodoro kapalı) varsayılanlar. */
function choiceOf(data: ProjectPomodoro): PomodoroChoice {
  const current = data.settings ?? { ...data.defaults, preset: null };
  return {
    workMinutes: current.workMinutes,
    breakMinutes: current.breakMinutes,
    rounds: current.rounds,
    sounds: current.countdownBeep && current.workStartSound && current.breakStartSound,
  };
}

export function PomodoroPicker({
  projectId,
  label = 'Pomodoro modu',
}: PomodoroPickerProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectPomodoro | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = setData;

  // Yalnızca kutu açılınca yüklenir: her adım panelinde boşuna istek atılmasın.
  // Her açılışta yeniden okunur — doğrulama ("müzik timeline'a uyuyor mu")
  // aradan geçen müzik değişikliklerine göre tazelensin.
  // Kutu ilk açıldığında yüklenir. Bekleme BİLEŞENİN ömrüne bağlı, effect'in
  // ömrüne değil: ölçüm uzun sürebiliyor (parça süreleri ffprobe ile okunuyor)
  // ve kutu bu arada kapanırsa sonuç eskiden atılıyor, ekran bir daha açılana
  // kadar "Yükleniyor..."da kalıyordu.
  const requested = useRef(false);
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    let mounted = true;
    fetchProjectPomodoro(projectId)
      .then((loaded) => { if (mounted) apply(loaded); })
      .catch((err) => {
        if (!mounted) return;
        requested.current = false; // hata sonrası tekrar denenebilsin
        setError(err instanceof Error ? err.message : 'Pomodoro ayarı yüklenemedi.');
      });
    return () => { mounted = false; };
  }, [open, projectId, apply]);

  // Proje değişirse yeniden okunur.
  useEffect(() => {
    requested.current = false;
    setData(null);
  }, [projectId]);

  /**
   * Ayarı yazar ve sunucunun GÜNCEL doğrulamasını gösterir (iyimser güncelleme
   * yok): tur sayısı değişince "müzik yetiyor mu" cevabı da değişiyor, kullanıcı
   * eski sayılara bakarak montaja girmesin.
   */
  const save = async (changes: Partial<UpdatePomodoroPayload> | null) => {
    if (!data || saving) return;
    setSaving(true);
    setError(null);
    try {
      apply(await updateProjectPomodoro(
        projectId,
        changes === null ? { enabled: false } : pomodoroPayload(data, changes),
      ));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Pomodoro ayarı kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  const settings = data?.settings ?? null;
  const validation = data?.validation;
  const comparison = validation?.comparison ?? null;
  const total = validation?.timeline?.totalMinutes ?? null;

  return (
    <PickerPanel
      label={label}
      badge={
        data
          ? `(${settings ? `${settings.workMinutes}/${settings.breakMinutes} × ${settings.rounds} = ${total} dk` : 'kapalı'})`
          : undefined
      }
      open={open}
      onOpenChange={setOpen}
      actions={
        /* Doğrulama durumu kutuyu açmadan da görünsün. */
        data?.enabled ? (
          <span style={{ fontSize: 12, color: validation?.ok ? 'var(--text-muted)' : 'var(--danger, #c0392b)' }}>
            {validation?.ok ? '✓ Müzik timeline\'a uyuyor' : '⚠ Müzik uymuyor'}
          </span>
        ) : null
      }
    >
        <>
          {error ? <p className="form-error">{error}</p> : null}
          {data === null && !error ? (
            <p className="field-hint">Parça süreleri ölçülüyor...</p>
          ) : null}
          {data?.problems.map((problem) => (
            <p className="form-error" key={problem}>{problem}</p>
          ))}

          {data ? (
            <>
              <p className="field-hint">
                Çalışma/mola oturumları · her oturumdan{' '}
                {settings?.countdownSeconds ?? data.defaults.countdownSeconds} sn önce geri sayım
              </p>

              {/* --- düzen, süre, sesler: proje formuyla AYNI bileşen */}
              <PomodoroSetup
                presets={data.presets}
                isOff={!data.enabled}
                disabled={saving}
                onTurnOff={() => void save(null)}
                value={choiceOf(data)}
                onChange={(next) => void save({
                  workMinutes: next.workMinutes,
                  breakMinutes: next.breakMinutes,
                  rounds: next.rounds,
                  countdownBeep: next.sounds,
                  workStartSound: next.sounds,
                  breakStartSound: next.sounds,
                })}
              />

              {data.enabled && settings ? (
                <>
                  <p className="field-hint" style={{ marginTop: 8 }}>
                    Toplam: <strong>{pomodoroSummary(settings.workMinutes, settings.breakMinutes, settings.rounds)}</strong>
                    {' '}({formatClock(validation?.timeline?.totalSeconds)})
                  </p>

                  {/* --- montaj öncesi karşılaştırma: spec'in asıl istediği ekran */}
                  <div
                    style={{
                      marginTop: 12,
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: `1px solid ${validation?.ok ? 'var(--border-subtle, #333)' : 'var(--danger, #c0392b)'}`,
                      background: 'var(--bg-surface-subtle)',
                    }}
                  >
                    <dl className="readiness-list" style={{ margin: 0 }}>
                      <div>
                        <dt>Pomodoro timeline</dt>
                        <dd>{formatClock(comparison?.timelineSeconds)}</dd>
                      </div>
                      <div>
                        <dt>Müzik toplamı</dt>
                        <dd>
                          {formatClock(comparison?.musicSeconds)}
                          <span className="field-hint"> ({data.music.trackCount} parça)</span>
                        </dd>
                      </div>
                      {comparison?.status === 'excess' ? (
                        <div>
                          <dt>Fazla</dt>
                          <dd>{formatClock(comparison.excessSeconds)}</dd>
                        </div>
                      ) : null}
                      {comparison?.status === 'short' ? (
                        <div>
                          <dt>Eksik</dt>
                          <dd>{formatClock(comparison.shortSeconds)}</dd>
                        </div>
                      ) : null}
                    </dl>

                    {validation?.problems.map((problem) => (
                      <p className="field-hint field-error" key={problem} style={{ marginTop: 8 }}>
                        {problem}
                      </p>
                    ))}
                    {validation?.warnings.map((warning) => (
                      <p className="field-hint" key={warning} style={{ marginTop: 4 }}>
                        ℹ {warning}
                      </p>
                    ))}

                    {validation?.needsTrimConfirmation && validation.trim ? (
                      <div style={{ marginTop: 8 }}>
                        <p className="field-hint">
                          {validation.trim.trimmedCount} parça kısaltılır,{' '}
                          {validation.trim.droppedCount} parça kullanılmaz · dosyalara dokunulmaz
                        </p>
                        <button
                          type="button"
                          className="button button-primary"
                          style={{ fontSize: 12.5, minHeight: 30, padding: '2px 12px' }}
                          onClick={() => void save({ trimExcess: true })}
                          disabled={saving}
                        >
                          ✂ Fazlayı kırp ve devam et
                        </button>
                      </div>
                    ) : null}

                    {settings.trimExcess && comparison?.status === 'excess' ? (
                      <button
                        type="button"
                        className="button"
                        style={{ fontSize: 12, minHeight: 26, padding: '2px 10px', marginTop: 6 }}
                        onClick={() => void save({ trimExcess: false })}
                        disabled={saving}
                      >
                        Kırpma onayını geri al
                      </button>
                    ) : null}
                  </div>

                  {validation?.timeline ? (
                    <details style={{ marginTop: 10 }}>
                      <summary className="field-hint" style={{ cursor: 'pointer' }}>
                        Oturum dökümü ({validation.timeline.sessions.length} oturum,
                        {' '}{validation.cueCount} ses işareti)
                      </summary>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                        {validation.timeline.sessions.map((session) => (
                          <li key={session.index}>
                            <strong>{session.label}</strong>{' '}
                            {formatClock(session.startSeconds)} - {formatClock(session.endSeconds)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </>
    </PickerPanel>
  );
}
