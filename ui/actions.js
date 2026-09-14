/**
 * Panel akışları — her menü öğesi bir fonksiyon.
 *
 * Tek sorumluluk: kullanıcıya sormak, doğru bayraklarla komutu kurmak, sonucu
 * göstermek. İş kuralları prep/'te (durum, clip yazımı), komutlar CLI'larda
 * (ayrı süreçte). Bağımlılıklar `ctx` ile gelir:
 *   { prompter, run(script, args) → çıkış kodu, videosDir, ambientDir, stylesDir, session }
 *
 * Klasör bayrakları komutlara her zaman açıkça verilir: panelin listelediği
 * klasörle komutun kullandığı klasör aynı olsun.
 */

import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { AmbientError, listAmbients } from '../prep/ambients.js';
import { ProjectFileError, setProjectClip } from '../prep/project-file.js';
import { inspectProject, listProjects, nextStep } from '../prep/project-status.js';
import { validateVideoName } from '../prep/scaffold.js';
import { StyleError, findStyleRef, listStyles, loadStyle } from '../prep/styles.js';
import { cleanPath } from './prompt.js';

const STYLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    prompter.print(`Proje yok (${ctx.videosDir}). Önce "Yeni proje oluştur".`);
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

/** 2) Yeni proje: isim → stil → ambient → new-video.js → "devam et?" */
export async function newProject(ctx) {
  const { prompter } = ctx;

  let name;
  for (;;) {
    name = await prompter.ask('Proje adı (ör. video3-Neo Tokyo Night; boş = geri)');
    if (!name) return false;
    const problems = validateVideoName(name);
    if (problems.length === 0 && await exists(join(ctx.videosDir, name))) {
      problems.push(`bu isimde klasör zaten var: ${join(ctx.videosDir, name)}`);
    }
    if (problems.length === 0) break;
    for (const problem of problems) prompter.print(`  - ${problem}`);
  }

  const items = [];
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
  const style = await prompter.choose('Stil seç:', items, { zeroLabel: 'Geri' });
  if (!style) return false;

  const ambients = await ambientsOrEmpty(ctx);
  const suggested = ambients.find((a) => a.name.toLowerCase() === style.suggestedAmbient.toLowerCase());
  const ordered = suggested ? [suggested, ...ambients.filter((a) => a !== suggested)] : ambients;
  const ambient = await prompter.choose(
    `Ambient seç (stilin önerisi: ${style.suggestedAmbient}):`,
    ordered.map((a) => ({ label: a === suggested ? `${a.name} (öneri)` : a.name, value: a.name })),
    { zeroLabel: 'Ambient yok' },
  );

  const code = await ctx.run('new-video.js', [
    name, '--style', style.name,
    ...(ambient ? ['--ambient', ambient] : []),
    '--videos-dir', ctx.videosDir, '--ambient-dir', ctx.ambientDir, '--styles-dir', ctx.stylesDir,
  ]);
  if (code !== 0) {
    prompter.print(`Proje oluşturulamadı (çıkış kodu ${code}).`);
    return false;
  }

  ctx.session.project = join(ctx.videosDir, name);
  if (await prompter.confirm('Bu projeyle devam et?', { defaultValue: true })) await continueProject(ctx);
  return true;
}

/** 3) Stil ekle: görsel → ad → (üzerine yaz?) → add-style.js */
export async function addStyle(ctx) {
  const { prompter } = ctx;

  let image;
  for (;;) {
    image = cleanPath(await prompter.ask('Stil görseli (dosyayı buraya sürükleyebilirsin; boş = geri)'));
    if (image === '') return false;
    if (await isFile(image)) break;
    prompter.print(`Dosya bulunamadı: ${image}`);
  }

  let name;
  for (;;) {
    name = await prompter.ask('Stil adı (küçük harf, rakam, tire — ör. neo-tokyo; boş = geri)');
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
    if (!await prompter.confirm(`Klip: ${label(status.clips[0])} — kullanılsın mı?`, { defaultValue: true })) return false;
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

/** 6) Proje durumu — kontrol listesi + sıradaki adım. */
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

/** 7) Stiller ve ambient'ler. */
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
 * 1) Sıralı mod: durum → sıradaki adım → yap ya da talimat göster → tekrar.
 * Durum her turda diskten okunur; yalnızca "atla" kararları oturumda tutulur.
 */
export async function continueProject(ctx) {
  const { prompter } = ctx;
  const dir = await selectProject(ctx);
  if (!dir) return;
  const skipped = skippedFor(ctx.session, dir);

  let lastAuto = null;
  for (;;) {
    const step = nextStep(await inspectProject(dir), { skipped });
    prompter.print(`\n==> ${step.title}\n${step.detail}`);

    if (step.kind === 'done') return;

    if (step.kind === 'auto') {
      // Komut başarılı dedi ama kanıt değişmedi (ör. build 0 döndü, çıktı yok): döngüye girme.
      if (lastAuto === step.id) {
        prompter.print(`Uyarı: "${step.title}" tamamlanmış görünmüyor — ana menüye dönülüyor.`);
        return;
      }
      lastAuto = step.id;
      if (step.id === 'clip') {
        if (!await chooseClip(ctx, dir)) return;
      } else {
        if (!await prompter.confirm('Montaj başlasın mı?', { defaultValue: true })) return;
        if (!await buildProject(ctx, dir)) return;
      }
      continue;
    }

    lastAuto = null;
    const choice = await prompter.choose('Ne yapılsın?', [
      { label: 'Tekrar kontrol et', value: 'check' },
      ...(step.skippable ? [{ label: 'Bu oturumda atla', value: 'skip' }] : []),
    ], { zeroLabel: 'Ana menü' });
    if (!choice) return;
    if (choice === 'skip') skipped.add(step.id);
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

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function isFile(path) {
  return stat(path).then((info) => info.isFile(), () => false);
}
