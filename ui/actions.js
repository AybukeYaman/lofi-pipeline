import { execSync, spawn } from 'node:child_process';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { moveFile, resolveDownloadsDir } from '../core/downloads.js';
import { AUDIO_EXTENSIONS, listFiles, uniqueFileName } from '../core/files.js';
import {
  DOWNLOAD_AUDIO_EXTENSIONS, DOWNLOAD_IMAGE_EXTENSIONS, DOWNLOAD_VIDEO_EXTENSIONS,
  RECENT_WINDOW_MINUTES, cleanDownloadName, createDownloadWatcher,
} from '../prep/download-watch.js';
import { AmbientError, listAmbients } from '../prep/ambients.js';
import { ProjectFileError, setProjectClip, setProjectField } from '../prep/project-file.js';
import { inspectProject, listProjects, nextStep } from '../prep/project-status.js';
import { describeMultiReferenceStyle } from '../prep/describe-style.js';
import { getPhasePrompts } from '../prep/prompts.js';
import { validateVideoName } from '../prep/scaffold.js';
import { StyleError, findStyleRef, listStyles, loadStyle, renderStyleBlock } from '../prep/styles.js';
import { ingestSunoUrl, sanitizeFilename } from '../prep/suno-ingest.js';
import { SunoIngestError } from '../prep/suno-errors.js';
import { cleanPath } from './prompt.js';

const STYLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Auto Watch: İndirilenler ve audio/ tarama aralığı. */
const DOWNLOAD_POLL_MS = 1000;

export function copyToClipboard(text) {
  try {
    const process = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    process.stdin.write(String(text ?? ''));
    process.stdin.end();
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
 * Seçilen audio dosyalarını projenin audio/ klasörüne kopyalar.
 * Çakışan dosya adı varsa "İsim (1).mp3" şeklinde güvenli kopyalar.
 * Kopyalama başarısız olan dosyaları raporlar ve yalnızca başarılı olanların isimlerini döndürür.
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

/** Oturum hafızası: seçili proje ve projeye göre "bu oturumda atla" denen adımlar. */
export function createSession() {
  return { project: null, skipped: new Map() };
}

function skippedFor(session, dir) {
  if (!session.skipped.has(dir)) session.skipped.set(dir, new Set());
  return session.skipped.get(dir);
}

/**
 * Seçili projeyi döndürür; yoksa (ya da force) listeden seçtirir.
 * @returns {Promise<string | null>} proje klasörü
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

/** 2) Yeni proje setup: isim → stil → ambient → müzik → START PRODUCTION → otomasyon */
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

  const items = [
    { label: '✨ [ Multi-Reference Visual Style ] — Görsellerden Yapay Zeka ile Stil Üret', value: { name: 'custom-generated', suggestedAmbient: 'none', isMultiRef: true } },
  ];
  for (const styleName of await listStyles({ dir: ctx.stylesDir })) {
    try {
      const { style } = await loadStyle(styleName, { dir: ctx.stylesDir });
      const ref = (await findStyleRef(styleName, { dir: ctx.stylesDir })).path ? 'referans görseli var' : 'referans görseli yok';
      items.push({ label: `${styleName} — öneri: ${style.suggestedAmbient} · ${ref}`, value: style });
    } catch (error) {
      if (!(error instanceof StyleError)) throw error;
      items.push({ label: `${styleName} (geçersiz stil dosyası)`, value: null, disabled: true });
    }
  }
  const style = await prompter.choose('Select Style:', items, { zeroLabel: 'Geri' });
  if (!style) return false;

  const ambients = await ambientsOrEmpty(ctx);
  const suggested = ambients.find((a) => a.name.toLowerCase() === style.suggestedAmbient.toLowerCase());
  const ordered = suggested ? [suggested, ...ambients.filter((a) => a !== suggested)] : ambients;
  const selectedAmbients = await prompter.chooseMany(
    `Select Ambient (stilin önerisi: ${style.suggestedAmbient}; Boşluk ile çoklu seç):`,
    ordered.map((a) => ({ label: a === suggested ? `${a.name} (öneri)` : a.name, value: a.name })),
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
    name, '--style', style.name,
    ...(ambientArg ? ['--ambient', ambientArg] : []),
    '--concept', concept,
    '--total-tracks', String(totalTracks),
    '--videos-dir', ctx.videosDir, '--ambient-dir', ctx.ambientDir, '--styles-dir', ctx.stylesDir,
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

/** 3) Stil ekle: görsel → ad → (üzerine yaz?) → add-style.js */
export async function addStyle(ctx) {
  const { prompter } = ctx;

  let image;
  for (;;) {
    image = cleanPath(await prompter.ask('Stil görseli (dosyayı buraya sürükleyebilirsin; Esc = geri)'));
    if (image === '') return false;
    if (await isFile(image)) break;
    prompter.print(`Dosya bulunamadı: ${image}`);
  }

  let name;
  for (;;) {
    name = await prompter.ask('Stil adı (küçük harf, rakam, tire — ör. neo-tokyo; Esc = geri)');
    if (!name) return false;
    if (STYLE_NAME.test(name)) break;
    prompter.print('Ad küçük harf, rakam ve tireden oluşmalı (ör. neo-tokyo).');
  }

  const overwrite = await isFile(join(ctx.stylesDir, `${name}.json`));
  if (overwrite && !await prompter.confirm(`"${name}" zaten var. Üzerine yazılsın mı? (Gemini'ye yeni istek gider)`)) {
    prompter.print('Vazgeçildi.');
    return false;
  }

  const code = await ctx.run('add-style.js', [
    image, '--name', name,
    ...(overwrite ? ['--overwrite'] : []),
    '--styles-dir', ctx.stylesDir, '--ambient-dir', ctx.ambientDir,
  ]);
  prompter.print(code === 0 ? `Stil eklendi: ${name}` : `Stil eklenemedi (çıkış kodu ${code}).`);
  return code === 0;
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
    `  ${mark(s.styleRef)} stil görseli (resimler\\style-ref.*)`,
    `  ${mark(s.master)} Faz 1 — resimler\\MASTER.*`,
    `  ${mark(s.clips.length > 0)} Faz 3 — videolar\\ altında ${s.clips.length} klip`,
    `  ${mark(s.clip.exists)} clip${clipNote}`,
    `  ${mark(s.audioCount > 0)} müzik — ${s.audioCount} parça`,
    `  ${mark(s.output.exists)} çıktı — ${s.output.path}`,
    '',
    `Sıradaki: ${step.title}`,
    step.detail,
  ].join('\n'));
}

/** 7) Stiller ve ambient'ler */
export async function showLibrary(ctx) {
  const lines = ['Stiller:'];
  for (const name of await listStyles({ dir: ctx.stylesDir })) {
    try {
      const { style } = await loadStyle(name, { dir: ctx.stylesDir });
      const ref = (await findStyleRef(name, { dir: ctx.stylesDir })).path ? 'referans görseli var' : 'referans görseli yok';
      lines.push(`  ${name} — öneri: ${style.suggestedAmbient} · ${ref}`);
    } catch (error) {
      if (!(error instanceof StyleError)) throw error;
      lines.push(`  ${name} (geçersiz: ${error.problems.length} problem)`);
    }
  }
  const ambients = await ambientsOrEmpty(ctx);
  lines.push('', `Ambient'ler: ${ambients.map((a) => a.name).join(', ') || '(yok)'}`);
  ctx.prompter.print(lines.join('\n'));
}

/**
 * 1) Otomatik Sıralı Mod:
 * Kullanıcıdan gereksiz "Hazır mısın?" / "Ne yapılsın?" onayları istemez.
 * Dosyaları otomatik izler (Watcher), hazır olunca doğrudan sonraki adıma geçer.
 */
export async function continueProject(ctx, targetDir = null, { pollMs = 50 } = {}) {
  const { prompter } = ctx;
  const dir = targetDir || await selectProject(ctx);
  if (!dir) return;
  const skipped = skippedFor(ctx.session, dir);

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
        style: status.style ?? status.projectJson.data?.style ?? '-',
        ambient: status.projectJson.data?.ambient ?? 'none',
        master: status.master,
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

    // STİL REFERANSI BEKLEME (Multi-Reference Style Generation)
    if (step.id === 'style-references') {
      const refDir = join(dir, 'references');
      let folderOpen = false;
      let styleGenerated = false;

      while (!styleGenerated) {
        const cur = await inspectProject(dir);
        if (cur.styleBlockExists) {
          styleGenerated = true;
          break;
        }

        ctx.store?.set({
          watchNotice: {
            asset: 'Visual Style Reference Images',
            description: 'Stil analizi için beğendiğiniz referans görselleri buraya koyun. Birden fazla görsel eklenebilir.',
            folder: 'references/',
            expected: `.jpg, .jpeg, .png, .webp (${cur.references.length} algılandı)`,
            folderOpen,
          },
        });

        const choice = await prompter.choose(`STYLE REFERENCES — ${cur.references.length} images detected`, [
          { label: '📂 [ Open Reference Folder ] - Referans Klasörünü Aç', value: 'open' },
          { label: '🔄 [ Refresh ] - Klasörü Yeniden Tara ve Görselleri Algıla', value: 'refresh' },
          { label: '🏠 Ana Menüye Dön', value: 'menu' },
        ]);

        if (!choice || choice === 'menu') {
          ctx.store?.set({ watchNotice: null });
          return;
        }

        if (choice === 'open') {
          (ctx.openFolderFn ?? openFolder)(refDir);
          folderOpen = true;
          ctx.store?.set({ watchNotice: { file: `references/ (${cur.references.length} görseller)`, folderOpen: true } });
          prompter.print('\x1b[32m[📂 Referans Klasörü Açıldı]\x1b[0m .jpg, .jpeg, .png, .webp görsellerini bu klasöre koyun.');
        } else if (choice === 'refresh') {
          const updated = await inspectProject(dir);
          if (updated.references.length > 0) {
            prompter.print(`\x1b[36m[🎨 Yapay Zeka Stil Analizi Başlatılıyor...]\x1b[0m ${updated.references.length} referans görsel analiz ediliyor...`);
            try {
              const concept = status.projectJson.data?.concept || `${status.name} Album Concept`;
              const { style: generatedStyle } = await describeMultiReferenceStyle({
                imagePaths: updated.references,
                concept,
                name: 'custom-generated',
                options: { ambientDir: ctx.ambientDir, generateContentFn: ctx.generateContentFn, ...(ctx.describeOptions || {}) },
              });

              // Write STYLE_BLOCK.txt and update project.json
              const { writeTextFile } = await import('../core/workspace.js');
              await writeTextFile(status.styleBlockPath, renderStyleBlock(generatedStyle) + '\n', { bom: true });

              const projectData = status.projectJson.data ?? {};
              projectData.styleBlock = generatedStyle.styleBlock;
              projectData.motionHints = generatedStyle.motionHints;
              projectData.style = 'custom-generated';
              await setProjectField(status.projectPath, 'styleBlock', generatedStyle.styleBlock);
              await setProjectField(status.projectPath, 'motionHints', generatedStyle.motionHints);
              await setProjectField(status.projectPath, 'style', 'custom-generated');

              prompter.print('\x1b[32m[✓ Visual Style Başarıyla Üretildi & Persist Edildi!]\x1b[0m STYLE_BLOCK.txt oluşturuldu.');
              styleGenerated = true;
              ctx.store?.set({ watchNotice: null });
              continue;
            } catch (err) {
              prompter.print(`\x1b[31m[! Stil Üretimi Başarısız]\x1b[0m ${err.message}`);
            }
          } else {
            prompter.print('\x1b[33m[! Görsel Bulunamadı]\x1b[0m references/ klasörüne en az 1 görsel ekleyin.');
          }
        }
      }
      continue;
    }

    // FAZ 1 (Master Frame Bekleme)
    if (step.id === 'faz1') {
      let phasePrompt = '';
      try {
        const projectStyleName = status.style !== '-' ? status.style : (status.projectJson.data?.style ?? 'cozy-realistic');
        let styleObj = null;
        if (status.projectJson.data?.styleBlock) {
          styleObj = {
            name: projectStyleName,
            styleBlock: status.projectJson.data.styleBlock,
            motionHints: status.projectJson.data.motionHints || ['subtle motion'],
          };
        } else {
          const loadedStyle = await loadStyle(projectStyleName, { dir: ctx.stylesDir }).catch(() => null);
          styleObj = loadedStyle?.style;
        }
        const prompts = await getPhasePrompts({ videoName: basename(dir), style: styleObj });
        phasePrompt = prompts.faz1;
      } catch {
        phasePrompt = step.detail;
      }

      const imgDir = join(dir, 'resimler');
      let folderOpen = false;
      let masterDetected = false;

      while (!masterDetected) {
        const cur = await inspectProject(dir);
        if (cur.master) {
          masterDetected = true;
          break;
        }

        ctx.store?.set({
          watchNotice: {
            asset: 'Environment / Composition Reference',
            description: 'Bu görsel sahne/ortam kompozisyonunu ve kamera açısını belirler. STYLE_BLOCK üzerine uygulanır.',
            folder: 'resimler/',
            expected: 'MASTER.png',
            folderOpen,
          },
        });

        const choice = await prompter.choose('MASTER FRAME READY — Ne yapmak istersiniz?', [
          { label: '📂 [ Klasörü Aç ] - Resim Klasörünü Windows\'ta Aç', value: 'open' },
          { label: '🔄 [ Yenile ] - Klasörü Yeniden Tara', value: 'refresh' },
          { label: '📋 [ Copy Prompt ] - Panoya Kopyala', value: 'copy' },
          { label: '👁 [ View Prompt ] - Prompt Overlay Aç', value: 'view' },
          { label: '⏳ [ Auto Watch ] - Otomatik Dosya Bekle', value: 'watch' },
          { label: '🏠 Ana Menüye Dön', value: 'menu' },
        ]);

        if (!choice || choice === 'menu') {
          ctx.store?.set({ watchNotice: null });
          return;
        }

        if (choice === 'open') {
          (ctx.openFolderFn ?? openFolder)(imgDir);
          folderOpen = true;
          ctx.store?.set({ watchNotice: { file: 'resimler/MASTER.png', folderOpen: true } });
          prompter.print('\x1b[32m[📂 Klasör Açıldı]\x1b[0m resimler/ klasörü Windows Explorer\'da açıldı.');
        } else if (choice === 'refresh') {
          const updated = await inspectProject(dir);
          if (updated.master) {
            masterDetected = true;
            break;
          }
          prompter.print('\x1b[33m[! Dosya Henüz Bulunamadı]\x1b[0m resimler/MASTER.png bekleniyor...');
        } else if (choice === 'copy') {
          copyToClipboard(phasePrompt);
          prompter.print('\x1b[32m[✓] Master Frame promptu panoya kopyalandı!\x1b[0m');
        } else if (choice === 'view') {
          ctx.store?.set({ promptDetail: { title: 'FAZ 1: Master Frame Promptu', content: phasePrompt } });
          await prompter.choose('Prompt Overlay', [{ label: 'Overlay Kapat', value: 'close' }]);
          ctx.store?.set({ promptDetail: null });
        } else if (choice === 'watch') {
          const recentMinutes = await prompter.choose(
            'Auto Watch — İndirilenler\'de ne kadar önce inmiş dosyalar da alınsın?',
            RECENT_WINDOW_MINUTES.map((minutes) => ({ label: `Son ${minutes} dakika`, value: minutes })),
            { zeroLabel: 'Geri' },
          );
          if (!recentMinutes) continue;
          const { detected } = await autoWatchAsset(ctx, {
            targetDir: imgDir,
            extensions: DOWNLOAD_IMAGE_EXTENSIONS,
            nameFor: (src) => `MASTER${extname(src).toLowerCase()}`,
            recentMinutes,
            pollMs: ctx.downloadPollMs ?? pollMs,
            label: 'resimler/MASTER.png',
            folderLabel: 'resimler/',
            detect: async () => (await inspectProject(dir)).master,
          });
          if (detected) masterDetected = true;
        }
      }

      ctx.store?.set({ watchNotice: null });
      prompter.print('\x1b[32m[✓ Master Görseli Algılandı]\x1b[0m resimler/MASTER.png — Otomatik devam ediliyor...');
      continue;
    }

    // FAZ 3 (Klip Bekleme)
    if (step.id === 'faz3' || step.id === 'clip') {
      let phasePrompt = '';
      try {
        const projectStyleName = status.style !== '-' ? status.style : (status.projectJson.data?.style ?? 'cozy-realistic');
        const loadedStyle = await loadStyle(projectStyleName, { dir: ctx.stylesDir }).catch(() => null);
        const prompts = await getPhasePrompts({ videoName: basename(dir), style: loadedStyle?.style });
        phasePrompt = `${prompts.faz2}\n\n${prompts.faz3}`;
      } catch {
        phasePrompt = step.detail;
      }

      const vidDir = join(dir, 'videolar');
      let folderOpen = false;
      let detectedClip = null;

      while (!detectedClip) {
        const cur = await inspectProject(dir);
        if (cur.clips.length > 0) {
          detectedClip = cur.clips[0];
          break;
        }

        ctx.store?.set({
          watchNotice: {
            asset: 'Animated Video Clip (Image-to-Video)',
            description: 'MASTER.png görselinden üretilmiş 5 saniyelik döngüsel video klibi (.mp4).',
            folder: 'videolar/',
            expected: '*.mp4',
            folderOpen,
          },
        });

        const choice = await prompter.choose('CAMERA / VIDEO CLIP READY — Ne yapmak istersiniz?', [
          { label: '📂 [ Klasörü Aç ] - Video Klasörünü Windows\'ta Aç', value: 'open' },
          { label: '🔄 [ Yenile ] - Klasörü Yeniden Tara', value: 'refresh' },
          { label: '📋 [ Copy Prompt ] - Panoya Kopyala', value: 'copy' },
          { label: '👁 [ View Prompt ] - Prompt Overlay Aç', value: 'view' },
          { label: '⏳ [ Auto Watch ] - Otomatik Dosya Bekle', value: 'watch' },
          { label: '🏠 Ana Menüye Dön', value: 'menu' },
        ]);

        if (!choice || choice === 'menu') {
          ctx.store?.set({ watchNotice: null });
          return;
        }

        if (choice === 'open') {
          (ctx.openFolderFn ?? openFolder)(vidDir);
          folderOpen = true;
          ctx.store?.set({ watchNotice: { file: 'videolar/*.mp4', folderOpen: true } });
          prompter.print('\x1b[32m[📂 Klasör Açıldı]\x1b[0m videolar/ klasörü Windows Explorer\'da açıldı.');
        } else if (choice === 'refresh') {
          const updated = await inspectProject(dir);
          if (updated.clips.length > 0) {
            detectedClip = updated.clips[0];
            break;
          }
          prompter.print('\x1b[33m[! Dosya Henüz Bulunamadı]\x1b[0m videolar/*.mp4 bekleniyor...');
        } else if (choice === 'copy') {
          copyToClipboard(phasePrompt);
          prompter.print('\x1b[32m[✓] Video Klip promptu panoya kopyalandı!\x1b[0m');
        } else if (choice === 'view') {
          ctx.store?.set({ promptDetail: { title: 'FAZ 3: Klip (Image-to-Video) Promptu', content: phasePrompt } });
          await prompter.choose('Prompt Overlay', [{ label: 'Overlay Kapat', value: 'close' }]);
          ctx.store?.set({ promptDetail: null });
        } else if (choice === 'watch') {
          const recentMinutes = await prompter.choose(
            'Auto Watch — İndirilenler\'de ne kadar önce inmiş dosyalar da alınsın?',
            RECENT_WINDOW_MINUTES.map((minutes) => ({ label: `Son ${minutes} dakika`, value: minutes })),
            { zeroLabel: 'Geri' },
          );
          if (!recentMinutes) continue;
          const { detected } = await autoWatchAsset(ctx, {
            targetDir: vidDir,
            extensions: DOWNLOAD_VIDEO_EXTENSIONS,
            nameFor: (src) => `${sanitizeFilename(cleanDownloadName(basename(src, extname(src))))}${extname(src).toLowerCase()}`,
            recentMinutes,
            pollMs: ctx.downloadPollMs ?? pollMs,
            label: 'videolar/*.mp4',
            folderLabel: 'videolar/',
            detect: async () => (await inspectProject(dir)).clips[0] ?? null,
          });
          if (detected) detectedClip = detected;
        }
      }

      ctx.store?.set({ watchNotice: null });
      const writtenClip = await setProjectClip(status.projectPath, detectedClip);
      prompter.print(`\x1b[32m[✓ Video Klip Algılandı & Bağlandı]\x1b[0m clip = ${writtenClip}`);

      const wmChoice = await prompter.choose('WATERMARK CONTROL — Bu videoda watermark var mı?', [
        { label: ' [Hayır, watermark yok] - Alttan kırpma yapma', value: 'no' },
        { label: ' [Evet, watermark var] - Alttan kırpma (watermark crop) uygula', value: 'yes' },
      ]);

      const rawJson = status.projectJson.data ?? {};
      const currentVideoObj = { ...rawJson.video };
      if (wmChoice === 'no') {
        currentVideoObj.cropBottom = 0;
      } else {
        currentVideoObj.cropBottom = (currentVideoObj.cropBottom && currentVideoObj.cropBottom > 0) ? currentVideoObj.cropBottom : 150;
      }
      await setProjectField(status.projectPath, 'video', currentVideoObj);

      prompter.print('\x1b[32m[✓ Watermark Kararı Kaydedildi]\x1b[0m Otomatik devam ediliyor...');
      continue;
    }

    // MÜZİK ADIMI (Audio & Music Generation Workflow)
    if (step.id === 'audio') {
      const musicData = status.projectJson.data?.music;
      if (musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
        const pendingTrack = musicData.tracks.find((t) => t.status === 'pending');
        if (pendingTrack) {
          let folderOpen = false;
          let detectedFile = null;
          let autoWatched = false;
          const initialAudioCount = status.audioCount;

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
              // Eksik track'lerle devam etmek ancak elde en az bir şarkı varken anlamlı.
              ...(musicData.tracks.some((t) => t.status === 'completed')
                ? [{ label: '⏭ [ Finish Music & Continue ] - Müzik Aşamasını Bitir ve Devam Et', value: 'finish' }]
                : []),
              { label: '🏠 Ana Menüye Dön', value: 'menu' },
            ]);

            if (!choice || choice === 'menu') {
              ctx.store?.set({ watchNotice: null });
              return;
            }

            if (choice === 'suno') {
              const sunoUrl = await prompter.ask('Public Suno URL (Playlist veya Song Linki; Esc = geri):');
              if (sunoUrl) {
                prompter.print('\x1b[36m[🌐 Suno İndirme Başlatılıyor...]\x1b[0m Metadata ve MP3 çekiliyor...');
                try {
                  const ingestResult = await ingestSunoUrl({ url: sunoUrl, outputDir: status.audioDir });
                  if (ingestResult.tracks.length > 0) {
                    const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
                    const count = Math.min(ingestResult.tracks.length, pendingTracks.length);
                    for (let i = 0; i < count; i++) {
                      pendingTracks[i].status = 'completed';
                      pendingTracks[i].file = basename(ingestResult.tracks[i].localPath);
                    }
                    musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
                    if (musicData.completedCount === musicData.totalTracks) {
                      musicData.status = 'completed';
                    } else {
                      musicData.status = 'in_progress';
                    }
                    await setProjectField(status.projectPath, 'music', musicData);

                    prompter.print(`\x1b[32m[✓ Suno İndirme Tamamlandı]\x1b[0m ${ingestResult.tracks.length} parça indirildi.`);
                    break;
                  }
                } catch (err) {
                  if (err instanceof SunoIngestError && err.notPublic) {
                    prompter.print(`\x1b[33m[! Link Public Değil]\x1b[0m ${err.message}`);
                  } else if (err instanceof SunoIngestError && err.downloadDisabled) {
                    prompter.print(`\x1b[33m[! İndirme Kapalı]\x1b[0m ${err.message}`);
                  } else {
                    prompter.print(`\x1b[31m[! Suno İndirme Hatası]\x1b[0m ${err.message}`);
                  }
                }
              }
            }

            if (choice === 'select') {
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
                  if (musicData.completedCount === musicData.totalTracks) {
                    musicData.status = 'completed';
                  } else {
                    musicData.status = 'in_progress';
                  }
                  await setProjectField(status.projectPath, 'music', musicData);

                  const nextPendingTrack = musicData.tracks.find((t) => t.status === 'pending');
                  ctx.store?.set({
                    view: 'music',
                    musicState: {
                      concept: musicData.concept,
                      currentTrack: nextPendingTrack ?? pendingTrack,
                      completedCount: musicData.completedCount,
                      totalTracks: musicData.totalTracks,
                      tracks: musicData.tracks,
                    },
                  });

                  prompter.print(`\x1b[32m[✓ ${copiedNames.length} Audio Seçildi & Aktarıldı]\x1b[0m ${copiedNames.join(', ')}`);
                  break;
                }
              } else {
                prompter.print('\x1b[33m[! Seçim İptal Edildi]\x1b[0m Audio seçilmedi.');
              }
            }

            if (choice === 'finish') {
              if (await finishMusicStage(ctx, { status, musicData })) break;
              continue;
            }

            if (choice === 'open') {
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
              break;
            }
          }

          if (autoWatched) continue;

          if (detectedFile) {
            await markTrackCompleted(ctx, { status, musicData, track: pendingTrack, file: detectedFile });
            continue;
          }
        }
      }

      if (status.audioCount === 0) {
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
            { label: '🏠 Ana Menüye Dön', value: 'menu' },
          ]);

          if (!musicSource || musicSource === 'menu') {
            ctx.store?.set({ watchNotice: null });
            return;
          }

          if (musicSource === 'open') {
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
          continue;
        }
      }
    }

    // MONTAJ ADIMI (Build)
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

    // BİTİŞ EKRANI (Done)
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

// ---------------------------------------------------------------- yardımcılar

async function ambientsOrEmpty(ctx) {
  try {
    return await listAmbients(ctx.ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    ctx.prompter.print(error.message);
    return [];
  }
}

/**
 * "Müziği bitir ve devam et": onay sorar; evet ise müzik aşaması kullanıcı tarafından
 * tamamlanmış sayılır (eksik track'lerle devam). Menü ve Auto Watch (B tuşu) kullanır.
 * @param {object} ctx
 * @param {{ status: object, musicData: object }} params
 * @returns {Promise<boolean>} onaylandı mı
 */
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
  musicData.status = 'completed_by_user';
  musicData.completedCount = completedCnt;
  await setProjectField(status.projectPath, 'music', musicData);
  ctx.store?.set({ watchNotice: null });
  ctx.prompter.print('\x1b[32m[✓ Müzik Aşaması Kullanıcı Tarafından Tamamlandı]\x1b[0m Sonraki adıma geçiliyor...');
  return true;
}

/**
 * Track'i dosyayla tamamlar: project.json (music) ve ekrandaki sayaç güncellenir.
 * @param {object} ctx
 * @param {{ status: object, musicData: object, track: object, file: string }} params
 */
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

/**
 * Auto Watch (müzik): İndirilenler'deki ses dosyalarını (.mp3/.m4a/.wav) projenin audio/ klasörüne taşır
 * ("NN-Ad.mp3"), audio/'ya elle konan dosyaları da algılar; her dosya sıradaki bekleyen
 * track'i indirilme sırasıyla tamamlar. Tüm track'ler bitince ya da çift Esc ile durur.
 * Açılırken seçilen süre (son 5/10/15 dk) içinde inmiş dosyalar da alınır; daha eskilerine dokunulmaz.
 *
 * @param {object} ctx downloadsDir / createDownloadWatcherFn testte verilebilir
 * @param {{ status: object, musicData: object, pollMs: number }} params
 * @returns {Promise<{ completed: number, finishRequested: boolean }>} finishRequested: B ile "müziği bitir" istendi
 */
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

  // "Bitir" ancak en az bir track tamamlandıysa anlamlı; kutu o zamana kadar sönük durur.
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
      // B (Bitir): harf tuşu kaçış dizisi tuzağına düşmez; asıl onay finishMusicStage'de sorulur.
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

/**
 * Auto Watch ekranlarının çıkış tuşu: çift Esc.
 *
 * Neden çift: terminal pencere odağı değişince (alt-tab) bazen yarım kalan bir kontrol
 * dizisi geliyor, ink bunu 20ms içinde tamamlanmazsa tek başına Esc sanıyor (ink #943
 * tuzağının bir başka biçimi — bkz. ui/tui/keys.js başı). Tek sahte Esc izlemeyi
 * durdurmaz; art arda iki gerçek Esc gerekir.
 *
 * @param {{ print: (text: string) => void }} prompter
 * @returns {{ handle: (key: object) => boolean, stopped: () => boolean }} handle: tuş yutuldu mu
 */
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

/**
 * Auto Watch (tek dosyalık varlıklar: MASTER görseli / video klip).
 *
 * autoWatchMusic ile aynı iş akışının tek hedefli hâli: İndirilenler izlenir, inen ilk
 * uygun dosya proje klasörüne TAŞINIR ve beklenen adla kaydedilir; klasöre elle konan
 * dosya da algılanır. Çift Esc ile durur (gerekçe: autoWatchMusic'teki ink #943 notu),
 * kısayol footer'da ve ekrandaki eylem kutusunda görünür.
 *
 * @param {object} ctx downloadsDir / createDownloadWatcherFn testte verilebilir
 * @param {{
 *   targetDir: string, extensions: string[], nameFor: (src: string) => string,
 *   recentMinutes: number, pollMs: number, label: string, folderLabel: string,
 *   detect: () => Promise<unknown>,
 * }} params detect: dosya geldiyse değerini, gelmediyse null/undefined döndürür
 * @returns {Promise<{ detected: unknown }>} detected null ise kullanıcı Esc Esc ile durdurdu
 */
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
        break; // tek dosya yeter; kalanlar İndirilenler'de kalsın
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

