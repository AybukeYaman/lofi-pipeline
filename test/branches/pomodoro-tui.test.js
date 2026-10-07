/**
 * TUI Pomodoro akışı: ayar ekranı ve montaj öncesi engel.
 *
 * Panel ile web aynı domain fonksiyonlarına bağlı (setProjectPomodoro +
 * validatePomodoro); burada doğrulanan şey panelin o fonksiyonları doğru
 * çağırması ve doğrulama geçmeden build.js'i HİÇ başlatmaması.
 *
 * ffprobe sahte: parça süresi dosya adından okunuyor.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { inspectProject } from '../../prep/project-status.js';
import { inspectPomodoro, stepMontage, stepPomodoro } from '../../ui/actions.js';
import { BACK, createFakePrompter, pick } from '../helpers/fake-prompter.js';
import { tempDir } from '../helpers/fixtures.js';

/** Süre dosya adındaki saniyeden ("t-600.m4a" → 600 sn). */
async function fakeProbe(path) {
  const seconds = /t-(\d+(?:\.\d+)?)/.exec(path);
  if (!seconds) throw new Error(`ölçülemeyen dosya: ${path}`);
  return { duration: Number(seconds[1]), hasAudio: true };
}

/** Toplamı `totalSeconds` olan dört parçalık müzik klasörü. */
async function makeProject(dir, { pomodoro, totalSeconds }) {
  await mkdir(dir.path('audio'), { recursive: true });
  const each = totalSeconds / 4;
  for (let i = 1; i <= 4; i++) {
    await writeFile(dir.path(`audio/${String(i).padStart(2, '0')}-t-${each}.m4a`), 'x');
  }
  await writeFile(dir.path('project.json'), JSON.stringify({
    clip: './clip.mp4',
    audioDir: './audio',
    video: { cropBottom: 0 },
    ...(pomodoro ? { pomodoro } : {}),
  }, null, 2));
  await writeFile(dir.path('clip.mp4'), 'x');
  return inspectProject(dir.dir ?? dir.path('.'));
}

const projectJson = async (dir) => JSON.parse(await readFile(dir.path('project.json'), 'utf8'));

describe('TUI — Pomodoro ayar ekranı', () => {
  test('preset seçimi project.json\'a yazılır', async () => {
    const dir = await tempDir('pomodoro-tui-preset');
    try {
      await makeProject(dir, { totalSeconds: 240 * 60 });
      const status = await inspectProject(dir.path('.'));
      const prompter = createFakePrompter([pick('50 / 10'), BACK]);

      await stepPomodoro({ prompter }, dir.path('.'), status, { probeFn: fakeProbe });

      assert.deepEqual((await projectJson(dir)).pomodoro, {
        enabled: true, preset: '50/10', workMinutes: 50, breakMinutes: 10, rounds: 4,
      });
    } finally {
      await dir.cleanup();
    }
  });

  test('tur sayısı değişince kırpma onayı sıfırlanır', async () => {
    const dir = await tempDir('pomodoro-tui-rounds');
    try {
      await makeProject(dir, {
        pomodoro: { enabled: true, preset: '50/10', rounds: 4, trimExcess: true },
        totalSeconds: 253 * 60,
      });
      const status = await inspectProject(dir.path('.'));
      const prompter = createFakePrompter([pick('Tur Sayısı'), pick('8 tur'), BACK]);

      await stepPomodoro({ prompter }, dir.path('.'), status, { probeFn: fakeProbe });

      const written = (await projectJson(dir)).pomodoro;
      assert.equal(written.rounds, 8);
      // 8 turda timeline 480 dk — eski "fazlayı kırp" onayı artık anlamsız.
      assert.equal(written.trimExcess, undefined);
    } finally {
      await dir.cleanup();
    }
  });

  test('fazla müzikte kırpma onayı seçeneği çıkar ve yazılır', async () => {
    const dir = await tempDir('pomodoro-tui-trim');
    try {
      await makeProject(dir, {
        pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
        totalSeconds: 253 * 60,
      });
      const status = await inspectProject(dir.path('.'));
      const prompter = createFakePrompter([pick('Fazlayı Kırp'), BACK]);

      await stepPomodoro({ prompter }, dir.path('.'), status, { probeFn: fakeProbe });

      assert.equal((await projectJson(dir)).pomodoro.trimExcess, true);
      // Ekranda sayılar görünmüş olmalı: kullanıcı neyi onayladığını bilsin.
      assert.ok(prompter.output().includes('240:00'));
      assert.ok(prompter.output().includes('253:00'));
    } finally {
      await dir.cleanup();
    }
  });

  test('KAPALI seçimi anahtarı siler', async () => {
    const dir = await tempDir('pomodoro-tui-off');
    try {
      await makeProject(dir, {
        pomodoro: { enabled: true, preset: '30/10', rounds: 6 },
        totalSeconds: 600,
      });
      const status = await inspectProject(dir.path('.'));
      const prompter = createFakePrompter([pick('KAPALI')]);

      await stepPomodoro({ prompter }, dir.path('.'), status, { probeFn: fakeProbe });

      assert.equal(Object.hasOwn(await projectJson(dir), 'pomodoro'), false);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('TUI — montaj öncesi engel', () => {
  test('doğrulama geçmezse build.js HİÇ çalışmaz', async () => {
    const dir = await tempDir('pomodoro-tui-block');
    try {
      await makeProject(dir, {
        pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
        totalSeconds: 227.5 * 60,
      });
      const status = await inspectProject(dir.path('.'));
      const runs = [];
      // confirm → false: "ayarları açayım mı" sorusuna hayır.
      const prompter = createFakePrompter([false]);

      const result = await stepMontage(
        { prompter, run: (...args) => { runs.push(args); return 0; } },
        dir.path('.'),
        status,
        { probeFn: fakeProbe },
      );

      assert.equal(result, false);
      assert.deepEqual(runs, []);
      assert.ok(prompter.output().includes('Eksik: 12:30'));
    } finally {
      await dir.cleanup();
    }
  });

  test('Test 6 — Pomodoro kapalı projede montaj eskisi gibi başlar', async () => {
    const dir = await tempDir('pomodoro-tui-off-build');
    try {
      await makeProject(dir, { totalSeconds: 600 });
      const status = await inspectProject(dir.path('.'));
      const runs = [];
      const prompter = createFakePrompter([]);

      const result = await stepMontage(
        { prompter, run: (...args) => { runs.push(args); return 0; } },
        dir.path('.'),
        status,
        { probeFn: fakeProbe },
      );

      assert.equal(result, true);
      assert.equal(runs.length, 1, 'build.js çalışmalıydı');
      assert.ok(prompter.output().includes('Pomodoro: kapalı'));
    } finally {
      await dir.cleanup();
    }
  });
});

describe('inspectPomodoro', () => {
  test('parça sırası project.json "order" alanından gelir', async () => {
    const dir = await tempDir('pomodoro-tui-order');
    try {
      await mkdir(dir.path('audio'), { recursive: true });
      await writeFile(dir.path('audio/kisa-t-300.m4a'), 'x');
      await writeFile(dir.path('audio/uzun-t-1200.m4a'), 'x');
      await writeFile(dir.path('project.json'), JSON.stringify({
        clip: './clip.mp4',
        audioDir: './audio',
        order: ['uzun-t-1200.m4a', 'kisa-t-300.m4a'],
        pomodoro: { enabled: true, workMinutes: 10, breakMinutes: 5, rounds: 1, trimExcess: true },
      }, null, 2));

      const check = await inspectPomodoro(await inspectProject(dir.path('.')), { probeFn: fakeProbe });

      assert.equal(check.ok, true);
      assert.deepEqual(check.trim.tracks.map((t) => t.usedDuration), [900, 0]);
    } finally {
      await dir.cleanup();
    }
  });
});
