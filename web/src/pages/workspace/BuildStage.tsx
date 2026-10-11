/** 5. adım — Montaj: otomatik işlemler, ilerleme ve başlatma. */
import { useEffect, useState } from 'react';
import { fetchBuildStatus, fetchProject, openProjectFolder, startBuild, ApiError } from '../../api';
import { AmbientPicker } from '../../components/AmbientPicker';
import { PomodoroPicker } from '../../components/PomodoroPicker';
import { paths } from '../../router';
import { StatusBadge } from '../../components/StatusBadge';
import type { BuildJob, ProjectPomodoro } from '../../types';
import { StagePanel, type StageProps } from './StagePanel';

type BuildOpState = 'pending' | 'running' | 'done' | 'failed';

/**
 * "5. Montaj" adımının otomatik işlemleri ve build.js'teki karşılığı (tag).
 * build.js her adım için "[tag] <ad> başlıyor." / "[tag] <ad> bitti: …"
 * yazar; çalışma sırası 01 → 02 → 07 → 03 → 04 → 05 olduğundan durum
 * sıradan bağımsız, satırlardan okunur.
 *
 * Yayın paketi (07) listede: build.js onu her çalışmada üretiyor ve asıl
 * 24/7 yayın çıktısı o. Listede olmadığı sürece yüzde, gerçekte yapılan
 * işin bir bölümünü hiç saymıyordu.
 */
const BUILD_OPERATIONS = [
  { label: "Watermark'ı kırp", tag: '01' },
  { label: 'Video formatını düzelt (16:9 / 9:16)', tag: '01' },
  { label: 'Sesleri birleştir', tag: '02' },
  { label: 'Yayın paketi (24/7 albüm)', tag: '07' },
  { label: 'Arka plan sesi (Ambiance) ekle', tag: '03' },
  { label: 'Videoyu ses süresine uzat', tag: '04' },
  { label: 'Fade işlemlerini uygula', tag: '04' },
  { label: 'Tracklist üret', tag: '05' },
] as const;

const OP_ICON: Record<BuildOpState, string> = { pending: '○', running: '⏳', done: '✓', failed: '✗' };

function buildChecklist(log: string[] = [], state?: string) {
  const has = (tag: string, word: string) => log.some((line) => line.startsWith(`[${tag}]`) && line.includes(word));
  // build.js'in 03 adımını atladığında bastığı satır. Metin oradan geliyor —
  // iki yazım da aranıyor ki eski build loglarının çetelesi de doğru çıksın.
  const ambientSkipped = log.some((line) =>
    line.includes('Ambiance tanımlı değil') || line.includes('Ambient tanımlı değil'));
  // Yayın paketi `stream.enabled: false` ile kapatılabiliyor; kapalıyken 07
  // hiç log basmaz ve satır "atlandı" olarak kalırdı.
  const streamSkipped = log.some((line) => line.includes('Yayın paketi kapalı'));
  const tagState = (tag: string): BuildOpState => {
    if (state === 'succeeded') return 'done';
    if (tag === '07' && streamSkipped) return 'done';
    // Ambient birden fazla karışım olabilir: tracklist başladıysa bitmiştir.
    const finished = tag === '03' ? ambientSkipped || has('05', 'başlıyor') : has(tag, 'bitti');
    if (finished) return 'done';
    if (has(tag, 'başlıyor')) return state === 'failed' ? 'failed' : 'running';
    return 'pending';
  };
  const items = BUILD_OPERATIONS.map((op) => ({ label: op.label, state: tagState(op.tag) }));
  const doneCount = items.filter((item) => item.state === 'done').length;
  const active = items.find((item) => item.state === 'running' || item.state === 'failed');
  const percent = state === 'succeeded' ? 100 : Math.max(5, Math.round((doneCount / items.length) * 100));
  let stepLabel = 'Montaj başlatılıyor...';
  if (state === 'succeeded') stepLabel = 'Montaj tamamlandı';
  else if (state === 'failed') stepLabel = active ? `Montaj başarısız: ${active.label}` : 'Montaj başarısız';
  else if (active) stepLabel = `${active.label} (${doneCount}/${items.length})`;
  return { items, percent, stepLabel };
}

export function BuildStage({ project, assets, stageStatus, onProjectUpdate, onGoToStep }: StageProps) {
  const readiness = project.readiness;
  const isBuildReady = readiness?.build?.ready ?? (assets.assembly === 'ready');
  const missingRequirements = readiness?.build?.missing ?? [];

  // Pomodoro doğrulaması montajın ön koşulu: sunucu da reddediyor (409), ama
  // düğmeyi burada kapatmak kullanıcıyı bir hata turuna sokmadan uyarıyor.
  // Kutu yüklenene kadar (null) montaj engellenmez — Pomodoro kapalı
  // projelerde ekstra bir bekleme olmasın.
  const [pomodoro, setPomodoro] = useState<ProjectPomodoro | null>(null);
  const pomodoroBlocks = pomodoro?.enabled === true && !pomodoro.validation.ok;
  const canBuild = isBuildReady && !pomodoroBlocks;

  const [buildJob, setBuildJob] = useState<BuildJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const rows = [
    { label: 'Video klibi', status: assets.clip },
    { label: 'Müzik', status: assets.music },
  ];

  // Initial fetch of build status
  useEffect(() => {
    let isActive = true;
    fetchBuildStatus(project.id)
      .then((job) => {
        if (!isActive) return;
        setBuildJob(job);
        if (job.state === 'succeeded' && !project.output?.exists) {
          fetchProject(project.id)
            .then((updated) => {
              if (isActive && onProjectUpdate) {
                onProjectUpdate(updated);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        // ignore
      });
    return () => {
      isActive = false;
    };
  }, [project.id, project.output?.exists, onProjectUpdate]);

  // Polling when buildJob is running
  useEffect(() => {
    if (buildJob?.state !== 'running') return;

    let isActive = true;
    const intervalId = setInterval(() => {
      fetchBuildStatus(project.id)
        .then((job) => {
          if (!isActive) return;
          setBuildJob(job);
          if (job.state === 'succeeded') {
            fetchProject(project.id)
              .then((updated) => {
                if (isActive && onProjectUpdate) {
                  onProjectUpdate(updated);
                }
              })
              .catch(() => {
                // ignore
              });
          }
        })
        .catch(() => {
          // ignore
        });
    }, 1500);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [buildJob?.state, project.id, onProjectUpdate]);

  const handleStartBuild = async () => {
    if (isStarting || buildJob?.state === 'running') return;
    if (
      project.output?.exists &&
      !window.confirm('Bu projenin montajlanmış çıktısı zaten var. Yeniden montaj mevcut videonun üzerine yazar. Devam edilsin mi?')
    ) {
      return;
    }
    setIsStarting(true);
    setBuildError(null);

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    try {
      const job = await startBuild(project.id, { overwrite: Boolean(project.output?.exists) });
      setBuildJob(job);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setBuildError(err.message);
      } else {
        setBuildError(err instanceof Error ? err.message : 'Montaj başlatılamadı. Tekrar dene.');
      }
    } finally {
      setIsStarting(false);
    }
  };

  const isRunning = buildJob?.state === 'running';
  const isSucceeded = buildJob?.state === 'succeeded' || (project.output?.exists && !isRunning);
  const progress = buildChecklist(buildJob?.log, buildJob?.state);

  // Ambiance seçili mi — project.json'daki `ambient` üç şekilde yazılabiliyor
  // (tek metin / dizi / { tracks }), üçünü de boş saymadan kontrol et.
  const ambientConfig = project.projectJson?.data?.ambient;
  const ambientMissing =
    ambientConfig === undefined || ambientConfig === null
      ? true
      : typeof ambientConfig === 'string'
        ? ambientConfig.trim() === ''
        : Array.isArray(ambientConfig)
          ? ambientConfig.length === 0
          : (ambientConfig.tracks?.length ?? 0) === 0;

  const videoConfig = project.projectJson?.data?.video;
  const configuredCropBottom = videoConfig?.cropBottom ?? 150;
  const configuredCropTop = videoConfig?.cropTop ?? 0;
  const configuredCropLeft = videoConfig?.cropLeft ?? 0;
  const configuredCropRight = videoConfig?.cropRight ?? 0;
  const hasCrop = (videoConfig?.watermark ?? false) && (configuredCropBottom > 0 || configuredCropTop > 0 || configuredCropLeft > 0 || configuredCropRight > 0);

  const cropDescription = hasCrop
    ? [
        configuredCropBottom > 0 ? `Alt: ${configuredCropBottom}px` : null,
        configuredCropTop > 0 ? `Üst: ${configuredCropTop}px` : null,
        configuredCropLeft > 0 ? `Sol: ${configuredCropLeft}px` : null,
        configuredCropRight > 0 ? `Sağ: ${configuredCropRight}px` : null,
      ].filter(Boolean).join(', ')
    : 'Kırpma yok';

  return (
    <StagePanel section="build" title="4. Montaj" status={assets.assembly} stageStatus={stageStatus}>
      <dl className="readiness-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              <StatusBadge status={row.status} />
            </dd>
          </div>
        ))}
        <div>
          <dt>Video kırpma ve format</dt>
          <dd>
            {cropDescription} → {project.projectJson?.data?.video?.aspect || '16:9'}
          </dd>
        </div>
      </dl>

      {!isBuildReady ? (
        <p className="field-hint">
          ℹ Montaj, gerekli adımlar (Video klibi, Müzik) hazır olunca başlatılabilir.
        </p>
      ) : null}

      {/* Arka plan sesi burada da duruyor: "Ambiance eklemeyi unuttum" asıl
          montaj anında fark ediliyor ve o an 5. adıma dönmek akla gelmiyor.
          Aynı bileşen, aynı uç — iki yerden de aynı seçimi yazar. */}
      {ambientMissing ? (
        <p className="field-hint">
          ⚠ Ambiance seçilmemiş — aşağıdan ekleyebilirsin
        </p>
      ) : null}
      {/* Pomodoro doğrulaması montajın ÖN KOŞULU: fazla/eksik müzik burada,
          Başlat'a basılmadan görünür. Aynı bileşen, aynı uç — iki yerden de
          aynı ayarı yazar. Kapalı başlıyor: "başlatabilir miyim" sorusunun
          cevabı (düzen özeti + ✓/⚠ durumu) kutuyu açmadan başlıkta zaten
          duruyor, açık başlasa dropdown Başlat düğmesinin üstüne binerdi. */}
      <div className="picker-group">
        <PomodoroPicker projectId={project.id} onChange={setPomodoro} />
        <AmbientPicker
          projectId={project.id}
          onManage={() => { window.location.href = paths.ambient; }}
        />
      </div>

      {buildError ? (
        <p className="field-hint field-error" role="alert">
          {buildError}
        </p>
      ) : null}

      {/* Progress bar during build */}
      {isRunning || buildJob?.state === 'failed' ? (
        <div className="build-progress">
          <div className="build-progress-head">
            <span className="build-progress-step">
              {isRunning ? '⏳' : '✗'} {progress.stepLabel}
            </span>
            <span className="build-progress-percent">%{progress.percent}</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <ol className="build-ops">
            {progress.items.map((item) => (
              <li key={item.label} className={`build-op ${item.state}`}>
                <span aria-hidden="true">{OP_ICON[item.state]}</span> {item.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {isSucceeded ? (
        <div className="build-done">
          <div>
            <strong className="build-done-title">✓ Video oluşturuldu</strong>
            <span className="muted">
              Nihai video <code>out/final_ambient.mp4</code> olarak hazırlandı.
            </span>
          </div>
          <div className="build-done-actions">
            <button type="button" className="button button-compact" onClick={() => onGoToStep?.('publish')}>
              Yayın adımına geç
            </button>
            <button type="button" className="button button-compact" onClick={() => openProjectFolder(project.id, 'out')}>
              Çıktı klasörünü aç
            </button>
          </div>
        </div>
      ) : null}

      {buildJob && buildJob.state !== 'idle' ? (
        <div>
          <div className="build-status-row">
            <strong>Montaj durumu:</strong>
            {buildJob.state === 'running' ? (
              <StatusBadge status="processing" label="Çalışıyor" />
            ) : buildJob.state === 'succeeded' ? (
              <StatusBadge status="completed" label="Başarılı" />
            ) : buildJob.state === 'failed' ? (
              <StatusBadge status="failed" label="Başarısız" />
            ) : null}
          </div>

          {buildJob.error ? (
            <p className="field-hint field-error" role="alert">
              {buildJob.error}
            </p>
          ) : null}

          {buildJob.state === 'failed' && buildJob.errorLog && buildJob.errorLog.length > 0 ? (
            <pre className="build-log">{buildJob.errorLog.slice(-15).join('\n')}</pre>
          ) : null}

          {buildJob.log && buildJob.log.length > 0 ? (
            <pre className="build-log">
              {buildJob.log.slice(-10).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="stage-footer">
        <button
          className={project.output?.exists ? 'button' : 'button button-primary'}
          type="button"
          disabled={!canBuild || isRunning || isStarting}
          onClick={handleStartBuild}
        >
          {isRunning
            ? 'Montaj sürüyor...'
            : isStarting
              ? 'Başlatılıyor...'
              : project.output?.exists
                ? 'Yeniden başlat'
                : 'Başlat'}
        </button>

        {!canBuild && !project.output?.exists && !isRunning ? (
          <p className="field-hint">
            {pomodoroBlocks
              ? 'Pomodoro doğrulaması geçmeden montaj başlatılamaz — yukarıdaki kutuya bak.'
              : missingRequirements.length > 0
                ? `Eksik gerekli dosyalar: ${missingRequirements.join(', ')}`
                : 'Ses ve video hazır olunca başlatılabilir.'}
          </p>
        ) : null}
      </div>
    </StagePanel>
  );
}
