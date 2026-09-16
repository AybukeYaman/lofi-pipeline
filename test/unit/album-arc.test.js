import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARC_PHASES, describeArcPhases, phaseFor, energyModifiers } from '../../prep/album-arc.js';

const namesFor = (trackCount) =>
  Array.from({ length: trackCount }, (_, i) => phaseFor(i, trackCount).name);

test('ARC_PHASES - 5 faz, kesintisiz 0..1 aralığı, dondurulmuş', () => {
  assert.deepEqual(
    ARC_PHASES.map((p) => p.name),
    ['opening', 'descent', 'trough', 'ascent', 'resolution'],
  );
  assert.equal(ARC_PHASES[0].rangeStart, 0);
  assert.equal(ARC_PHASES.at(-1).rangeEnd, 1);
  for (let i = 1; i < ARC_PHASES.length; i++) {
    assert.equal(ARC_PHASES[i].rangeStart, ARC_PHASES[i - 1].rangeEnd);
  }
  assert.ok(Object.isFrozen(ARC_PHASES));
  assert.ok(Object.isFrozen(ARC_PHASES[0]));
});

test('phaseFor - 12 parçalık albümde faz dağılımı', () => {
  assert.deepEqual(namesFor(12), [
    'opening', 'opening',
    'descent', 'descent', 'descent',
    'trough', 'trough',
    'ascent', 'ascent', 'ascent',
    'resolution', 'resolution',
  ]);
});

test('phaseFor - trough 12 parçada tam ortada ve en düşük enerjili', () => {
  const troughIdx = namesFor(12)
    .map((name, i) => (name === 'trough' ? i : -1))
    .filter((i) => i >= 0);
  assert.deepEqual(troughIdx, [5, 6]);
  // Ortaya simetrik: 5 + 6 = 11 = trackCount - 1
  assert.equal(troughIdx[0] + troughIdx.at(-1), 11);

  const minEnergy = Math.min(...ARC_PHASES.map((p) => p.energy));
  assert.equal(phaseFor(5, 12).energy, minEnergy);
});

test('phaseFor - ilk parça opening, son parça resolution', () => {
  for (const n of [2, 3, 5, 12, 30]) {
    assert.equal(phaseFor(0, n).name, 'opening');
    assert.equal(phaseFor(n - 1, n).name, 'resolution');
  }
});

test('phaseFor - kenar durumlar: 1 ve 2 parça', () => {
  assert.deepEqual(namesFor(1), ['opening']);
  assert.deepEqual(namesFor(2), ['opening', 'resolution']);
});

test('phaseFor - faz sınırları yarı açık (p = rangeStart yeni faza aittir)', () => {
  // trackCount 21 → p = index / 20
  assert.equal(phaseFor(3, 21).name, 'descent'); // p = 0.15
  assert.equal(phaseFor(8, 21).name, 'trough'); // p = 0.40
  assert.equal(phaseFor(12, 21).name, 'ascent'); // p = 0.60
  assert.equal(phaseFor(17, 21).name, 'resolution'); // p = 0.85
  assert.equal(phaseFor(16, 21).name, 'ascent'); // p = 0.80
});

test('phaseFor - geçersiz girdiler RangeError fırlatır', () => {
  assert.throws(() => phaseFor(0, 0), RangeError);
  assert.throws(() => phaseFor(0, 1.5), RangeError);
  assert.throws(() => phaseFor(-1, 5), RangeError);
  assert.throws(() => phaseFor(5, 5), RangeError);
  assert.throws(() => phaseFor(1.2, 5), RangeError);
  assert.throws(() => phaseFor('0', 5), RangeError);
});

test('energyModifiers - eşik sınırları', () => {
  assert.equal(energyModifiers(0).density, 'spacious');
  assert.equal(energyModifiers(0.25).density, 'spacious');
  assert.equal(energyModifiers(0.2501).density, 'restrained');
  assert.equal(energyModifiers(0.4).density, 'restrained');
  assert.equal(energyModifiers(0.4001).density, 'balanced');
  assert.equal(energyModifiers(0.55).density, 'balanced');
  assert.equal(energyModifiers(0.5501).density, 'open');
  assert.equal(energyModifiers(1).density, 'open');
});

test('energyModifiers - tam çıktı metinleri', () => {
  assert.deepEqual(energyModifiers(0.2), {
    rhythm: 'sparse arrangement, minimal percussion, long sustained notes',
    tempo: 'very slow tempo',
    density: 'spacious',
  });
  assert.deepEqual(energyModifiers(0.35), {
    rhythm: 'gentle understated rhythm, brushed drums',
    tempo: 'slow tempo',
    density: 'restrained',
  });
  assert.deepEqual(energyModifiers(0.45), {
    rhythm: 'steady laid-back groove, soft drums',
    tempo: 'mid-slow tempo',
    density: 'balanced',
  });
  assert.deepEqual(energyModifiers(0.6), {
    rhythm: 'fuller warm rhythm, brighter chords',
    tempo: 'relaxed mid-tempo',
    density: 'open',
  });
});

test('energyModifiers - her fazın enerjisi beklenen kademeye düşer', () => {
  assert.deepEqual(
    ARC_PHASES.map((p) => energyModifiers(p.energy).density),
    ['balanced', 'restrained', 'spacious', 'balanced', 'open'],
  );
});

test('energyModifiers - dönen obje çağrılar arasında paylaşılmaz', () => {
  const a = energyModifiers(0.2);
  a.rhythm = 'mutated';
  assert.notEqual(energyModifiers(0.2).rhythm, 'mutated');
});

test('energyModifiers - geçersiz girdiler TypeError fırlatır', () => {
  assert.throws(() => energyModifiers(NaN), TypeError);
  assert.throws(() => energyModifiers(Infinity), TypeError);
  assert.throws(() => energyModifiers('0.3'), TypeError);
  assert.throws(() => energyModifiers(undefined), TypeError);
});

test('describeArcPhases - fazları sırayla ve aralıklarıyla tarif eder', () => {
  const lines = describeArcPhases().split('\n');
  assert.equal(lines.length, ARC_PHASES.length);
  assert.equal(lines[0], '- opening (0-15% of the album): energy 0.45, mid-slow tempo, balanced');
  assert.equal(lines[2], '- trough (40-60% of the album): energy 0.2, very slow tempo, spacious');
  assert.equal(lines[4], '- resolution (85-100% of the album): energy 0.6, relaxed mid-tempo, open');
});
