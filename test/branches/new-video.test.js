/**
 * Aşama 7a — new-video.js: klasör kurulumu, çakışma, geri alma, CLI, build uyumu.
 * Sahte videolar kökü ve sahte ambient klasörü geçici klasörde; medya yok.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { ConfigError, loadProject } from '../../core/config.js';
import { NewVideoError, main, runNewVideo } from '../../new-video.js';
import { loadTemplates } from '../../prep/prompts.js';
import { ProjectExistsError, planProject, writeProject } from '../../prep/scaffold.js';
import { STYLES_DIR, loadStyle } from '../../prep/styles.js';
import { tempDir } from '../helpers/fixtures.js';

let root;
let n = 0;
/** Her test kendi videolar kökü + ambient klasörüyle. */
let env;

beforeEach(async () => {
  root ??= await tempDir('new-video');
  const base = root.path(`t${n++}`);
  env = { videosDir: join(base, 'videolar'), ambientDir: join(base, 'ambient'), base };
  await mkdir(env.videosDir, { recursive: true });
  await mkdir(env.ambientDir);
  for (const file of ['campfire.mp3', 'gentleRain.mp3', 'heavyRain.mp3', 'rainStorm.mp3']) {
    await writeFile(join(env.ambientDir, file), '');
  }
});
after(() => root?.cleanup());

const flags = () => ['--videos-dir', env.videosDir, '--ambient-dir', env.ambientDir];

/** main()'i konsol çıktısını yakalayarak çalıştırır. */
async function runMain(t, argv) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => err.push(a.join(' ')));
  const code = await main(argv);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('runNewVideo', () => {
  test('klasör ağacı, metinler BOM\'lu / project.json BOM\'suz, LF, ambient tam yol', async () => {
    const result = await runNewVideo({
      ...env, videoName: 'video3-Neo Tokyo & Night', styleName: 'cozy-realistic', ambientName: 'HEAVYRAIN',
    });
    const dir = join(env.videosDir, 'video3-Neo Tokyo & Night');
    assert.equal(result.dir, dir);
    assert.deepEqual((await readdir(dir)).sort(), ['STYLE_BLOCK.txt', 'audio', 'project.json', 'prompts.md', 'resimler', 'videolar']);
    for (const sub of ['audio', 'resimler', 'videolar']) assert.deepEqual(await readdir(join(dir, sub)), []);

    // PowerShell 5.1 Get-Content BOM'suz UTF-8'i cp1254 okuyor ("â€”") — insan okuduğu dosyalar BOM'lu.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const [name, withBom] of [['STYLE_BLOCK.txt', true], ['project.json', false], ['prompts.md', true]]) {
      const bytes = await readFile(join(dir, name));
      assert.equal(bytes.subarray(0, 3).equals(bom), withBom, `${name}: BOM`);
      if (withBom) assert.notEqual(bytes[3], 0xef, `${name}: çift BOM`);
      assert.ok(!bytes.includes(0x0d), `${name}: CR`);
    }
    const prompts = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(dir, 'prompts.md')));
    assert.ok(prompts.startsWith('# video3-Neo Tokyo & Night — Üretim promptları\n'));

    const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.equal(project.ambient, join(env.ambientDir, 'heavyRain.mp3'));
    assert.equal(result.ambient.name, 'heavyRain');
    assert.equal(result.suggestion, null);
    assert.deepEqual(result.copies, []);
    assert.deepEqual(result.warnings, []);
  });

  test('ambient verilmezse anahtar yok, stilin önerisi döner', async () => {
    const result = await runNewVideo({ ...env, videoName: 'v', styleName: 'anime-cel' });
    const project = JSON.parse(await readFile(join(result.dir, 'project.json'), 'utf8'));
    assert.ok(!Object.hasOwn(project, 'ambient'));
    assert.deepEqual(result.suggestion, {
      name: 'gentleRain', ambient: { name: 'gentleRain', path: join(env.ambientDir, 'gentleRain.mp3') },
    });
  });

  test('ambient verilmezse okunamayan ambient klasörü durdurmaz, uyarı olur', async () => {
    const result = await runNewVideo({ ...env, ambientDir: join(env.base, 'yok'), videoName: 'v', styleName: 'watercolor' });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /ambient klasörü okunamadı .*önerilen ambient denetlenmedi/);
    assert.deepEqual(result.suggestion, { name: 'gentleRain', ambient: null });
  });

  test('klasör zaten varsa ProjectExistsError, içerik değişmez', async () => {
    const dir = join(env.videosDir, 'video3');
    await mkdir(dir);
    await writeFile(join(dir, 'notlar.txt'), 'elle yazıldı');
    const before = (await stat(join(dir, 'notlar.txt'))).mtimeMs;

    await assert.rejects(runNewVideo({ ...env, videoName: 'video3', styleName: 'anime-cel' }), ProjectExistsError);
    assert.deepEqual(await readdir(dir), ['notlar.txt']);
    assert.equal(await readFile(join(dir, 'notlar.txt'), 'utf8'), 'elle yazıldı');
    assert.equal((await stat(join(dir, 'notlar.txt'))).mtimeMs, before);
  });

  test('isim, stil ve ambient hataları tek seferde; hiçbir şey oluşmaz', async () => {
    await assert.rejects(
      runNewVideo({ ...env, videoName: 'video:3.', styleName: 'neo-tokyo', ambientName: 'ocean' }),
      (e) => {
        assert.ok(e instanceof NewVideoError);
        assert.equal(e.problems.length, 4, e.problems.join('\n'));
        assert.ok(e.problems[0].includes('geçersiz karakter'));
        assert.ok(e.problems[1].includes('nokta ya da boşluk'));
        assert.equal(e.problems[2], 'stil "neo-tokyo": bilinmeyen stil — mevcut: anime-cel, cozy-realistic, watercolor');
        assert.equal(e.problems[3], 'bilinmeyen ambient "ocean" — mevcut: campfire, gentleRain, heavyRain, rainStorm');
        return true;
      },
    );
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('ambient istendi ama klasör okunamıyor → problem', async () => {
    await assert.rejects(
      runNewVideo({ ...env, ambientDir: join(env.base, 'yok'), videoName: 'v', styleName: 'anime-cel', ambientName: 'campfire' }),
      (e) => e instanceof NewVideoError && e.problems.length === 1 && e.problems[0].startsWith('ambient klasörü okunamadı'),
    );
  });

  test('stilin referans görseli resimler/style-ref olarak bayt bayt kopyalanır', async () => {
    const stylesDir = join(env.base, 'styles');
    await mkdir(join(stylesDir, 'refs'), { recursive: true });
    await copyFile(join(STYLES_DIR, 'watercolor.json'), join(stylesDir, 'watercolor.json'));
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x42]);
    await writeFile(join(stylesDir, 'refs', 'watercolor.JPG'), image);

    const result = await runNewVideo({ ...env, stylesDir, videoName: 'v', styleName: 'watercolor' });
    const target = join(result.dir, 'resimler', 'style-ref.jpg');
    assert.deepEqual(result.copies, [target]);
    assert.deepEqual(await readFile(target), image);
  });

  test('build.js uyumu: clip boşken tek problem, klip yazılınca uyarısız', async () => {
    const { dir } = await runNewVideo({ ...env, videoName: 'v', styleName: 'cozy-realistic', ambientName: 'campfire' });
    const projectPath = join(dir, 'project.json');

    await assert.rejects(loadProject(projectPath), (e) =>
      e instanceof ConfigError && e.problems.length === 1 && e.problems[0].startsWith('clip:'));

    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    await writeFile(projectPath, JSON.stringify({ ...project, clip: './videolar/in.mp4' }, null, 2));

    const config = await loadProject(projectPath);
    assert.deepEqual(config.warnings, []);
    assert.equal(config.clip, join(dir, 'videolar', 'in.mp4'));
    assert.equal(config.audioDir, join(dir, 'audio'));
    assert.equal(config.ambient, join(env.ambientDir, 'campfire.mp3'));
    assert.equal(config.video.cropBottom, 150);
    assert.equal(config.video.aspect, '16:9');
    assert.equal(config.output.dir, join(dir, 'out'));
  });
});

describe('writeProject geri alma', () => {
  const makePlan = async (name, styleRef = null) => planProject({
    videosDir: env.videosDir,
    videoName: name,
    style: (await loadStyle('anime-cel')).style,
    ambient: null,
    styleRef,
    templates: await loadTemplates(),
  });

  test('ikinci dosyada yazım hatası → klasör silinir, hata iletilir', async () => {
    const plan = await makePlan('yarim');
    let calls = 0;
    const writeText = async () => { if (++calls === 2) throw new Error('disk dolu (taklit)'); };
    await assert.rejects(writeProject(plan, { writeText }), /disk dolu/);
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('kopya hatası → klasör silinir', async () => {
    const plan = await makePlan('kopya', 'X:\\yok.jpg');
    await assert.rejects(writeProject(plan, { copy: async () => { throw new Error('kopya (taklit)'); } }), /kopya/);
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('videolar kökü yoksa anlaşılır hata, hiçbir şey oluşmaz', async () => {
    const plan = await makePlan('v');
    plan.dir = join(env.base, 'yok', 'v');
    await assert.rejects(writeProject(plan), /üst klasör bulunamadı/);
  });
});

describe('main (CLI)', () => {
  test('--style yoksa stiller ve ambient\'ler listelenir, çıkış 2, klasör yok', async (t) => {
    const { code, err } = await runMain(t, ['video3', ...flags()]);
    assert.equal(code, 2);
    assert.match(err, /anime-cel\s+öneri: --ambient gentleRain · referans görseli yok/);
    assert.match(err, /cozy-realistic\s+öneri: --ambient campfire/);
    assert.ok(err.includes("Ambient'ler: campfire, gentleRain, heavyRain, rainStorm"));
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('tırnaksız isim → çıkış 2, tırnak ipucu', async (t) => {
    const { code, err } = await runMain(t, ['video3-Neo', 'Tokyo', '--style', 'anime-cel', ...flags()]);
    assert.equal(code, 2);
    assert.ok(err.includes('tırnak içinde yaz'));
  });

  test('isim eksik → 2; bilinmeyen bayrak → 2; --help → 0', async (t) => {
    assert.equal((await runMain(t, ['--style', 'anime-cel', ...flags()])).code, 2);
    assert.equal((await runMain(t, ['v', '--style', 'anime-cel', '--bilinmeyen'])).code, 2);
    const help = await runMain(t, ['--help']);
    assert.equal(help.code, 0);
    assert.ok(help.out.startsWith('Kullanım:'));
  });

  test('--styles-dir: liste ve kurulum o klasörden', async (t) => {
    const stylesDir = join(env.base, 'styles');
    await mkdir(stylesDir);
    await copyFile(join(STYLES_DIR, 'watercolor.json'), join(stylesDir, 'watercolor.json'));

    const list = await runMain(t, ['v', ...flags(), '--styles-dir', stylesDir]);
    assert.equal(list.code, 2);
    assert.match(list.err, /watercolor\s+öneri/);
    assert.ok(!list.err.includes('anime-cel'));

    assert.equal((await runMain(t, ['v', '--style', 'anime-cel', ...flags(), '--styles-dir', stylesDir])).code, 2);
    assert.equal((await runMain(t, ['v', '--style', 'watercolor', ...flags(), '--styles-dir', stylesDir])).code, 0);
  });

  test('doğrulama hatası → 2', async (t) => {
    const { code, err } = await runMain(t, ['v', '--style', 'neo-tokyo', ...flags()]);
    assert.equal(code, 2);
    assert.ok(err.includes('bilinmeyen stil'));
  });

  test('başarı → 0, öneri satırı ve sıradaki adımlar; tekrar → 1', async (t) => {
    const argv = ['video3-Test', '--style', 'cozy-realistic', ...flags()];
    const first = await runMain(t, argv);
    assert.equal(first.code, 0, first.err);
    assert.ok(first.out.startsWith(`Proje oluşturuldu: ${join(env.videosDir, 'video3-Test')}`));
    assert.ok(first.out.includes('stilin önerisi: campfire.'));
    assert.ok(first.out.includes(`"ambient": ${JSON.stringify(join(env.ambientDir, 'campfire.mp3'))},`));
    assert.ok(first.out.includes('Image 2 olarak stil görselini elle ekle'));
    assert.ok(first.out.includes('Sıradaki adımlar:'));
    assert.ok(first.out.includes(`node build.js --project "${join(env.videosDir, 'video3-Test', 'project.json')}"`));

    const second = await runMain(t, argv);
    assert.equal(second.code, 1);
    assert.ok(second.err.startsWith('klasör zaten var, dokunulmadı:'));
  });
});
