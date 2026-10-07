/**
 * steps/06-pomodoro-cues.js — işaret seslerinin bindirme filtresi.
 *
 * Yerleşimin doğruluğu uçtan uca ölçülüyor (test/branches/build-pomodoro.test.js
 * beep'leri nihai videodan geri okuyor). Buradaki testler o pahalı testin
 * yakalayamadığı yapısal kuralları tutuyor: her ses bir kez girdi olur,
 * kopyalar `asplit` ile üretilir, gecikme milisaniyedir ve `amix` müziğin
 * seviyesini bölmez.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCueEvents, buildTimeline, normalizePomodoroSelection } from '../../core/pomodoro-plan.js';
import { buildCueFilter, cueKind } from '../../steps/06-pomodoro-cues.js';

const sounds = (...kinds) => new Map(kinds.map((kind) => [kind, { path: `C:\\ws\\cue.${kind}.wav` }]));

const planOf = (raw) => normalizePomodoroSelection({ enabled: true, ...raw }).plan;

describe('cueKind', () => {
  it('beep her oturumda aynı, başlangıç efekti WORK/BREAK için ayrı', () => {
    assert.equal(cueKind({ type: 'beep', kind: 'work' }), 'beep');
    assert.equal(cueKind({ type: 'beep', kind: 'break' }), 'beep');
    assert.equal(cueKind({ type: 'start', kind: 'work' }), 'work');
    assert.equal(cueKind({ type: 'start', kind: 'break' }), 'break');
  });
});

describe('buildCueFilter', () => {
  const events = [
    { atSeconds: 0, type: 'start', kind: 'work' },
    { atSeconds: 57, type: 'beep', kind: 'break' },
    { atSeconds: 58, type: 'beep', kind: 'break' },
    { atSeconds: 60, type: 'start', kind: 'break' },
  ];

  it('her ses TEK girdi olur, olay sayısı kadar değil', () => {
    const { inputArgs } = buildCueFilter({ events, sounds: sounds('beep', 'work', 'break') });
    // 4 olay var ama 3 ayrı ses: aynı beep iki kez dosya olarak açılmaz.
    assert.equal(inputArgs.filter((arg) => arg === '-i').length, 3);
  });

  it('kopyalar asplit ile üretilir; sayı o sesin olay sayısı kadar', () => {
    const { filter } = buildCueFilter({ events, sounds: sounds('beep', 'work', 'break') });
    assert.ok(filter.includes('asplit=2'), 'iki beep olayı için asplit=2');
    assert.equal((filter.match(/asplit=1/g) ?? []).length, 2, 'work ve break birer kez');
  });

  it('gecikme milisaniye ve her kanala uygulanır', () => {
    const { filter } = buildCueFilter({ events, sounds: sounds('beep', 'work', 'break') });
    for (const ms of [0, 57000, 58000, 60000]) {
      assert.ok(filter.includes(`adelay=${ms}:all=1`), `${ms} ms gecikmesi yok`);
    }
  });

  it('girdi 0 müziktir; işaret sesleri 1\'den başlar', () => {
    const { filter } = buildCueFilter({ events, sounds: sounds('beep', 'work', 'break') });
    assert.ok(filter.includes('[1:a]asplit'));
    assert.ok(filter.includes('[0:a]['), 'amix müzikle başlamalı');
    assert.ok(!filter.includes('[0:a]asplit'), 'müzik bölünmemeli');
  });

  it('amix müziğin seviyesini bölmez ve çıktıyı uzatmaz', () => {
    const { filter } = buildCueFilter({ events, sounds: sounds('beep', 'work', 'break') });
    // Müzik + 4 olay = 5 girdi.
    assert.ok(filter.includes('amix=inputs=5'));
    assert.ok(filter.includes('normalize=0'), 'normalize=0 olmadan 200 olayda müzik duyulmaz');
    assert.ok(filter.includes('weights=1 1 1 1 1'));
    assert.ok(filter.includes('duration=first'), 'çıktı müziğin süresinde kalmalı');
  });

  it('kapatılan ses türü filtreye hiç girmez', () => {
    const quiet = planOf({ preset: '50/10', rounds: 2, countdownBeep: false, breakStartSound: false });
    const cues = buildCueEvents(quiet, buildTimeline(quiet));
    const { filter, inputArgs } = buildCueFilter({ events: cues.events, sounds: sounds('work') });

    assert.equal(inputArgs.filter((arg) => arg === '-i').length, 1);
    assert.ok(!filter.includes('cue.beep.wav'));
    assert.ok(!filter.includes('cue.break.wav'));
  });

  it('gerçek bir planın bütün olayları tek amix\'te toplanır', () => {
    const plan = planOf({ preset: '50/10', rounds: 4 });
    const cues = buildCueEvents(plan, buildTimeline(plan));
    const { filter } = buildCueFilter({ events: cues.events, sounds: sounds('beep', 'work', 'break') });

    assert.equal((filter.match(/amix=/g) ?? []).length, 1);
    assert.equal(
      (filter.match(/adelay=/g) ?? []).length,
      cues.events.length,
      'her olay tam bir kez gecikmeli kopya almalı',
    );
  });
});
