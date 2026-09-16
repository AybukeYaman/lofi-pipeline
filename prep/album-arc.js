/**
 * Albüm yay motoru (deterministik, saf fonksiyonlar).
 * Parçanın albümdeki konumundan faz ve enerji tabanlı stil niteleyicileri üretir.
 */

/**
 * 5 fazlı enerji eğrisi. Aralıklar yarı açık [rangeStart, rangeEnd);
 * son faz 1.00'i de kapsar.
 */
export const ARC_PHASES = Object.freeze([
  Object.freeze({ name: 'opening', rangeStart: 0.0, rangeEnd: 0.15, energy: 0.45 }),
  Object.freeze({ name: 'descent', rangeStart: 0.15, rangeEnd: 0.4, energy: 0.35 }),
  Object.freeze({ name: 'trough', rangeStart: 0.4, rangeEnd: 0.6, energy: 0.2 }),
  Object.freeze({ name: 'ascent', rangeStart: 0.6, rangeEnd: 0.85, energy: 0.45 }),
  Object.freeze({ name: 'resolution', rangeStart: 0.85, rangeEnd: 1.0, energy: 0.6 }),
]);

/**
 * Enerji eşikleri: energy <= maxEnergy olan ilk kademe seçilir.
 */
const ENERGY_TIERS = Object.freeze([
  Object.freeze({
    maxEnergy: 0.25,
    rhythm: 'sparse arrangement, minimal percussion, long sustained notes',
    tempo: 'very slow tempo',
    density: 'spacious',
  }),
  Object.freeze({
    maxEnergy: 0.4,
    rhythm: 'gentle understated rhythm, brushed drums',
    tempo: 'slow tempo',
    density: 'restrained',
  }),
  Object.freeze({
    maxEnergy: 0.55,
    rhythm: 'steady laid-back groove, soft drums',
    tempo: 'mid-slow tempo',
    density: 'balanced',
  }),
  Object.freeze({
    maxEnergy: Infinity,
    rhythm: 'fuller warm rhythm, brighter chords',
    tempo: 'relaxed mid-tempo',
    density: 'open',
  }),
]);

/**
 * Parçanın albümdeki fazını döndürür.
 *
 * @param {number} index - 0 tabanlı parça sırası
 * @param {number} trackCount - Albümdeki toplam parça sayısı (>= 1)
 * @returns {{name: string, rangeStart: number, rangeEnd: number, energy: number}}
 * @throws {RangeError} Geçersiz index veya trackCount
 */
export function phaseFor(index, trackCount) {
  if (!Number.isInteger(trackCount) || trackCount < 1) {
    throw new RangeError(`trackCount pozitif tam sayı olmalı, verilen: ${trackCount}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= trackCount) {
    throw new RangeError(`index 0..${trackCount - 1} aralığında tam sayı olmalı, verilen: ${index}`);
  }
  if (trackCount === 1) {
    return ARC_PHASES[0];
  }

  const p = index / (trackCount - 1);
  return ARC_PHASES.find((phase) => p < phase.rangeEnd) ?? ARC_PHASES[ARC_PHASES.length - 1];
}

/**
 * Enerji değerinden Suno stil niteleyicilerini üretir.
 *
 * @param {number} energy - Faz enerjisi
 * @returns {{rhythm: string, tempo: string, density: string}}
 * @throws {TypeError} energy sonlu bir sayı değilse
 */
export function energyModifiers(energy) {
  if (typeof energy !== 'number' || !Number.isFinite(energy)) {
    throw new TypeError(`energy sonlu bir sayı olmalı, verilen: ${energy}`);
  }
  const { rhythm, tempo, density } = ENERGY_TIERS.find((tier) => energy <= tier.maxEnergy);
  return { rhythm, tempo, density };
}

/**
 * Yayın LLM prompt'larına gömülecek metin tarifi. Planlayıcılar yayı kendileri
 * tarif etmez; tek kaynak ARC_PHASES'tir.
 *
 * @returns {string} faz başına bir satır, sonunda satır sonu yok
 */
export function describeArcPhases() {
  return ARC_PHASES.map(({ name, rangeStart, rangeEnd, energy }) => {
    const { tempo, density } = energyModifiers(energy);
    const range = `${Math.round(rangeStart * 100)}-${Math.round(rangeEnd * 100)}%`;
    return `- ${name} (${range} of the album): energy ${energy}, ${tempo}, ${density}`;
  }).join('\n');
}
