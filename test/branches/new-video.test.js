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
import { ProjectExistsError, planProject, writeProject } from '../../prep/scaffold.js';
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
      ...env, videoName: 'video3-Neo Tokyo & Night', ambientName: 'HEAVYRAIN',
    });
    const dir = join(env.videosDir, 'video3-Neo Tokyo & Night');
    assert.equal(result.dir, dir);
    assert.deepEqual((await readdir(dir)).sort(), ['audio', 'project.json', 'resimler', 'videolar']);
    for (const sub of ['audio', 'resimler', 'videolar']) assert.deepEqual(await readdir(join(dir, sub)), []);

    // PowerShell 5.1 Get-Content BOM'suz UTF-8'i cp1254 okuyor ("â€”") — insan okuduğu dosyalar BOM'lu.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const [name, withBom] of [['project.json', false]]) {
      const bytes = await readFile(join(dir, name));
      assert.equal(bytes.subarray(0, 3).equals(bom), withBom, `${name}: BOM`);
      if (withBom) assert.notEqual(bytes[3], 0xef, `${name}: çift BOM`);
      assert.ok(!bytes.includes(0x0d), `${name}: CR`);
    }

    const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.equal(project.ambient, join(env.ambientDir, 'heavyRain.mp3'));
    assert.equal(result.ambient.name, 'heavyRain');
    assert.equal(result.suggestion, null);
    assert.deepEqual(result.warnings, []);
  });

  test('project.json\'da stil anahtarı yok (stil kavramı kaldırıldı)', async () => {
    const result = await runNewVideo({ ...env, videoName: 'stilsiz' });
    const project = JSON.parse(await readFile(join(result.dir, 'project.json'), 'utf8'));
    assert.ok(!Object.hasOwn(project, 'style'));
    assert.equal(result.suggestion, null);
  });

  test('ambient verilmezse okunamayan ambient klasörü durdurmaz, uyarı olur', async () => {
    const result = await runNewVideo({ ...env, ambientDir: join(env.base, 'yok'), videoName: 'v' });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /ambient klasörü okunamadı .*önerilen ambient denetlenmedi/);
    assert.equal(result.suggestion, null);
  });

  test('klasör zaten varsa ProjectExistsError, içerik değişmez', async () => {
    const dir = join(env.videosDir, 'video3');
    await mkdir(dir);
    await writeFile(join(dir, 'notlar.txt'), 'elle yazıldı');
    const before = (await stat(join(dir, 'notlar.txt'))).mtimeMs;

    await assert.rejects(runNewVideo({ ...env, videoName: 'video3' }), ProjectExistsError);
    assert.deepEqual(await readdir(dir), ['notlar.txt']);
    assert.equal(await readFile(join(dir, 'notlar.txt'), 'utf8'), 'elle yazıldı');
    assert.equal((await stat(join(dir, 'notlar.txt'))).mtimeMs, before);
  });

  test('isim ve ambient hataları tek seferde; hiçbir şey oluşmaz', async () => {
    await assert.rejects(
      runNewVideo({ ...env, videoName: 'video:3.', ambientName: 'ocean' }),
      (e) => {
        assert.ok(e instanceof NewVideoError);
        assert.equal(e.problems.length, 3, e.problems.join('\n'));
        assert.ok(e.problems[0].includes('geçersiz karakter'));
        assert.ok(e.problems[1].includes('nokta ya da boşluk'));
        assert.equal(e.problems[2], 'bilinmeyen ambient "ocean" — mevcut: campfire, gentleRain, heavyRain, rainStorm');
        return true;
      },
    );
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('ambient istendi ama klasör okunamıyor → problem', async () => {
    await assert.rejects(
      runNewVideo({ ...env, ambientDir: join(env.base, 'yok'), videoName: 'v', ambientName: 'campfire' }),
      (e) => e instanceof NewVideoError && e.problems.length === 1 && e.problems[0].startsWith('ambient klasörü okunamadı'),
    );
  });

  test('build.js uyumu: clip boşken tek problem, klip yazılınca uyarısız', async () => {
    const { dir } = await runNewVideo({ ...env, videoName: 'v', ambientName: 'campfire' });
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
    // config.ambient artık normalize edilmiş Ambiance planı (core/ambient-plan.js);
    // tek metinle yazılan seçim tek parçalı layer planına çözülür.
    assert.deepEqual(config.ambient.tracks, [
      { path: join(env.ambientDir, 'campfire.mp3'), volumeDb: null },
    ]);
    assert.equal(config.ambient.mode, 'layer');
    assert.equal(config.video.cropBottom, 150);
    assert.equal(config.video.aspect, '16:9');
    assert.equal(config.output.dir, join(dir, 'out'));
  });
});

describe('writeProject geri alma', () => {
  const makePlan = async (name) => planProject({
    videosDir: env.videosDir,
    videoName: name,
    ambient: null,
  });

  test('dosya yazımı hata verirse klasör silinir, hata iletilir', async () => {
    const plan = await makePlan('yarim');
    let calls = 0;
    const writeText = async () => { if (++calls === 1) throw new Error('disk dolu (taklit)'); };
    await assert.rejects(writeProject(plan, { writeText }), /disk dolu/);
    assert.deepEqual(await readdir(env.videosDir), []);
  });

  test('videolar kökü yoksa anlaşılır hata, hiçbir şey oluşmaz', async () => {
    const plan = await makePlan('v');
    plan.dir = join(env.base, 'yok', 'v');
    await assert.rejects(writeProject(plan), /üst klasör bulunamadı/);
  });
});

describe('main (CLI)', () => {
  test('proje kurulur (müzik tarifi planlayıcının varsayılanı)', async (t) => {
    const { code, err } = await runMain(t, ['video3', ...flags()]);
    assert.equal(code, 0, err);
    assert.deepEqual(await readdir(env.videosDir), ['video3']);
  });

  test('tırnaksız isim → çıkış 2, tırnak ipucu', async (t) => {
    const { code, err } = await runMain(t, ['video3-Neo', 'Tokyo', ...flags()]);
    assert.equal(code, 2);
    assert.ok(err.includes('tırnak içinde yaz'));
  });

  test('isim eksik → 2; bilinmeyen bayrak → 2; --help → 0', async (t) => {
    assert.equal((await runMain(t, [...flags()])).code, 2);
    assert.equal((await runMain(t, ['v', '--bilinmeyen'])).code, 2);
    const help = await runMain(t, ['--help']);
    assert.equal(help.code, 0);
    assert.ok(help.out.startsWith('Kullanım:'));
  });

  test('doğrulama hatası → 2', async (t) => {
    const { code, err } = await runMain(t, ['v', '--ambient', 'neo-tokyo', ...flags()]);
    assert.equal(code, 2);
    assert.ok(err.includes('bilinmeyen ambient'));
  });

  test('başarı → 0, öneri satırı ve sıradaki adımlar; tekrar → 1', async (t) => {
    const argv = ['video3-Test', '--ambient', 'campfire', ...flags()];
    const first = await runMain(t, argv);
    assert.equal(first.code, 0, first.err);
    assert.ok(first.out.startsWith(`Proje oluşturuldu: ${join(env.videosDir, 'video3-Test')}`));
    // Seçilen ambient artık ekrana basılmıyor (o satır stilin ÖNERİSİ içindi,
    // stil kavramı kaldırıldı). Asıl iddia zaten dosyada: seçim yazıldı mı.
    const written = JSON.parse(await readFile(join(env.videosDir, 'video3-Test', 'project.json'), 'utf8'));
    assert.equal(written.ambient, join(env.ambientDir, 'campfire.mp3'));
    assert.ok(first.out.includes('Sıradaki adımlar:'));
    assert.ok(first.out.includes(`node build.js --project "${join(env.videosDir, 'video3-Test', 'project.json')}"`));

    const second = await runMain(t, argv);
    assert.equal(second.code, 1);
    assert.ok(second.err.startsWith('klasör zaten var, dokunulmadı:'));
  });
});
