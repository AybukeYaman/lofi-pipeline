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
 * Fazla müzik UYARIYLA kendiliğinden kırpılır (soru yok, düğme yok); hiç
 * kullanılmayan parçalar montaj bitince Geri Dönüşüm Kutusu'na taşınır. Eksik
 * müzik de engel değil: ses sessizlikle timeline süresine tamamlanır, kalanı arka
 * plan sesi (Ambiance) doldurur. Yalnızca ölçülemeyen parça montajı durdurur.
 */

import { useEffect, useRef, useState } from 'react';

import { formatClock } from '../../../core/pomodoro-plan.js';
import { fetchProjectPomodoro, updateProjectPomodoro } from '../api';
import {
  pomodoroPayload, pomodoroSummary, setsPayload, type PomodoroChoice,
} from '../pomodoroSetup';
import { PickerPanel } from './PickerPanel';
import { ProgramEditor } from './ProgramEditor';
import type { ProjectPomodoro, UpdatePomodoroPayload } from '../types';

type PomodoroPickerProps = {
  projectId: string;
  label?: string;
  /** Ayar sunucuya yazıldıktan sonra çağrılır (üst ekran projeyi yeniden okusun diye). */
  onSaved?: () => void | Promise<void>;
};

/** Ekrandaki düğmelerin değeri: ayar yoksa (Pomodoro kapalı) varsayılanlar. */
function choiceOf(data: ProjectPomodoro): PomodoroChoice {
  const current = data.settings ?? data.defaults;
  return {
    // Eski dosyalardaki genel "bip kapalı" ayarı adımlara yansır (hepsi sessiz görünür);
    // sonraki kayıtta adım başına yazılır, genel anahtar açık kalır.
    sets: current.countdownBeep
      ? current.sets
      : current.sets.map((set) => ({ ...set, steps: set.steps.map((step) => ({ ...step, beep: false })) })),
    rounds: current.rounds,
  };
}

/**
 * Müzik/süre durumunun kısa metni ve rengi. Uyuyor ✓; fazla ⚠ (montajda kendiliğinden kırpılır);
 * kısa ⚠ (kalan süreyi arka plan sesi doldurur) — ikisi de engel değil, yalnızca ölçülemeyen parça engeller.
 */
function statusText(status: string | undefined, ok: boolean | undefined): string {
  if (!ok) return '⚠ Müzik uymuyor';
  if (status === 'excess') return '⚠ Fazla müzik: montajda otomatik kırpılacak';
  if (status === 'short') return '⚠ Müzik kısa: kalanı arka plan sesiyle devam eder';
  return '✓ Müzik süreye uyuyor';
}

function statusColor(status: string | undefined, ok: boolean | undefined): string {
  if (!ok) return 'var(--danger, #c0392b)';
  return status === 'excess' || status === 'short' ? 'var(--warning, #b7791f)' : 'var(--text-muted)';
}

export function PomodoroPicker({
  projectId,
  label = 'Pomodoro modu',
  onSaved,
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
      await onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Pomodoro ayarı kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  const settings = data?.settings ?? null;
  const validation = data?.validation;
  const comparison = validation?.comparison ?? null;

  return (
    <PickerPanel
      label={label}
      badge={
        data
          ? `(${settings ? pomodoroSummary(settings.statuses, settings.rounds) : 'kapalı'})`
          : undefined
      }
      open={open}
      onOpenChange={setOpen}
      actions={
        /* Doğrulama durumu kutuyu açmadan da görünsün. */
        data?.enabled ? (
          <span style={{ fontSize: 12, color: statusColor(comparison?.status, validation?.ok) }}>
            {statusText(comparison?.status, validation?.ok)}
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
              {/* --- program ve süre: proje formuyla AYNI bileşen (önizleme içinde) */}
              <ProgramEditor
                isOff={!data.enabled}
                disabled={saving}
                onTurnOff={() => void save(null)}
                value={choiceOf(data)}
                onChange={(next) => void save({
                  sets: setsPayload(next.sets),
                  rounds: next.rounds,
                  countdownBeep: true,
                })}
              />

              {data.enabled && settings ? (
                <>
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
                        <dd>{comparison ? formatClock(comparison.timelineSeconds) : '--:--'}</dd>
                      </div>
                      <div>
                        <dt>Müzik toplamı</dt>
                        <dd>
                          {comparison ? formatClock(comparison.musicSeconds) : '--:--'}
                          <span className="field-hint"> ({data.music.trackCount} parça)</span>
                        </dd>
                      </div>
                    </dl>

                    {validation?.problems.map((problem) => (
                      <p className="field-hint field-error" key={problem} style={{ marginTop: 8 }}>
                        {problem}
                      </p>
                    ))}
                    {validation?.warnings.map((warning) => (
                      <p className="field-hint" key={warning} style={{ marginTop: 4 }}>
                        {comparison?.status === 'excess' || comparison?.status === 'short' ? '⚠' : 'ℹ'} {warning}
                      </p>
                    ))}
                  </div>


                </>
              ) : null}
            </>
          ) : null}
        </>
    </PickerPanel>
  );
}
