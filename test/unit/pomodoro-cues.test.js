/**
 * steps/06-pomodoro-cues.js — bip bindirme filtresi.
 *
 * Yerleşimin doğruluğu uçtan uca ölçülüyor (test/branches/build-pomodoro.test.js
 * bipleri nihai videodan geri okuyor). Buradaki testler o pahalı testin
 * yakalayamadığı yapısal kuralları tutuyor: bip tek girdi olur, kopyalar
 * `asplit` ile üretilir, gecikme milisaniyedir, `amix` müziğin seviyesini
 * bölmez ve videonun sonundaki ses kararması bipleri kısmaz.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCueEvents, buildTimeline, normalizePomodoroSelection } from '../../core/pomodoro-plan.js';
import { buildCueFilter } from '../../steps/06-pomodoro-cues.js';

const SOUND = 'C:\\ws\\cue.beep.wav';

const planOf = (raw) => normalizePomodoroSelection({ enabled: true, ...raw }).plan;

describe('buildCueFilter', () => {
  const events = [
    { atSeconds: 117 }, { atSeconds: 118 }, { atSeconds: 119 }, { atSeconds: 3597.5 },
  ];

  it('bip TEK girdi olur, olay sayısı kadar değil', () => {
    const { inputArgs } = buildCueFilter({ events, soundPath: SOUND });
    assert.deepEqual(inputArgs, ['-i', SOUND]);
  });

  it('kopyalar asplit ile üretilir; sayı olay sayısı kadar', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND });
    assert.ok(filter.includes('[1:a]asplit=4'), 'dört olay için asplit=4');
  });

  it('gecikme milisaniye ve her kanala uygulanır', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND });
    for (const ms of [117000, 118000, 119000, 3597500]) {
      assert.ok(filter.includes(`adelay=${ms}:all=1`), `${ms} ms gecikmesi yok`);
    }
  });

  it('girdi 0 müziktir; bip girdi 1', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND });
    assert.ok(filter.includes('[1:a]asplit'));
    assert.ok(filter.includes('[0:a]['), 'amix müzikle başlamalı');
    assert.ok(!filter.includes('[0:a]asplit'), 'müzik bölünmemeli');
  });

  it('amix müziğin seviyesini bölmez ve çıktıyı uzatmaz', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND });
    // Müzik + 4 olay = 5 girdi.
    assert.ok(filter.includes('amix=inputs=5'));
    assert.ok(filter.includes('normalize=0'), 'normalize=0 olmadan 150 olayda müzik duyulmaz');
    assert.ok(filter.includes('weights=1 1 1 1 1'));
    assert.ok(filter.includes('duration=first'), 'çıktı müziğin süresinde kalmalı');
  });

  it('ses kararması yalnızca MÜZİĞE uygulanır, bipler karışımdan sonra eklenir (kısılmaz)', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND, musicSeconds: 7320, fadeOut: 5 });
    assert.ok(filter.includes('[0:a]afade=t=out:st=7315:d=5[music]'));
    assert.ok(filter.includes('[music][e0]'), 'amix kararmış müzikle başlamalı');
    assert.equal((filter.match(/afade/g) ?? []).length, 1, 'bipe fade uygulanmamalı');
  });

  it('fadeOut 0 ise müziğe dokunulmaz', () => {
    const { filter } = buildCueFilter({ events, soundPath: SOUND, musicSeconds: 7320, fadeOut: 0 });
    assert.ok(!filter.includes('afade'));
    assert.ok(filter.includes('[0:a]['));
  });

  it('gerçek bir planın bütün bipleri tek amix\'te toplanır', () => {
    const plan = planOf({ preset: '50/10', rounds: 4 });
    const cues = buildCueEvents(plan, buildTimeline(plan));
    const { filter } = buildCueFilter({ events: cues.events, soundPath: SOUND });

    assert.equal((filter.match(/amix=/g) ?? []).length, 1);
    assert.equal(
      (filter.match(/adelay=/g) ?? []).length,
      cues.events.length,
      'her bip tam bir kez gecikmeli kopya almalı',
    );
    // GET READY + 7 oturum (son BREAK videoya girmez), her birinde 3 bip.
    assert.equal(cues.events.length, 24);
  });
});
