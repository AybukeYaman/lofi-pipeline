import { execSync, spawn } from 'node:child_process';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { moveFile, resolveDownloadsDir } from '../core/downloads.js';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, listFiles, uniqueFileName } from '../core/files.js';
import {
  POMODORO_PRESETS, formatClock, normalizePomodoroSelection, validatePomodoro,
} from '../core/pomodoro-plan.js';
import { probe } from '../core/probe.js';
import {
  DOWNLOAD_AUDIO_EXTENSIONS, DOWNLOAD_VIDEO_EXTENSIONS,
  RECENT_WINDOW_MINUTES, cleanDownloadName, createDownloadWatcher,
} from '../prep/download-watch.js';
import { AmbientError, listAmbients } from '../prep/ambients.js';
import {
  ProjectFileError, completeMusicByUser, cropForWatermark, recordAudioAdded, setProjectClip, setProjectCropBottom,
  setProjectField, setProjectPomodoro, setVideoSource, videoSourceForClip,
} from '../prep/project-file.js';
import {
  WORKFLOW_STEPS, audioAddedOrder, inspectProject, isMusicCompleted, listProjects, nextStep,
  orderedAudioTracks,
} from '../prep/project-status.js';
import { validateVideoName } from '../prep/scaffold.js';
import { ingestSunoUrl, sanitizeFilename } from '../prep/suno-ingest.js';
import { SunoIngestError } from '../prep/suno-errors.js';

/** Auto Watch: İndirilenler ve audio/ tarama aralığı. */
const DOWNLOAD_POLL_MS = 1000;

export function copyToClipboard(text) {
  try {
    const proc = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    proc.stdin.write(String(text ?? ''));
    proc.stdin.end();
    return true;
  } catch {
    return false;
  }
}

export function openFolder(folderPath) {
  try {
    const child = spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminal UI kutu çizici (ANSI renkli, canonical akış adım numarasıyla).
 * @param {number} stepNumber
 * @param {string} title
 * @param {string|string[]} instructions
 */
export function renderStepBox(stepNumber, title, instructions) {
  const width = 64;
  const top = `┌${'─'.repeat(width)}┐`;
  const bot = `└${'─'.repeat(width)}┘`;
  const header = `│ \x1b[1;36m[Adım ${stepNumber}/${WORKFLOW_STEPS.length}]\x1b[0m \x1b[1;37m${title.padEnd(width - 15)}\x1b[0m │`;
  const div = `├${'─'.repeat(width)}┤`;
  const lines = [top, header, div];
  if (Array.isArray(instructions)) {
    for (const inst of instructions) {
      lines.push(`│ ${inst.padEnd(width - 2)} │`);
    }
  } else if (typeof instructions === 'string') {
    for (const line of instructions.split('\n')) {
      lines.push(`│ ${line.padEnd(width - 2)} │`);
    }
  }
  lines.push(bot);
  return lines.join('\n');
}

/**
 * Seçilen audio dosyalarını projenin audio/ klasörüne kopyalar.
 * Çakışan dosya adı varsa "İsim (1).mp3" şeklinde güvenli kopyalar.
 */
export async function safeCopyAudioFiles(selectedFiles, targetAudioDir, prompter) {
  const copiedFileNames = [];
  const errors = [];

  for (const srcPath of selectedFiles) {
    const targetName = await uniqueFileName(targetAudioDir, basename(srcPath));
    const destPath = join(targetAudioDir, targetName);
    try {
      await copyFile(srcPath, destPath);
      copiedFileNames.push(targetName);
    } catch (err) {
      errors.push({ srcPath, error: err.message });
    }
  }

  if (errors.length > 0 && prompter) {
    for (const e of errors) {
      prompter.print(`\x1b[31m[! Kopyalama Hatası]\x1b[0m ${basename(e.srcPath)} kopyalanamadı: ${e.error}`);
    }
  }

  return copiedFileNames;
}

export function pickAudioFiles(prompter) {
  if (process.platform !== 'win32') return null;
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $dlg = New-Object System.Windows.Forms.OpenFileDialog
      $dlg.Filter = 'Audio Files (*.mp3;*.m4a;*.wav;*.flac;*.ogg)|*.mp3;*.m4a;*.wav;*.flac;*.ogg'
      $dlg.Multiselect = $true
      $dlg.CheckFileExists = $true
      $dlg.CheckPathExists = $true
      if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $dlg.FileNames | ForEach-Object { Write-Output $_ }
      }
    `;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const output = execSync(`powershell -NoProfile -STA -EncodedCommand ${encoded}`, { encoding: 'utf8' });
    const paths = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return paths.length > 0 ? paths : null;
  } catch (err) {
    if (prompter) {
      prompter.print(`\x1b[31m[! Hata]\x1b[0m Windows dosya seçici açılamadı: ${err.message}`);
    }
    return null;
  }
}

/** Oturum hafızası: seçili proje ve projeye göre atlanan/tamamlanan geçici adımlar. */
export function createSession() {
  return { project: null, skipped: new Map() };
}

function skippedFor(session, dir) {
  if (!session.skipped.has(dir)) session.skipped.set(dir, new Set());
  return session.skipped.get(dir);
}

/**
 * Seçili projeyi döndürür; yoksa listeden seçtirir.
 * @returns {Promise<string | null>}
 */
export async function selectProject(ctx, { force = false } = {}) {
  const { prompter, session } = ctx;
  if (session.project && !force && await isFile(join(session.project, 'project.json'))) {
    return session.project;
  }

  const projects = await listProjects(ctx.videosDir);
  if (projects.length === 0) {
    prompter.print(`Proje yok (${ctx.videosDir}). Önce "Create new video".`);
    return null;
  }
  const dir = await prompter.choose(
    'Proje seç (son değişen en üstte):',
    projects.map((p) => ({ label: `${p.name} — ${p.step.title}`, value: p.dir })),
    { zeroLabel: 'Geri' },
  );
  if (dir) session.project = dir;
  return dir;
}

// ============================================================================
// 8 ADIMLI İŞ AKIŞI (prep/project-status.js WORKFLOW_STEPS)
// ============================================================================

/**
 * 1. Adım: Proje Başlat (Otomatik)
 * Kullanıcı verir: proje adı, müzik stili (isteğe bağlı), ambient seçimi
 * Sistem yapar: klasör yapısı + project.json + prompts.md oluşturur
 */
export async function newProject(ctx) {
  const { prompter } = ctx;
  ctx.store?.set({ view: 'new-project' });

  let name;
  for (;;) {
    name = await prompter.ask('Project name (ör. video3-Neo Tokyo Night; Esc = geri)');
    if (!name) return false;
    const problems = validateVideoName(name);
    if (problems.length === 0 && await exists(join(ctx.videosDir, name))) {
      problems.push(`bu isimde klasör zaten var: ${join(ctx.videosDir, name)}`);
    }
    if (problems.length === 0) break;
    for (const problem of problems) prompter.print(`  - ${problem}`);
  }

  const ambients = await ambientsOrEmpty(ctx);
  const ordered = ambients;
  const selectedAmbients = await prompter.chooseMany(
    'Select Ambient (Boşluk ile çoklu seç):',
    ordered.map((a) => ({ label: a.name, value: a.name })),
    { zeroLabel: 'Ambient yok' },
  );

  const ambientArg = selectedAmbients && selectedAmbients.length > 0 ? selectedAmbients.join(',') : null;

  const concept = await prompter.ask('Album Concept (ör. 2:17 AM — Everyone Is Asleep):', { defaultValue: `${name} — Album` });
  const trackCountInput = await prompter.ask('Track Count (üretilecek parça sayısı):', { defaultValue: '17' });
  const totalTracks = parseInt(trackCountInput, 10) || 17;

  let selectedAudioFiles = null;
  for (;;) {
    const musicSource = await prompter.choose('Music Source:', [
      { label: 'Generate music prompts (Suno Music Workflow)', value: 'generate' },
      { label: 'Default music (audio/ klasöründeki sesler)', value: 'default' },
      { label: '🎵 [ Select Audio Files ] - Audio Seç (Native Dialog)', value: 'folder' },
    ], { zeroLabel: 'Geri' });
    if (!musicSource) return false;

    if (musicSource === 'folder') {
      if (typeof ctx.pickAudioFilesFn === 'function') {
        selectedAudioFiles = await ctx.pickAudioFilesFn();
      } else {
        selectedAudioFiles = pickAudioFiles(prompter);
      }
      if (!selectedAudioFiles || selectedAudioFiles.length === 0) {
        prompter.print('\x1b[33m[! Seçim İptal Edildi]\x1b[0m Audio seçilmedi.');
        continue;
      }
    }
    break;
  }

  const confirmStart = await prompter.confirm('🚀 START PRODUCTION? (Üretim akışını otomatik başlat)', { defaultValue: true });
  if (!confirmStart) {
    prompter.print('Vazgeçildi.');
    return false;
  }

  const code = await ctx.run('new-video.js', [
    name,
    ...(ambientArg ? ['--ambient', ambientArg] : []),
    '--concept', concept,
    '--total-tracks', String(totalTracks),
    '--videos-dir', ctx.videosDir, '--ambient-dir', ctx.ambientDir,
  ]);
  if (code !== 0) {
    prompter.print(`Proje oluşturulamadı (çıkış kodu ${code}).`);
    return false;
  }

  const projectDir = join(ctx.videosDir, name);
  ctx.session.project = projectDir;

  if (selectedAudioFiles && selectedAudioFiles.length > 0) {
    const status = await inspectProject(projectDir);
    const copiedNames = await safeCopyAudioFiles(selectedAudioFiles, status.audioDir, prompter);
    if (copiedNames.length > 0) {
      const musicData = status.projectJson.data?.music ?? {};
      if (Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
        for (let i = 0; i < copiedNames.length && i < musicData.tracks.length; i++) {
          musicData.tracks[i].status = 'completed';
          musicData.tracks[i].file = copiedNames[i];
        }
        musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
        musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
        await setProjectField(status.projectPath, 'music', musicData);
      }
    }
  }

  await continueProject(ctx, projectDir);
  return true;
}

/**
 * 4. Adım: Video — kaynağa göre elle üretilen döngü klibi videolar/ altına,
 * tek resim modunda ise görsel resimler/ altına konur. Kaynak burada
 * değiştirilebilir: "resimden yapmıştım, videodan yapayım" kararı montajdan
 * önceki her anda verilebilsin (switchVideoSource).
 */
export async function stepMotionVideo(ctx, dir, status, { pollMs = 50 } = {}) {
  const { prompter } = ctx;
  const vidDir = join(dir, 'videolar');
  await import('node:fs/promises').then((fs) => fs.mkdir(vidDir, { recursive: true }));

  let folderOpen = false;
  let detectedClip = null;

  while (!detectedClip) {
    const cur = await inspectProject(dir);
    if (cur.clips.length > 0) {
      detectedClip = cur.clips[0];
      break;
    }

    // Beklenen dosya moda göre değişir; tek resim modunda videolar\ beklemek
    // kullanıcıyı sonsuza kadar bekletirdi.
    const isStill = cur.videoSource === 'image';
    const assetDir = isStill ? join(dir, 'resimler') : vidDir;
    const assetLabel = isStill ? 'resimler/MASTER.png' : 'videolar/*.mp4';

    ctx.store?.set({
      watchNotice: {
        asset: isStill ? 'Still Image' : 'Looping Video Clip',
        description: isStill
          ? 'Video boyunca ekranda kalacak tek görsel.'
          : 'Ürettiğin döngüsel video klibi (.mp4).',
        folder: isStill ? 'resimler/' : 'videolar/',
        expected: isStill ? 'MASTER.png' : '*.mp4',
        folderOpen,
      },
    });

    const choice = await prompter.choose(
      isStill ? 'STILL IMAGE READY — Ne yapmak istersiniz?' : 'CAMERA / VIDEO CLIP READY — Ne yapmak istersiniz?',
      [
        { label: '📂 [ Klasörü Aç ] - Kaynak Klasörünü Windows\'ta Aç', value: 'open' },
        { label: '🔄 [ Yenile ] - Klasörü Yeniden Tara', value: 'refresh' },
        { label: '⏳ [ Auto Watch ] - Otomatik Dosya Bekle', value: 'watch' },
        {
          label: isStill
            ? '🔀 [ Kaynağı Değiştir ] - Tek resim yerine döngü videosu kullan'
            : '🔀 [ Kaynağı Değiştir ] - Döngü videosu yerine tek resim kullan',
          value: 'source',
        },
        { label: '🏠 Ana Menüye Dön', value: 'menu' },
      ],
    );

    if (!choice || choice === 'menu') {
      ctx.store?.set({ watchNotice: null });
      return 'menu';
    }

    if (choice === 'source') {
      ctx.store?.set({ watchNotice: null });
      // Mod değişti: aday listesi de değişti, döngü baştan ölçsün.
      await switchVideoSource(ctx, dir, isStill ? 'clip' : 'image');
      folderOpen = false;
      continue;
    }

    if (choice === 'open') {
      (ctx.openFolderFn ?? openFolder)(assetDir);
      folderOpen = true;
      ctx.store?.set({ watchNotice: { file: assetLabel, folderOpen: true } });
      prompter.print(`\x1b[32m[📂 Klasör Açıldı]\x1b[0m ${basename(assetDir)}/ klasörü Windows Explorer'da açıldı.`);
    } else if (choice === 'refresh') {
      const updated = await inspectProject(dir);
      if (updated.clips.length > 0) {
        detectedClip = updated.clips[0];
        break;
      }
      prompter.print(`\x1b[33m[! Dosya Henüz Bulunamadı]\x1b[0m ${assetLabel} bekleniyor...`);
    } else if (choice === 'watch') {
      const recentMinutes = await prompter.choose(
        'Auto Watch — İndirilenler\'de ne kadar önce inmiş dosyalar da alınsın?',
        RECENT_WINDOW_MINUTES.map((minutes) => ({ label: `Son ${minutes} dakika`, value: minutes })),
        { zeroLabel: 'Geri' },
      );
      if (!recentMinutes) continue;
      const { detected } = await autoWatchAsset(ctx, {
        targetDir: assetDir,
        extensions: isStill ? IMAGE_EXTENSIONS : DOWNLOAD_VIDEO_EXTENSIONS,
        // Tek resim modunda aday yalnızca MASTER/MasterN adlarıyla sayılır
        // (prep/project-status.js MASTER_PATTERN), inen dosya öyle adlanır.
        nameFor: (src) => (isStill
          ? `MASTER${extname(src).toLowerCase()}`
          : `${sanitizeFilename(cleanDownloadName(basename(src, extname(src))))}${extname(src).toLowerCase()}`),
        recentMinutes,
        pollMs: ctx.downloadPollMs ?? pollMs,
        label: assetLabel,
        folderLabel: isStill ? 'resimler/' : 'videolar/',
        detect: async () => (await inspectProject(dir)).clips[0] ?? null,
      });
      if (detected) detectedClip = detected;
    }
  }

  ctx.store?.set({ watchNotice: null });
  const writtenClip = await setProjectClip(status.projectPath, detectedClip);
  const boundStill = videoSourceForClip(detectedClip) === 'image';
  prompter.print(
    `\x1b[32m[✓ ${boundStill ? 'Görsel' : 'Video Klip'} Algılandı & Bağlandı]\x1b[0m clip = ${writtenClip}`,
  );

  // Watermark yalnızca üretilmiş videolarda sorun; görselde sorulacak bir şey yok.
  if (boundStill) {
    prompter.print('\x1b[32m[✓ Tek resim modu]\x1b[0m Watermark sorusu atlandı, otomatik devam ediliyor...');
    return true;
  }

  const wmChoice = await prompter.choose('WATERMARK CONTROL — Bu videoda watermark var mı?', [
    { label: ' [Hayır, watermark yok] - Alttan kırpma yapma', value: 'no' },
    { label: ' [Evet, watermark var] - Alttan kırpma (watermark crop) uygula', value: 'yes' },
  ]);

  const currentCrop = status.projectJson.data?.video?.cropBottom;
  await setProjectCropBottom(status.projectPath, cropForWatermark(wmChoice === 'yes', currentCrop));

  prompter.print('\x1b[32m[✓ Watermark Kararı Kaydedildi]\x1b[0m Otomatik devam ediliyor...');
  return true;
}

/**
 * Görsel kaynağını değiştirir (`clip` ↔ `image`) — "resimden yapmıştım, videodan
 * yapmak istiyorum".
 *
 * Seçili dosya yeni moda uymuyorsa setVideoSource onu boşaltır; kullanıcı
 * uyarıları görsün diye burada tek tek basılır. Montaj çıktısı silinmez:
 * build.js base.mp4'ü her çalışmada baştan üretir.
 *
 * @param {object} ctx
 * @param {string} dir proje klasörü
 * @param {'clip'|'image'} [target] verilmezse sorulur
 * @returns {Promise<boolean>} yazıldı mı
 */
export async function switchVideoSource(ctx, dir, target = null) {
  const { prompter } = ctx;
  const status = await inspectProject(dir);
  if (!status.projectJson.ok) {
    prompter.print(`project.json okunamadı: ${status.projectJson.error}`);
    return false;
  }

  const current = status.videoSource;
  const candidates = status.videoSourceCandidates;
  let next = target;

  if (!next) {
    const describe = (source) => {
      const { count } = candidates[source];
      const folder = source === 'image' ? 'resimler\\' : 'videolar\\';
      return `${source === 'image' ? 'Tek resim' : 'Döngü videosu'} — ${folder} altında ${count} aday` +
        (source === current ? ' (şu anki)' : '');
    };
    next = await prompter.choose('Görsel kaynağı:', [
      { label: describe('clip'), value: 'clip' },
      { label: describe('image'), value: 'image' },
    ], { zeroLabel: 'Geri' });
    if (!next) return false;
  }

  if (next === current) {
    prompter.print(`Kaynak zaten "${current}" — değişiklik yapılmadı.`);
    return false;
  }

  try {
    const result = await setVideoSource(status.projectPath, next);
    prompter.print(`\x1b[32m[✓ Kaynak Değişti]\x1b[0m video.source: ${result.previous} → ${result.source}`);
    for (const warning of result.warnings) prompter.print(`\x1b[33m[!]\x1b[0m ${warning}`);
    if (candidates[next].count === 0) {
      prompter.print(`\x1b[33m[!]\x1b[0m ${candidates[next].dir} boş — dosyayı koyduktan sonra "Yenile" ile taranır.`);
    }
    return true;
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    prompter.print(error.message);
    return false;
  }
}

/**
 * 5. Adım: Müzik
 */
export async function stepMusic(ctx, dir, status, { pollMs = 50 } = {}) {
  const { prompter } = ctx;
  const musicData = status.projectJson.data?.music;

  // Track planlı müzik akışı
  if (musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
    const pendingTrack = musicData.tracks.find((t) => t.status === 'pending');
    if (pendingTrack) {
      let folderOpen = false;
      let detectedFile = null;
      let autoWatched = false;
      const completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;

      while (!detectedFile) {
        const cur = await inspectProject(dir);
        if (cur.audioCount > completedCount) {
          const files = await listFiles(status.audioDir, AUDIO_EXTENSIONS).catch(() => []);
          if (files.length > completedCount) {
            detectedFile = basename(files[files.length - 1]);
            break;
          }
        }

        ctx.store?.set({
          view: 'music',
          musicState: {
            concept: musicData.concept,
            currentTrack: pendingTrack,
            completedCount: musicData.tracks.filter((t) => t.status === 'completed').length,
            totalTracks: musicData.totalTracks,
            tracks: musicData.tracks,
          },
          watchNotice: { file: `audio/ (Track ${String(pendingTrack.number).padStart(2, '0')}: "${pendingTrack.title}")`, folderOpen },
        });

        const choice = await prompter.choose(`TRACK ${String(pendingTrack.number).padStart(2, '0')} READY: "${pendingTrack.title}"`, [
          { label: '🌐 [ Paste Public Suno Link ] - Suno Linki Yapıştır (Otomatik İndir)', value: 'suno' },
          { label: '🎵 [ Select Audio Files ] - Audio Seç (Native Dialog)', value: 'select' },
          { label: '📋 [ Copy Prompt ] - Suno Promptunu Kopyala', value: 'copy' },
          { label: '📂 [ Open Music Folder ] - Müzik Klasörünü Windows\'ta Aç', value: 'open' },
          { label: '🔄 [ Refresh ] - Klasörü Yeniden Tara', value: 'refresh' },
          { label: '👁 [ View Prompt ] - Prompt Overlay Aç', value: 'view' },
          { label: '⏳ [ Auto Watch ] - MP3 Bekle', value: 'watch' },
          ...(musicData.tracks.some((t) => t.status === 'completed')
            ? [{ label: '⏭ [ Finish Music & Continue ] - Müzik Aşamasını Bitir ve Devam Et', value: 'finish' }]
            : []),
          { label: '🏠 Ana Menüye Dön', value: 'menu' },
        ]);

        if (!choice || choice === 'menu') {
          ctx.store?.set({ watchNotice: null });
          return 'menu';
        }

        if (choice === 'suno') {
          const sunoUrl = await prompter.ask('Suno URL (Public, Unlisted veya Hook Linki; Esc = geri):');
          if (sunoUrl) {
            prompter.print('\x1b[36m[🌐 Suno İndirme Başlatılıyor...]\x1b[0m Metadata ve MP3 çekiliyor...');
            try {
              const ingestResult = await ingestSunoUrl({ url: sunoUrl, outputDir: status.audioDir });
              await recordAudioAdded(status.projectPath, ingestResult.tracks.map((t) => basename(t.localPath)));
              if (ingestResult.tracks.length > 0) {
                const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
                const count = Math.min(ingestResult.tracks.length, pendingTracks.length);
                for (let i = 0; i < count; i++) {
                  pendingTracks[i].status = 'completed';
                  pendingTracks[i].file = basename(ingestResult.tracks[i].localPath);
                }
                musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
                musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
                await setProjectField(status.projectPath, 'music', musicData);

                prompter.print(`\x1b[32m[✓ Suno İndirme Tamamlandı]\x1b[0m ${ingestResult.tracks.length} parça indirildi.`);
                return true;
              }
            } catch (err) {
              prompter.print(`\x1b[31m[! Suno İndirme Hatası]\x1b[0m ${err.message}`);
            }
          }
        } else if (choice === 'select') {
          let selectedFiles = null;
          if (typeof ctx.pickAudioFilesFn === 'function') {
            selectedFiles = await ctx.pickAudioFilesFn();
          } else {
            selectedFiles = pickAudioFiles(prompter);
          }

          if (selectedFiles && selectedFiles.length > 0) {
            const copiedNames = await safeCopyAudioFiles(selectedFiles, status.audioDir, prompter);
            if (copiedNames.length > 0) {
              const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
              const count = Math.min(copiedNames.length, pendingTracks.length);
              for (let i = 0; i < count; i++) {
                pendingTracks[i].status = 'completed';
                pendingTracks[i].file = copiedNames[i];
              }
              musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
              musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
              await setProjectField(status.projectPath, 'music', musicData);

              prompter.print(`\x1b[32m[✓ ${copiedNames.length} Audio Seçildi & Aktarıldı]\x1b[0m ${copiedNames.join(', ')}`);
              return true;
            }
          } else {
            prompter.print('\x1b[33m[! Seçim İptal Edildi]\x1b[0m Audio seçilmedi.');
          }
        } else if (choice === 'finish') {
          if (await finishMusicStage(ctx, { status, musicData })) return true;
        } else if (choice === 'open') {
          (ctx.openFolderFn ?? openFolder)(status.audioDir);
          folderOpen = true;
          ctx.store?.set({
            watchNotice: { file: `audio/ (Track ${String(pendingTrack.number).padStart(2, '0')}: "${pendingTrack.title}")`, folderOpen: true },
          });
          prompter.print('\x1b[32m[📂 Müzik Klasörü Açıldı]\x1b[0m MP3 dosyanızı bu klasöre kaydedin.');
        } else if (choice === 'refresh') {
          const updated = await inspectProject(dir);
          if (updated.audioCount > completedCount) {
            const files = await listFiles(status.audioDir, AUDIO_EXTENSIONS).catch(() => []);
            if (files.length > completedCount) {
              detectedFile = basename(files[files.length - 1]);
              break;
            }
          }
          prompter.print('\x1b[33m[! Ses Dosyası Henüz Bulunamadı]\x1b[0m audio/ klasörü taranıyor...');
        } else if (choice === 'copy') {
          copyToClipboard(pendingTrack.prompt);
          prompter.print(`\x1b[32m[✓] Track ${pendingTrack.number} promptu panoya kopyalandı!\x1b[0m`);
        } else if (choice === 'view') {
          ctx.store?.set({ promptDetail: { title: `Track ${pendingTrack.number}: ${pendingTrack.title}`, content: pendingTrack.prompt } });
          await prompter.choose('Prompt Overlay', [{ label: 'Overlay Kapat', value: 'close' }]);
          ctx.store?.set({ promptDetail: null });
        } else if (choice === 'watch') {
          const recentMinutes = await prompter.choose(
            'Auto Watch — İndirilenler\'de ne kadar önce inmiş dosyalar da alınsın?',
            RECENT_WINDOW_MINUTES.map((minutes) => ({ label: `Son ${minutes} dakika`, value: minutes })),
            { zeroLabel: 'Geri' },
          );
          if (!recentMinutes) continue;
          const { finishRequested } = await autoWatchMusic(ctx, { status, musicData, recentMinutes, pollMs: ctx.downloadPollMs ?? DOWNLOAD_POLL_MS });
          if (finishRequested) await finishMusicStage(ctx, { status, musicData });
          autoWatched = true;
          return true;
        }
      }

      if (autoWatched) return true;

      if (detectedFile) {
        await markTrackCompleted(ctx, { status, musicData, track: pendingTrack, file: detectedFile });
        return true;
      }
    }
  }

  // Standart / Plansız müzik akışı
  let folderOpen = false;
  let audioDetected = false;

  while (!audioDetected) {
    const cur = await inspectProject(dir);
    if (cur.audioCount > 0) {
      audioDetected = true;
      break;
    }

    ctx.store?.set({
      watchNotice: {
        asset: 'Music Audio File(s)',
        description: 'Albüm videosu için kullanılacak ses parçaları (.mp3, .m4a, .wav).',
        folder: 'audio/',
        expected: '*.mp3 | *.m4a | *.wav',
        folderOpen,
      },
    });
    const musicSource = await prompter.choose('Which music do you want to use?', [
      { label: '🎵 [ Select Audio Files ] - Audio Seç (Native Dialog)', value: 'folder' },
      { label: '📂 [ Klasörü Aç ] - Müzik Klasörünü Windows\'ta Aç', value: 'open' },
      { label: '🔄 [ Refresh ] - Klasörü Yeniden Tara', value: 'refresh' },
      { label: '⏳ [ Auto Watch ] - Default music (İndirilenler ve audio/ izlensin)', value: 'default' },
      { label: '⏱ [ Pomodoro Modu ] - Çalışma/mola oturumları ve süre kontrolü', value: 'pomodoro' },
      { label: '🏠 Ana Menüye Dön', value: 'menu' },
    ]);

    if (!musicSource || musicSource === 'menu') {
      ctx.store?.set({ watchNotice: null });
      return 'menu';
    }

    if (musicSource === 'pomodoro') {
      // Pomodoro müzik adımında: kaç dakika parça gerektiği, parçalar
      // eklenmeden önce bilinmeli.
      await stepPomodoro(ctx, dir, status);
    } else if (musicSource === 'open') {
      (ctx.openFolderFn ?? openFolder)(status.audioDir);
      folderOpen = true;
      ctx.store?.set({ watchNotice: { file: 'audio/*.mp3|m4a|wav', folderOpen: true } });
      prompter.print('\x1b[32m[📂 Klasör Açıldı]\x1b[0m Müzik klasörü Windows Explorer\'da açıldı.');
    } else if (musicSource === 'refresh') {
      const updated = await inspectProject(dir);
      if (updated.audioCount > 0) {
        audioDetected = true;
        break;
      }
      prompter.print('\x1b[33m[! Müzik Dosyası Henüz Bulunamadı]\x1b[0m audio/ bekleniyor...');
    } else if (musicSource === 'default') {
      const recentMinutes = await prompter.choose(
        'Auto Watch — İndirilenler\'de ne kadar önce inmiş dosyalar da alınsın?',
        RECENT_WINDOW_MINUTES.map((minutes) => ({ label: `Son ${minutes} dakika`, value: minutes })),
        { zeroLabel: 'Geri' },
      );
      if (!recentMinutes) continue;
      const { detected } = await autoWatchAsset(ctx, {
        targetDir: status.audioDir,
        extensions: DOWNLOAD_AUDIO_EXTENSIONS,
        nameFor: (src) => `${sanitizeFilename(cleanDownloadName(basename(src, extname(src))))}${extname(src).toLowerCase()}`,
        recentMinutes,
        pollMs: ctx.downloadPollMs ?? pollMs,
        label: 'audio/*.mp3',
        folderLabel: 'audio/',
        detect: async () => (await inspectProject(dir)).audioCount > 0,
      });
      if (detected) audioDetected = true;
    } else if (musicSource === 'folder') {
      let selectedFiles = null;
      if (typeof ctx.pickAudioFilesFn === 'function') {
        selectedFiles = await ctx.pickAudioFilesFn();
      } else {
        selectedFiles = pickAudioFiles(prompter);
      }

      if (selectedFiles && selectedFiles.length > 0) {
        const copiedNames = await safeCopyAudioFiles(selectedFiles, status.audioDir, prompter);
        if (copiedNames.length > 0) {
          audioDetected = true;
          prompter.print(`\x1b[32m[✓ ${copiedNames.length} Audio Seçildi & Aktarıldı]\x1b[0m ${status.audioDir}`);
          break;
        }
      } else {
        prompter.print('\x1b[33m[! Seçim İptal Edildi]\x1b[0m Audio seçilmedi.');
      }
    }
  }

  if (audioDetected) {
    ctx.store?.set({ watchNotice: null });
    prompter.print('\x1b[32m[✓ Müzik Dosyası Algılandı]\x1b[0m Otomatik devam ediliyor...');
    return true;
  }
  return true;
}

/**
 * Projedeki Pomodoro durumu: ayar + MONTAJ ÖNCESİ doğrulama.
 *
 * Hesabın tamamı `core/pomodoro-plan.js`'te; burası yalnızca parçaları
 * build'in çalacağı sırayla ölçüp o fonksiyona veriyor. Sıra kuralı
 * `steps/02-audio-concat.js` ile aynı kaynaktan (`order` → matchOrder).
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} status
 * @param {{ probeFn?: typeof probe }} [options]
 */
export async function inspectPomodoro(status, { probeFn = probe } = {}) {
  const { plan, problems } = normalizePomodoroSelection(status.projectJson.data?.pomodoro);
  const tracks = await orderedAudioTracks(status, { probeFn });

  // Süreler ffprobe başlığından; build çözülen örnek sayısını kullanıyor
  // (dosya başına 13-27 ms fark). Tolerans parça sayısıyla büyüyor ki panel
  // "eksik" derken build "tam" demesin.
  return {
    ...validatePomodoro({ plan, tracks, tolerance: Math.max(1, tracks.length * 0.05) }),
    settingsProblems: problems,
  };
}

/** Panelde Pomodoro özetinin tek satırı. */
function pomodoroLine(check) {
  if (!check.enabled) return 'Pomodoro: kapalı';
  const { plan, timeline } = check;
  return (
    `Pomodoro: ${plan.workMinutes}/${plan.breakMinutes} × ${plan.rounds} tur = ` +
    `${formatClock(timeline.totalSeconds)} (${check.ok ? 'müzik uyuyor' : 'müzik uymuyor'})`
  );
}

/**
 * Pomodoro ayar ekranı — düzen, tur sayısı ve fazla müzik onayı.
 *
 * Web'deki `PomodoroPicker` ile aynı uçlara değil ama aynı domain
 * fonksiyonlarına bağlı (`setProjectPomodoro` + `validatePomodoro`), bu yüzden
 * iki arayüz hiçbir zaman farklı bir sonuç gösteremiyor.
 *
 * @returns {Promise<'menu'|true>}
 */
export async function stepPomodoro(ctx, dir, status, { probeFn = probe } = {}) {
  const { prompter } = ctx;

  for (;;) {
    const current = await inspectProject(dir);
    const check = await inspectPomodoro(current, { probeFn });

    prompter.print(renderStepBox(0, 'Pomodoro Modu', [
      pomodoroLine(check),
      ...(check.enabled ? [check.message ?? ''] : [
        'Kapalıyken video bugünkü gibi kurulur: müzik baştan sona düz akar.',
      ]),
      ...check.settingsProblems.map((problem) => `! ${problem}`),
      ...check.problems.map((problem) => `! ${problem}`),
      ...check.warnings.map((warning) => `i ${warning}`),
    ]));

    const choice = await prompter.choose('Pomodoro — Ne yapmak istersiniz?', [
      { label: '⏹ [ KAPALI ] - Pomodoro kullanma (bugünkü düz akış)', value: 'off' },
      ...POMODORO_PRESETS.map((preset) => ({
        label: `⏱ [ ${preset.workMinutes} / ${preset.breakMinutes} ] - ${preset.workMinutes} dk çalışma + ${preset.breakMinutes} dk mola`,
        value: `preset:${preset.id}`,
      })),
      ...(check.enabled ? [{ label: '🔁 [ Tur Sayısı ] - Kaç tur çalışsın', value: 'rounds' }] : []),
      ...(check.needsTrimConfirmation
        ? [{ label: '✂ [ Fazlayı Kırp ] - Fazla müziği timeline\'a sığdır (orijinal dosyalar değişmez)', value: 'trim' }]
        : []),
      { label: '← Geri', value: 'back' },
    ]);

    if (!choice || choice === 'back') return 'menu';

    try {
      if (choice === 'off') {
        await setProjectPomodoro(current.projectPath, null);
        prompter.print('\x1b[32m[✓ Pomodoro Kapatıldı]\x1b[0m Montaj bugünkü düz akışla çalışacak.');
        return true;
      }

      if (choice === 'trim') {
        await setProjectPomodoro(current.projectPath, { ...toSettings(check.plan), trimExcess: true });
        prompter.print('\x1b[32m[✓ Kırpma Onaylandı]\x1b[0m Fazla süre yalnızca montajda kesilecek.');
        continue;
      }

      if (choice === 'rounds') {
        const rounds = await prompter.choose('Kaç tur?', [2, 4, 6, 8].map((n) => ({
          label: `${n} tur — ${formatClock((check.plan.workMinutes + check.plan.breakMinutes) * 60 * n)}`,
          value: n,
        })), { zeroLabel: 'Geri' });
        if (!rounds) continue;
        // Tur değişince eski kırpma onayı taşınmaz: fazlanın miktarı değişti,
        // kullanıcı yeni sayıyı görüp yeniden onaylasın.
        await setProjectPomodoro(current.projectPath, { ...toSettings(check.plan), rounds, trimExcess: false });
        continue;
      }

      const preset = POMODORO_PRESETS.find((p) => `preset:${p.id}` === choice);
      await setProjectPomodoro(current.projectPath, {
        ...(check.enabled ? toSettings(check.plan) : {}),
        enabled: true,
        preset: preset.id,
        workMinutes: preset.workMinutes,
        breakMinutes: preset.breakMinutes,
        trimExcess: false,
      });
    } catch (error) {
      if (!(error instanceof ProjectFileError)) throw error;
      prompter.print(`\x1b[31m[! Pomodoro Ayarı Yazılamadı]\x1b[0m ${error.message}`);
      return 'menu';
    }
  }
}

/** Plandan setProjectPomodoro'nun beklediği sade ayar nesnesi. */
function toSettings(plan) {
  return {
    enabled: true,
    workMinutes: plan.workMinutes,
    breakMinutes: plan.breakMinutes,
    rounds: plan.rounds,
    countdownSeconds: plan.countdownSeconds,
    countdownBeep: plan.countdownBeep,
    workStartSound: plan.workStartSound,
    breakStartSound: plan.breakStartSound,
    trimExcess: plan.trimExcess,
    cue: plan.cue,
  };
}

/**
 * 6. Adım: Sıralama
 */
export async function stepOrdering(ctx, dir, status) {
  const { prompter } = ctx;
  const files = await listFiles(status.audioDir, AUDIO_EXTENSIONS).catch(() => []);
  if (files.length === 0) return true;

  const baseNames = files.map((f) => basename(f));

  prompter.print(renderStepBox(6, 'Parça Sıralaması', [
    `Bulunan Parçalar (Toplam ${baseNames.length} adet):`,
    ...baseNames.slice(0, 8).map((name, i) => `  ${i + 1}. ${name}`),
    baseNames.length > 8 ? `  ... ve ${baseNames.length - 8} parça daha` : '',
  ]));

  const choice = await prompter.choose('Sıralama Tercihi — Ne yapmak istersiniz?', [
    { label: '✓ [ Mevcut Sırayı Onayla ] - Dosya isimlerindeki mevcut sırayı koru', value: 'keep' },
    { label: '📥 [ Eklediğim Sıra ] - Parçaları klasöre eklediğim sırayla diz', value: 'added' },
    { label: '🔤 [ Alfabetik Sırala ] - Parçaları A\'dan Z\'ye alfabetik sırala', value: 'alphabetical' },
    { label: '📝 [ Elle Sıralama ] - Sıra numaralarını tek tek belirle', value: 'manual' },
    { label: '🏠 Ana Menüye Dön', value: 'menu' },
  ]);

  if (!choice || choice === 'menu') return 'menu';

  let orderList = [...baseNames];

  if (choice === 'added') {
    orderList = await audioAddedOrder(status);
  } else if (choice === 'alphabetical') {
    const confirmAlpha = await prompter.confirm('⚠️ Uyarı: Albüm sırası alfabetik olmayabilir. Alfabetik sıralansın mı?', { defaultValue: true });
    if (!confirmAlpha) return 'menu';
    orderList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } else if (choice === 'manual') {
    prompter.print('\nParçaları sıralamak için sıra numaralarını virgülle ayırarak girin (ör. 2, 1, 3):');
    baseNames.forEach((n, i) => prompter.print(`  [${i + 1}] ${n}`));
    const orderInput = await prompter.ask('Sıralama:');
    if (orderInput) {
      const indexes = orderInput.split(/[, ]+/).map((s) => parseInt(s.trim(), 10) - 1).filter((i) => i >= 0 && i < baseNames.length);
      if (indexes.length === baseNames.length) {
        orderList = indexes.map((i) => baseNames[i]);
      } else {
        prompter.print('\x1b[33m[! Geçersiz Giriş]\x1b[0m Mevcut sıra korundu.');
      }
    }
  }

  await setProjectField(status.projectPath, 'order', orderList);
  prompter.print(`\x1b[32m[✓ Parça Sıralaması Kaydedildi]\x1b[0m ${orderList.length} parça sıralandı.`);
  return true;
}

/**
 * 7. Adım: Montaj
 */
export async function stepMontage(ctx, dir, status, { forceOverwrite = false, probeFn = probe } = {}) {
  const { prompter } = ctx;
  const overwrite = forceOverwrite || status.output.exists;

  if (overwrite && !forceOverwrite) {
    const confirmOverwrite = await prompter.confirm(`Çıktı zaten var: ${status.output.path}\nÜzerine yazılsın mı?`, { defaultValue: true });
    if (!confirmOverwrite) return false;
  }

  // Pomodoro doğrulaması montajın ÖN KOŞULU: build.js da aynı denetimi
  // yapıyor, ama kullanıcıyı boşuna başlayan bir montajla bekletmemek için
  // burada duruyoruz.
  const pomodoro = await inspectPomodoro(status, { probeFn });

  prompter.print(renderStepBox(7, 'Montaj (Build Automation)', [
    `Klip: ${status.clip.value || 'videolar/*.mp4'}`,
    `Parça Sayısı: ${status.audioCount} adet`,
    `Ambient: ${status.projectJson.data?.ambient || 'none'}`,
    pomodoroLine(pomodoro),
    'Sistem: Watermark kırpma, ses birleştirme, ambient miksaj ve tracklist üretimini başlatıyor...',
  ]));

  if (!pomodoro.ok) {
    prompter.print(`\x1b[31m[! Pomodoro Doğrulaması Geçmedi]\x1b[0m\n${pomodoro.message}`);
    for (const problem of pomodoro.problems) prompter.print(`  - ${problem}`);
    const fix = await prompter.confirm('Pomodoro ayarlarını şimdi açayım mı?', { defaultValue: true });
    if (fix) await stepPomodoro(ctx, dir, status);
    return false;
  }
  for (const warning of pomodoro.warnings) {
    prompter.print(`\x1b[33m[i]\x1b[0m ${warning}`);
  }

  prompter.print('\n\x1b[33m[Montaj Başlatılıyor...]\x1b[0m build.js çalışıyor...');
  const code = await ctx.run('build.js', ['--project', status.projectPath, ...(overwrite ? ['--overwrite'] : [])]);
  if (code !== 0) {
    prompter.print(`\x1b[31m[! Montaj Başarısız]\x1b[0m Çıkış kodu: ${code}`);
    return false;
  }

  prompter.print('\x1b[32m[✓ Montaj Başarıyla Tamamlandı!]\x1b[0m');
  return true;
}

/**
 * 8. Adım: Yayın
 */
export async function stepPublish(ctx, dir, status) {
  const { prompter } = ctx;
  const tracklistFile = join(dir, 'out', 'tracklist.txt');
  let tracklistText = '';
  try {
    tracklistText = await readFile(tracklistFile, 'utf8');
  } catch {
    tracklistText = '00:00 - Tracklist dosyası out/tracklist.txt içinde bulunamadı.';
  }

  prompter.print(renderStepBox(8, 'Yayın & YouTube Açıklaması', [
    `Final Video Hazır: ${join(dir, 'out', 'final_ambient.mp4')}`,
    'YouTube\'a yükle, aşağıdaki tracklist\'i açıklamaya yapıştır!',
  ]));

  prompter.print('\n\x1b[1;36m=== YOUTUBE TRACKLIST AÇIKLAMASI ===\x1b[0m\n' + tracklistText.trim() + '\n');

  const choice = await prompter.choose('Yayın Seçenekleri:', [
    { label: '📋 [ Tracklist\'i Kopyala ] - YouTube açıklama metnini panoya kopyala', value: 'copy' },
    { label: '📂 [ Çıktı Klasörünü Aç ] - out/ klasörünü Windows Explorer\'da aç', value: 'open' },
    { label: '▶ [ Videoyu Oynat ] - final_ambient.mp4 dosyasını varsayılan oynatıcıda aç', value: 'play' },
    { label: '🔄 [ Yeniden Montaj Yap ] - Ayarları değiştirip tekrar derle', value: 'rebuild' },
    { label: '🏠 Ana Menüye Dön', value: 'menu' },
  ]);

  if (choice === 'copy') {
    copyToClipboard(tracklistText.trim());
    prompter.print('\x1b[32m[✓ Tracklist panoya kopyalandı!]\x1b[0m');
  } else if (choice === 'open') {
    (ctx.openFolderFn ?? openFolder)(join(dir, 'out'));
    prompter.print('\x1b[32m[📂 out/ Klasörü Açıldı]\x1b[0m');
  } else if (choice === 'play') {
    const videoPath = join(dir, 'out', 'final_ambient.mp4');
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', videoPath], { detached: true, stdio: 'ignore' });
      child.unref();
      prompter.print('\x1b[32m[▶ Video Başlatıldı]\x1b[0m');
    } catch {}
  } else if (choice === 'rebuild') {
    return 'rebuild';
  }

  return 'menu';
}

/**
 * Kaldığı Yerden Devam (Otomatik Adım Tespiti & Sıralı Akış)
 */
export async function continueProject(ctx, targetDir = null, { pollMs = 50 } = {}) {
  const { prompter } = ctx;
  const dir = targetDir || await selectProject(ctx);
  if (!dir) return;

  const skipped = skippedFor(ctx.session, dir);
  ctx.session.project = dir;
  ctx.store?.set({ view: 'project' });

  for (;;) {
    const status = await inspectProject(dir);
    const step = nextStep(status, { skipped });

    // Otomatik klip bağlama
    if (!status.clip.exists && status.clips.length > 0) {
      const autoClip = status.clips[0];
      try {
        const writtenClip = await setProjectClip(status.projectPath, autoClip);
        prompter.print(`\x1b[32m[✓ Otomatik Klip Bulundu]\x1b[0m clip = ${writtenClip}`);
        status.clip.exists = true;
        status.clip.value = writtenClip;
        status.clip.path = autoClip;
      } catch (e) {
        prompter.print(`Klip otomatik eklenemedi: ${e.message}`);
      }
    }

    // Store state güncelle
    ctx.store?.set({
      view: step.id === 'audio' && status.projectJson.data?.music?.tracks?.length ? 'music' : 'project',
      projectStatus: {
        name: status.name,
        dir: status.projectPath,
        ambient: status.projectJson.data?.ambient ?? 'none',
        clip: status.clip,
        clips: status.clips,
        audioCount: status.audioCount,
        musicStatus: status.projectJson.data?.music?.status,
        musicCompletedCount: status.projectJson.data?.music?.completedCount ?? (status.projectJson.data?.music?.tracks ? status.projectJson.data?.music?.tracks.filter((t) => t.status === 'completed').length : 0),
        musicTotalTracks: status.projectJson.data?.music?.totalTracks ?? 17,
        output: status.output,
        currentStep: step.id,
      },
    });

    // 5. ADIM: Müzik
    if (step.id === 'audio') {
      const res = await stepMusic(ctx, dir, status, { pollMs });
      if (res === 'menu' || res === false) return;
      continue;
    }

    // 4. ADIM: Video Klip
    if (step.id === 'faz3' || step.id === 'clip') {
      const res = await stepMotionVideo(ctx, dir, status, { pollMs });
      if (res === 'menu' || res === false) return;
      continue;
    }

    // 7. ADIM: Montaj
    if (step.id === 'build' || step.kind === 'auto') {
      ctx.store?.set({ watchNotice: { file: 'Montaj Yapılıyor (build.js)...', folderOpen: false } });
      prompter.print('\n\x1b[33m[Montaj Başlatılıyor...]\x1b[0m build.js otomasyonu çalışıyor.');
      const code = await ctx.run('build.js', ['--project', status.projectPath, ...(status.output.exists ? ['--overwrite'] : [])]);
      ctx.store?.set({ watchNotice: null });
      if (code !== 0) {
        prompter.print(`Montaj başarısız (çıkış kodu ${code}).`);
        return;
      }
      continue;
    }

    // 8. ADIM: Bitiş & Yayın
    if (step.kind === 'done') {
      ctx.store?.set({ watchNotice: null });
      const tracklistFile = join(dir, 'out', 'tracklist.txt');
      let tracklistText = '';
      try {
        tracklistText = await readFile(tracklistFile, 'utf8');
      } catch {}

      ctx.store?.set({
        view: 'done',
        doneState: {
          name: status.name,
          output: status.output?.path,
          tracklist: tracklistText.trim(),
        },
      });

      await prompter.choose('🎉 PRODUCTION COMPLETE! Video ve Tracklist hazır.', [{ label: 'Ana Menüye Dön', value: 'menu' }]);
      return;
    }
  }
}

/** 4) Klibi seç → project.json clip. */
export async function chooseClip(ctx, dir) {
  const { prompter } = ctx;
  const status = await inspectProject(dir);
  if (status.clips.length === 0) {
    prompter.print(`Klip yok — .mp4 dosyasını şuraya koy: ${join(dir, 'videolar')}`);
    return false;
  }

  const label = (path) => basename(path) + (path === status.clip.path ? ' (şu anki)' : '');
  let clip;
  if (status.clips.length === 1) {
    clip = status.clips[0];
  } else {
    clip = await prompter.choose('Klip seç:', status.clips.map((p) => ({ label: label(p), value: p })), { zeroLabel: 'Geri' });
    if (!clip) return false;
  }

  try {
    prompter.print(`clip = ${await setProjectClip(status.projectPath, clip)}`);
    return true;
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    prompter.print(error.message);
    return false;
  }
}

/** 5) Montaj: (çıktı varsa üzerine yaz?) → build.js */
export async function buildProject(ctx, dir) {
  const { prompter } = ctx;
  const status = await inspectProject(dir);
  if (!status.projectJson.ok) {
    prompter.print(`project.json okunamadı: ${status.projectJson.error}`);
    return false;
  }

  const overwrite = status.output.exists;
  if (overwrite && !await prompter.confirm(`Çıktı zaten var: ${status.output.path}\nÜzerine yazılsın mı?`)) {
    prompter.print('Vazgeçildi.');
    return false;
  }

  const code = await ctx.run('build.js', ['--project', status.projectPath, ...(overwrite ? ['--overwrite'] : [])]);
  prompter.print(code === 0 ? 'Montaj bitti.' : `Montaj başarısız (çıkış kodu ${code}).`);
  return code === 0;
}

/** Toplu montaj */
export async function batchBuild(ctx) {
  const { prompter } = ctx;
  const projects = await listProjects(ctx.videosDir);
  const ready = projects.filter((p) => p.step.id === 'build');
  const done = projects.filter((p) => p.step.id === 'done');
  const notReady = projects.length - ready.length - done.length;

  if (notReady > 0) {
    prompter.print(`Montaja hazır olmayan ${notReady} proje listelenmedi (sıradaki adımları için: Proje durumu).`);
  }
  if (ready.length === 0) {
    prompter.print('Montaja hazır proje yok.');
    return false;
  }

  const selected = await prompter.chooseMany('Montaja hazır projeleri seç:', [
    ...ready.map((p) => ({ label: `${p.name} — ${p.step.detail.split('\n')[0]}`, value: p })),
    ...done.map((p) => ({ label: `${p.name} — çıktı var (yeniden yapmak için: Montaj)`, value: p, disabled: true })),
  ]);
  if (!selected || selected.length === 0) {
    prompter.print('Vazgeçildi.');
    return false;
  }
  if (!await prompter.confirm(`${selected.length} proje sırayla derlenecek. Başlasın mı?`, { defaultValue: true })) {
    prompter.print('Vazgeçildi.');
    return false;
  }

  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const project = selected[i];
    prompter.print(`\n[${i + 1}/${selected.length}] ${project.name}`);

    const status = await inspectProject(project.dir);
    const step = nextStep(status);
    if (step.id !== 'build') {
      prompter.print(`Atlandı: ${step.title}`);
      results.push({ project, result: 'skipped', reason: step.title });
      continue;
    }

    const code = await ctx.run('build.js', ['--project', status.projectPath]);
    if (code === 0) {
      results.push({ project, result: 'ok', output: status.output.path });
      continue;
    }
    results.push({ project, result: 'failed', code });

    const remaining = selected.slice(i + 1);
    if (code === 130 && remaining.length > 0
      && await prompter.confirm('Montaj durduruldu. Kalan projeler iptal edilsin mi?', { defaultValue: true })) {
      for (const rest of remaining) results.push({ project: rest, result: 'cancelled' });
      break;
    }
  }

  const line = (r) => {
    switch (r.result) {
      case 'ok': return `  [başarılı]  ${r.project.name} — ${r.output}`;
      case 'failed': return `  [başarısız] ${r.project.name} — çıkış kodu ${r.code}`;
      case 'skipped': return `  [atlandı]   ${r.project.name} — ${r.reason}`;
      default: return `  [iptal]     ${r.project.name}`;
    }
  };
  prompter.print(['', 'Toplu montaj özeti:', ...results.map(line)].join('\n'));
  return results.every((r) => r.result === 'ok');
}

/** 6) Proje durumu */
export async function showStatus(ctx, dir) {
  const s = await inspectProject(dir);
  const step = nextStep(s, { skipped: skippedFor(ctx.session, dir) });
  const mark = (ok) => (ok ? '[x]' : '[ ]');
  const clipNote = s.clip.value ? ` = ${s.clip.value}${s.clip.exists ? '' : ' (dosya yok)'}` : ' (boş)';

  ctx.prompter.print([
    `Proje: ${dir}`,
    `  ${mark(s.projectJson.ok)} project.json${s.projectJson.ok ? '' : ` — ${s.projectJson.error}`}`,
    `  ${mark(s.master)} master görseli — resimler\\MASTER.*`,
    `  ${mark(s.clips.length > 0)} ${s.videoSource === 'image' ? `görsel adayı — ${s.clips.length}` : `klip — videolar\\ altında ${s.clips.length}`}`,
    `  ${mark(s.clip.exists)} clip${clipNote}`,
    `  ${mark(s.audioCount > 0)} müzik — ${s.audioCount} parça`,
    `  ${mark(s.output.exists)} çıktı — ${s.output.path}`,
    '',
    `Sıradaki: ${step.title}`,
    step.detail,
  ].join('\n'));
}

/** Ayarlar: ortak Ambiance kütüphanesi */
export async function showLibrary(ctx) {
  const ambients = await ambientsOrEmpty(ctx);
  ctx.prompter.print(`Ambient'ler: ${ambients.map((a) => a.name).join(', ') || '(yok)'}`);
}

async function ambientsOrEmpty(ctx) {
  try {
    return await listAmbients(ctx.ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    ctx.prompter.print(error.message);
    return [];
  }
}

async function finishMusicStage(ctx, { status, musicData }) {
  const completedCnt = musicData.tracks.filter((t) => t.status === 'completed').length;
  const confirmChoice = await ctx.prompter.choose(
    `${completedCnt} / ${musicData.totalTracks} tracks completed.\n\nFinish music generation and continue to the next step?`,
    [
      { label: 'Yes, Continue', value: 'yes' },
      { label: 'No, Keep Generating', value: 'no' },
    ],
  );
  if (confirmChoice !== 'yes') return false;
  await completeMusicByUser(status.projectPath, musicData);
  ctx.store?.set({ watchNotice: null });
  ctx.prompter.print('\x1b[32m[✓ Müzik Aşaması Kullanıcı Tarafından Tamamlandı]\x1b[0m Sonraki adıma geçiliyor...');
  return true;
}

async function markTrackCompleted(ctx, { status, musicData, track, file }) {
  track.status = 'completed';
  track.file = file;
  musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
  musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
  await setProjectField(status.projectPath, 'music', musicData);

  const nextPendingTrack = musicData.tracks.find((t) => t.status === 'pending');
  ctx.store?.set({
    view: 'music',
    musicState: {
      concept: musicData.concept,
      currentTrack: nextPendingTrack ?? track,
      completedCount: musicData.completedCount,
      totalTracks: musicData.totalTracks,
      tracks: musicData.tracks,
    },
  });
  ctx.prompter.print(`\x1b[32m[✓ Track ${String(track.number).padStart(2, '0')} Detected — Müzik Dosyası Algılandı]\x1b[0m ${file} — Preparing next track...`);
}

async function autoWatchMusic(ctx, { status, musicData, recentMinutes, pollMs }) {
  const { prompter } = ctx;
  const downloadsDir = ctx.downloadsDir ?? resolveDownloadsDir();
  const watcher = (ctx.createDownloadWatcherFn ?? createDownloadWatcher)({ dir: downloadsDir, recentMs: recentMinutes * 60 * 1000 });
  await watcher.start();
  const knownAudio = new Set((await filesOrEmpty(status.audioDir, AUDIO_EXTENSIONS)).map((path) => basename(path)));
  const nextPending = () => musicData.tracks.find((t) => t.status === 'pending');

  const escape = createEscapeGuard(prompter);
  let finishRequested = false;
  const stopped = () => finishRequested || escape.stopped();

  const doneCount = () => musicData.tracks.filter((t) => t.status === 'completed').length;
  const refreshHint = () => {
    const done = doneCount();
    ctx.store?.set({
      actionHint: {
        key: 'B',
        label: 'Müziği bitir ve devam et',
        enabled: done > 0,
        hint: done > 0
          ? `${done} / ${musicData.totalTracks} track hazır — B'ye bas, sonraki adıma geç.`
          : 'Henüz şarkı eklenmedi. İlk ses dosyası algılanınca bu seçenek açılır.',
      },
    });
  };
  refreshHint();

  ctx.store?.set({
    onKey: (input, key) => {
      if (!key.ctrl && !key.meta && input.toLowerCase() === 'b') {
        if (doneCount() === 0) {
          prompter.print('\x1b[33m[B]\x1b[0m Henüz şarkı eklenmedi — en az bir ses dosyası algılanınca bitirebilirsin.');
          return true;
        }
        finishRequested = true;
        return true;
      }
      return escape.handle(key);
    },
    footer: 'Auto Watch · B müziği bitir ve devam et (şarkı eklendiyse) · Esc Esc menüye dön · Ctrl+C çık',
  });
  prompter.print(`\x1b[36m[⏳ Auto Watch Aktif]\x1b[0m İndirilenler (${downloadsDir}) ve audio/ izleniyor, son ${recentMinutes} dk içinde inenler de alınıyor — Esc Esc: menüye dön`);

  let completed = 0;
  try {
    while (!stopped() && nextPending()) {
      for (const src of await watcher.poll()) {
        const track = nextPending();
        if (!track) break;
        const wanted = `${String(track.number).padStart(2, '0')}-${sanitizeFilename(cleanDownloadName(basename(src, extname(src))))}${extname(src).toLowerCase()}`;
        let file;
        try {
          file = await moveFile(src, status.audioDir, wanted);
        } catch (error) {
          prompter.print(`\x1b[33m[! Taşınamadı]\x1b[0m ${basename(src)}: ${error.message} — tekrar denenecek`);
          continue;
        }
        knownAudio.add(file);
        await recordAudioAdded(status.projectPath, [file]);
        await markTrackCompleted(ctx, { status, musicData, track, file });
        refreshHint();
        completed++;
      }

      for (const path of await filesOrEmpty(status.audioDir, AUDIO_EXTENSIONS)) {
        const file = basename(path);
        if (knownAudio.has(file)) continue;
        const track = nextPending();
        if (!track) break;
        knownAudio.add(file);
        await recordAudioAdded(status.projectPath, [file]);
        await markTrackCompleted(ctx, { status, musicData, track, file });
        refreshHint();
        completed++;
      }

      if (!stopped() && nextPending()) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    ctx.store?.set({ onKey: null, footer: '', actionHint: null });
  }

  if (!stopped()) prompter.print('\x1b[32m[✓ Auto Watch Bitti]\x1b[0m Tüm track\'ler tamamlandı.');
  else if (finishRequested) prompter.print(`\x1b[33m[Auto Watch Durdu]\x1b[0m ${completed} track tamamlandı — müzik aşamasını bitirme onayı soruluyor.`);
  else prompter.print(`\x1b[33m[Auto Watch Durdu]\x1b[0m ${completed} track tamamlandı — menüye dönülüyor.`);
  return { completed, finishRequested };
}

function createEscapeGuard(prompter) {
  const CONFIRM_MS = 1500;
  let lastEscapeAt = 0;
  let stopped = false;
  return {
    stopped: () => stopped,
    handle(key) {
      if (!key.escape) return false;
      const now = Date.now();
      if (now - lastEscapeAt <= CONFIRM_MS) {
        stopped = true;
      } else {
        lastEscapeAt = now;
        prompter.print('\x1b[33m[Esc]\x1b[0m Durdurmak için Esc\'e tekrar bas (1.5 sn içinde).');
      }
      return true;
    },
  };
}

async function autoWatchAsset(ctx, { targetDir, extensions, nameFor, recentMinutes, pollMs, label, folderLabel, detect }) {
  const { prompter } = ctx;
  const downloadsDir = ctx.downloadsDir ?? resolveDownloadsDir();
  const watcher = (ctx.createDownloadWatcherFn ?? createDownloadWatcher)({
    dir: downloadsDir, extensions, recentMs: recentMinutes * 60 * 1000,
  });
  await watcher.start();

  const escape = createEscapeGuard(prompter);
  ctx.store?.set({
    onKey: (input, key) => escape.handle(key),
    footer: `Auto Watch · ${label} bekleniyor · Esc Esc menüye dön · Ctrl+C çık`,
    actionHint: {
      key: 'Esc Esc',
      label: 'Auto Watch\'ı durdur, menüye dön',
      enabled: true,
      hint: `${label} bekleniyor — İndirilenler'e inen dosya ${folderLabel} klasörüne otomatik taşınır.`,
    },
  });
  prompter.print(`\x1b[36m[⏳ Auto Watch Aktif]\x1b[0m ${label} bekleniyor — İndirilenler (${downloadsDir}) ve ${folderLabel} izleniyor, son ${recentMinutes} dk içinde inenler de alınıyor — Esc Esc: menüye dön`);

  let detected = null;
  try {
    while (!escape.stopped()) {
      detected = (await detect()) ?? null;
      if (detected) break;

      for (const src of await watcher.poll()) {
        let file;
        try {
          file = await moveFile(src, targetDir, nameFor(src));
        } catch (error) {
          prompter.print(`\x1b[33m[! Taşınamadı]\x1b[0m ${basename(src)}: ${error.message} — tekrar denenecek`);
          continue;
        }
        prompter.print(`\x1b[32m[✓ İndirilen Dosya Alındı]\x1b[0m ${basename(src)} → ${folderLabel}${file}`);
        break;
      }

      detected = (await detect()) ?? null;
      if (detected) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    ctx.store?.set({ onKey: null, footer: '', actionHint: null });
  }

  if (!detected) prompter.print('\x1b[33m[Auto Watch Durdu]\x1b[0m Dosya alınmadı — menüye dönülüyor.');
  return { detected };
}

async function filesOrEmpty(dir, extensions) {
  try {
    return await listFiles(dir, extensions);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function isFile(path) {
  return stat(path).then((info) => info.isFile(), () => false);
}
