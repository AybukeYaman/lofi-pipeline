import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createLabel,
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_SIZE,
  isSystemLabel,
  LabelPlanError,
  MAX_LABEL_SIZE,
  MAX_LABEL_TEXT_LENGTH,
  MIN_LABEL_SIZE,
  nextLabelId,
  normalizeLabel,
  normalizeLabelPlan,
  serializeLabelPlan,
} from '../../core/label-plan.js';

describe('normalizeLabelPlan — geriye dönük uyumluluk', () => {
  test('labels alanı yoksa boş liste, hata/uyarı yok (eski projeler aynen kalır)', () => {
    for (const block of [undefined, null]) {
      assert.deepEqual(normalizeLabelPlan(block), { labels: [], problems: [], warnings: [] });
    }
  });

  test('dizi olmayan değer hata verir, sessizce yutulmaz', () => {
    const result = normalizeLabelPlan({ id: 'a' });
    assert.deepEqual(result.labels, []);
    assert.equal(result.problems.length, 1);
  });
});

describe('normalizeLabel — serbest metin', () => {
  test('yalnızca id + metin yeter: kalan alanlar varsayılan alır', () => {
    const { label, problems } = normalizeLabel({ id: 'a', text: 'Merhaba' });
    assert.deepEqual(problems, []);
    assert.deepEqual(label, {
      id: 'a', kind: 'text', text: 'Merhaba', x: 0.5, y: 0.9,
      size: DEFAULT_LABEL_SIZE, color: DEFAULT_LABEL_COLOR, start: null, end: null,
    });
  });

  test('konum 0–1 aralığına, boyut sınırlara kıstırılır; sayı metni kabul edilir', () => {
    const { label } = normalizeLabel({ id: 'a', text: 'x', x: '1.4', y: -3, size: 5 });
    assert.equal(label.x, 1);
    assert.equal(label.y, 0);
    assert.equal(label.size, MAX_LABEL_SIZE);
    assert.equal(normalizeLabel({ id: 'a', text: 'x', size: 0 }).label.size, MIN_LABEL_SIZE);
  });

  test('boş metin ve geçersiz id etiketi atar', () => {
    assert.equal(normalizeLabel({ id: 'a', text: '   ' }).label, null);
    assert.equal(normalizeLabel({ id: 'a b', text: 'x' }).label, null);
    assert.equal(normalizeLabel({ text: 'x' }).label, null);
    assert.equal(normalizeLabel('metin').label, null);
  });

  test('satır sonu/kontrol karakteri tek boşluğa iner, uzun metin kısaltılıp uyarılır', () => {
    assert.equal(normalizeLabel({ id: 'a', text: 'Bir\niki\t\tüç' }).label.text, 'Bir iki üç');
    const long = normalizeLabel({ id: 'a', text: 'a'.repeat(MAX_LABEL_TEXT_LENGTH + 30) });
    assert.equal(long.label.text.length, MAX_LABEL_TEXT_LENGTH);
    assert.equal(long.warnings.length, 1);
  });

  test('renk: #rgb genişler, geçersiz renk uyarıyla varsayılana döner', () => {
    assert.equal(normalizeLabel({ id: 'a', text: 'x', color: '#F80' }).label.color, '#ff8800');
    const bad = normalizeLabel({ id: 'a', text: 'x', color: 'kırmızı' });
    assert.equal(bad.label.color, DEFAULT_LABEL_COLOR);
    assert.equal(bad.warnings.length, 1);
  });

  test('zaman aralığı: ikisi birlikte olmalı, bitiş başlangıçtan sonra olmalı', () => {
    const ok = normalizeLabel({ id: 'a', text: 'x', start: 5, end: 12.3456 }).label;
    assert.equal(ok.start, 5);
    assert.equal(ok.end, 12.346);
    assert.equal(normalizeLabel({ id: 'a', text: 'x', start: 5 }).label, null);
    assert.equal(normalizeLabel({ id: 'a', text: 'x', start: 9, end: 9 }).label, null);
    assert.equal(normalizeLabel({ id: 'a', text: 'x', start: -1, end: 4 }).label, null);
  });
});

describe('normalizeLabel — sistem (Pomodoro) etiketleri', () => {
  test('metin ve zaman sistemden gelir: metin yok sayılır, start/end uyarıyla atılır', () => {
    const { label, warnings } = normalizeLabel({
      id: 's', kind: 'pomodoro-status', text: 'KENDİ METNİM', start: 1, end: 9,
    });
    assert.equal(label.text, '');
    assert.equal(label.start, null);
    assert.equal(label.end, null);
    assert.equal(warnings.length, 1);
  });

  test('sistem etiketi metin olmadan geçerli; varsayılan konum sağ üst, alt alta', () => {
    const countdown = normalizeLabel({ id: 'c', kind: 'pomodoro-countdown' }).label;
    const status = normalizeLabel({ id: 's', kind: 'pomodoro-status' }).label;
    assert.ok(countdown.x > 0.5 && countdown.y < 0.5);
    assert.equal(countdown.x, status.x);
    assert.ok(status.y > countdown.y, 'durum yazısı sayacın ALTINDA');
  });

  test('bilinmeyen tür reddedilir; isSystemLabel yalnızca pomodoro türlerinde doğru', () => {
    assert.equal(normalizeLabel({ id: 'a', kind: 'logo' }).label, null);
    assert.equal(isSystemLabel('pomodoro-status'), true);
    assert.equal(isSystemLabel('pomodoro-countdown'), true);
    assert.equal(isSystemLabel('text'), false);
  });

  test('aynı sistem türü iki kez eklenemez, metin etiketleri çoğalabilir', () => {
    const result = normalizeLabelPlan([
      { id: 'a', kind: 'pomodoro-status' },
      { id: 'b', kind: 'pomodoro-status' },
      { id: 'c', text: 'bir' },
      { id: 'd', text: 'iki' },
    ]);
    assert.deepEqual(result.labels.map((l) => l.id), ['a', 'c', 'd']);
    assert.equal(result.problems.length, 1);
  });
});

describe('normalizeLabelPlan — liste kuralları', () => {
  test('tekrar eden id atılır, geçerli kayıtlar yerinde kalır', () => {
    const result = normalizeLabelPlan([
      { id: 'a', text: 'bir' },
      { id: 'a', text: 'iki' },
      { id: 'b', text: 'üç' },
    ]);
    assert.deepEqual(result.labels.map((l) => l.id), ['a', 'b']);
    assert.equal(result.problems.length, 1);
  });

  test('eklenme sırası korunur (z sırası: sonraki üstte)', () => {
    const ids = normalizeLabelPlan([
      { id: 'z', text: 'son' }, { id: 'a', text: 'ilk' },
    ]).labels.map((l) => l.id);
    assert.deepEqual(ids, ['z', 'a']);
  });
});

describe('serializeLabelPlan', () => {
  test('varsayılandan sapmayan alan yazılmaz, konum her zaman yazılır', () => {
    const { labels } = normalizeLabelPlan([{ id: 'a', text: 'x' }]);
    assert.deepEqual(serializeLabelPlan(labels), [{ id: 'a', text: 'x', x: 0.5, y: 0.9 }]);
  });

  test('sistem etiketi `kind` yazar, `text` yazmaz', () => {
    const { labels } = normalizeLabelPlan([{ id: 's', kind: 'pomodoro-status', x: 0.2, y: 0.3 }]);
    assert.deepEqual(serializeLabelPlan(labels), [{ id: 's', kind: 'pomodoro-status', x: 0.2, y: 0.3 }]);
  });

  test('serialize → normalize gidiş-dönüş aynı sonucu verir', () => {
    const first = normalizeLabelPlan([
      { id: 'a', text: 'Merhaba', x: 0.123456, y: 0.7, size: 0.08, color: '#FF0000', start: 3, end: 20 },
      { id: 's', kind: 'pomodoro-status', x: 0.8, y: 0.2 },
      { id: 'c', kind: 'pomodoro-countdown' },
    ]).labels;
    const second = normalizeLabelPlan(serializeLabelPlan(first)).labels;
    assert.deepEqual(second.map((l) => l.id), first.map((l) => l.id));
    assert.equal(second[0].x, 0.1235);
    assert.equal(second[0].color, '#ff0000');
    assert.deepEqual(second.slice(1), first.slice(1));
  });

  test('boş liste boş dizi verir', () => {
    assert.deepEqual(serializeLabelPlan([]), []);
  });
});

describe('createLabel / nextLabelId', () => {
  test('boş listede etiket-01, dolu listede kullanılmayan ilk sayı', () => {
    assert.equal(nextLabelId([]), 'etiket-01');
    assert.equal(nextLabelId([{ id: 'etiket-01' }, { id: 'etiket-03' }]), 'etiket-02');
  });

  test('yeni etiket geçerli ve varsayılan değerlerle gelir', () => {
    const label = createLabel([], { text: 'Selam' });
    assert.equal(label.id, 'etiket-01');
    assert.equal(label.text, 'Selam');
    assert.equal(label.kind, 'text');
  });

  test('sistem etiketi ikinci kez ya da bilinmeyen tür hata verir', () => {
    const first = createLabel([], { kind: 'pomodoro-status' });
    assert.throws(() => createLabel([first], { kind: 'pomodoro-status' }), LabelPlanError);
    assert.throws(() => createLabel([], { kind: 'logo' }), LabelPlanError);
  });
});
