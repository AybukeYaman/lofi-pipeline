import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planProject } from '../../prep/scaffold.js';
import { inspectProject, listProjects } from '../../prep/project-status.js';
import { copyTracksFromProject, createProject, getProjects } from '../../server/project-api.js';

describe('alt proje ve müzik aktarımı (subprojects)', () => {
  it('planProject parentId alanını project.json içine yazar', () => {
    const plan = planProject({
      videosDir: 'C:\\test\\videolar',
      videoName: 'sub1',
      parentId: 'main-video',
      templates: [],
    });

    const projectJsonFile = plan.files.find((f) => f.name === 'project.json');
    assert.ok(projectJsonFile);
    const parsed = JSON.parse(projectJsonFile.content);
    assert.equal(parsed.parentId, 'main-video');
  });

  it('inspectProject ve listProjects parentId bilgisini diskten okur', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-subproject-test-'));
    try {
      const mainDir = join(tempDir, 'main-proj');
      const subDir = join(tempDir, 'sub-proj');
      await mkdir(join(mainDir, 'resimler'), { recursive: true });
      await mkdir(join(subDir, 'resimler'), { recursive: true });

      await writeFile(join(mainDir, 'project.json'), JSON.stringify({ clip: '', video: { aspect: '16:9' } }));
      await writeFile(join(subDir, 'project.json'), JSON.stringify({ clip: '', parentId: 'main-proj', video: { aspect: '16:9' } }));

      const mainStatus = await inspectProject(mainDir);
      const subStatus = await inspectProject(subDir);
      assert.equal(mainStatus.parentId, null);
      assert.equal(subStatus.parentId, 'main-proj');

      const listed = await listProjects(tempDir);
      const subListed = listed.find((p) => p.name === 'sub-proj');
      assert.ok(subListed);
      assert.equal(subListed.parentId, 'main-proj');

      const summaries = await getProjects({ videosDir: tempDir });
      const subSummary = summaries.find((p) => p.id === 'sub-proj');
      assert.ok(subSummary);
      assert.equal(subSummary.parentId, 'main-proj');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('createProject ile üst projeden seçilen müzikler kopyalanır ve parentId atanır', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-subproject-create-'));
    try {
      // Önce ana projeyi oluşturalım
      const mainRes = await createProject(
        { name: 'main-proj' },
        { videosDir: tempDir }
      );
      assert.equal(mainRes.project.name, 'main-proj');

      // Ana projenin audio klasörüne örnek ses dosyaları koyalım
      const mainAudioDir = join(tempDir, 'main-proj', 'audio');
      await writeFile(join(mainAudioDir, 'track01.mp3'), 'fake-audio-1');
      await writeFile(join(mainAudioDir, 'track02.mp3'), 'fake-audio-2');

      // Alt projeyi oluşturalım ve sadece track01.mp3'ü seçelim
      const subRes = await createProject(
        {
          name: 'sub-proj',
          parentId: 'main-proj',
          selectedTracks: ['track01.mp3'],
        },
        { videosDir: tempDir }
      );

      assert.equal(subRes.project.parentId, 'main-proj');

      // Alt projenin audio klasöründe track01.mp3 kopyalanmış olmalı
      const subAudioContent = await readFile(join(tempDir, 'sub-proj', 'audio', 'track01.mp3'), 'utf8');
      assert.equal(subAudioContent, 'fake-audio-1');

      // track02 kopyalanmamış olmalı
      const subStatus = await inspectProject(join(tempDir, 'sub-proj'));
      assert.equal(subStatus.audioCount, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('copyTracksFromProject ana projeden alt projeye sonradan müzik aktarır', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-subproject-copy-'));
    try {
      await createProject({ name: 'main-proj' }, { videosDir: tempDir });
      await createProject({ name: 'sub-proj', parentId: 'main-proj' }, { videosDir: tempDir });

      const mainAudioDir = join(tempDir, 'main-proj', 'audio');
      await writeFile(join(mainAudioDir, 'songA.mp3'), 'songA-content');
      await writeFile(join(mainAudioDir, 'songB.mp3'), 'songB-content');

      const copyRes = await copyTracksFromProject(
        'sub-proj',
        { sourceProjectId: 'main-proj', trackFiles: ['songB.mp3'] },
        { videosDir: tempDir }
      );

      assert.equal(copyRes.ok, true);
      assert.equal(copyRes.copiedCount, 1);
      assert.deepEqual(copyRes.copiedFiles, ['songB.mp3']);

      const copiedContent = await readFile(join(tempDir, 'sub-proj', 'audio', 'songB.mp3'), 'utf8');
      assert.equal(copiedContent, 'songB-content');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('planProject ve createProject aspect seçeneğini (16:9 / 9:16) destekler', async () => {
    const plan916 = planProject({
      videosDir: 'C:\\test\\videolar',
      videoName: 'shorts-video',
      aspect: '9:16',
      templates: [],
    });
    const parsed916 = JSON.parse(plan916.files.find((f) => f.name === 'project.json').content);
    assert.equal(parsed916.video.aspect, '9:16');

    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-aspect-create-'));
    try {
      const res = await createProject(
        { name: 'vertical-proj', aspect: '9:16' },
        { videosDir: tempDir }
      );
      assert.equal(res.project.projectJson.data?.video?.aspect, '9:16');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('createProject: Pomodoro seçildiyse düzen proje kurulurken yazılır, Ambiance seçilirse hiçbir şey yazılmaz', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-create-pomodoro-'));
    try {
      const pomodoro = await createProject(
        { name: 'pomo-proj', pomodoro: { statuses: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }], rounds: 2 } },
        { videosDir: tempDir },
      );
      assert.deepEqual(pomodoro.project.projectJson.data.pomodoro, {
        enabled: true,
        rounds: 2,
        statuses: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }],
      });
      assert.equal(pomodoro.project.readiness.pomodoro.totalMinutes, 112);

      const ambiance = await createProject({ name: 'ambiance-proj' }, { videosDir: tempDir });
      assert.equal(Object.hasOwn(ambiance.project.projectJson.data, 'pomodoro'), false);
      assert.equal(ambiance.project.readiness.pomodoro.enabled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('createProject: özel durum listesi proje kurulurken yazılır', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-create-statuses-'));
    try {
      const statuses = [
        { name: 'STUDY', minutes: 25 },
        { name: 'STRETCH', minutes: 5, beep: false },
        { name: 'BREAK', minutes: 10 },
      ];
      const created = await createProject({ name: 'custom-pomo', pomodoro: { statuses, rounds: 3 } }, { videosDir: tempDir });
      assert.deepEqual(created.project.projectJson.data.pomodoro, { enabled: true, rounds: 3, statuses });
      assert.equal(created.project.readiness.pomodoro.totalMinutes, 2 + 3 * 40 - 15);

      await assert.rejects(
        createProject({ name: 'bad-statuses', pomodoro: { statuses: [{ name: '', minutes: 5 }] } }, { videosDir: tempDir }),
        (error) => error.status === 422 && error.details.problems.some((p) => p.includes('statuses[0].name')),
      );
      await assert.rejects(readFile(join(tempDir, 'bad-statuses', 'project.json')), { code: 'ENOENT' });

      // Çoklu set de kurulumda yazılır.
      const sets = [
        { steps: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }] },
        { steps: [{ name: 'STUDY', minutes: 50 }, { name: 'LONG BREAK', minutes: 20 }] },
      ];
      const multi = await createProject({ name: 'multi-set', pomodoro: { sets, rounds: 2 } }, { videosDir: tempDir });
      assert.deepEqual(multi.project.projectJson.data.pomodoro, { enabled: true, rounds: 2, sets });
      assert.equal(multi.project.readiness.pomodoro.totalMinutes, 2 + 2 * 130 - 20);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('createProject: geçersiz Pomodoro düzeni klasör kurulmadan 422 verir', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'lofi-create-pomodoro-bad-'));
    try {
      await assert.rejects(
        createProject({ name: 'bad-pomo', pomodoro: { rounds: 0 } }, { videosDir: tempDir }),
        (error) => error.status === 422 && error.details.problems.some((p) => p.includes('pomodoro.rounds')),
      );
      await assert.rejects(readFile(join(tempDir, 'bad-pomo', 'project.json')), { code: 'ENOENT' });

      // Eski anahtarlar (preset, workMinutes, breakMinutes, breakClip) API'de kabul edilmez.
      for (const pomodoro of [{ preset: '50/10' }, { workMinutes: 50 }, { breakMinutes: 10 }, { breakClip: 'videolar/x.mp4' }]) {
        await assert.rejects(
          createProject({ name: 'bad-pomo2', pomodoro }, { videosDir: tempDir }),
          (error) => error.status === 400 && /statuses/.test(error.message),
        );
      }
      await assert.rejects(readFile(join(tempDir, 'bad-pomo2', 'project.json')), { code: 'ENOENT' });
      // Durum ve GET READY görüntüleri de kurulumda verilemez.
      for (const pomodoro of [
        { statuses: [{ name: 'A', minutes: 5, visual: 'resimler/x.png' }] },
        { intro: { visual: 'resimler/x.png' } },
        { sets: [{ steps: [{ name: 'A', minutes: 5, visual: 'resimler/x.png' }] }] },
        { sets: [{ statuses: [{ name: 'A', minutes: 5, visual: 'resimler/x.png' }] }] },
      ]) {
        await assert.rejects(
          createProject({ name: 'bad-pomo3', pomodoro }, { videosDir: tempDir }),
          (error) => error.status === 400,
        );
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
