/**
 * Test yardımcısı: SunoGenerateProvider sözleşmesini yerine getiren sahte sağlayıcı.
 * Canlı API'ye hiç çıkmadan generateSong/checkStatus/waitForSong akışını sürmek için.
 *
 * Üretim kodunda kullanılmaz (fake-prompter.js ile aynı mantık).
 */

/**
 * @param {object} [options]
 * @param {string} [options.jobId] generateSong'un döndüreceği id
 * @param {Array<object>} [options.statuses] checkStatus'un sırayla döndüreceği ham cevaplar;
 *   liste bitince sonuncusu tekrarlanır. Bir eleman Error ise fırlatılır.
 * @param {object|Error} [options.generateResult] generateSong'un ham dönüşü (veya fırlatılacak hata)
 * @returns {object} provider + çağrı kayıtları (calls)
 */
export function createFakeProvider({ jobId = 'job-1', statuses = [], generateResult } = {}) {
  const calls = { generate: [], status: [] };
  let index = 0;

  return {
    name: 'fake',
    calls,
    async generateSong(request, context) {
      calls.generate.push({ request, context });
      if (generateResult instanceof Error) throw generateResult;
      return generateResult ?? { jobId };
    },
    async checkStatus(query, context) {
      calls.status.push({ query, context });
      const next = statuses.length ? statuses[Math.min(index, statuses.length - 1)] : { status: 'pending' };
      index++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** Beklemeyi anında geçen sleepFn + kaydedilen süreler. */
export function createFakeSleep() {
  const waits = [];
  const sleepFn = (done, ms) => {
    waits.push(ms);
    done();
  };
  return { sleepFn, waits };
}
