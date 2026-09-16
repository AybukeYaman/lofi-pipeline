#!/usr/bin/env node
/**
 * Aşama 11e/11f — canlı kabul denemesi. Elle çalıştırılır, npm test'e dahil değil
 * (gerçek Gemini + apiframe isteği atar, kredi harcar).
 *
 *   node scripts/album-try.js --style anime-cel --concept "Night walk" --plan-only
 *   node scripts/album-try.js --style anime-cel --concept "Night walk" --tracks 1
 *
 * --plan-only yalnızca Gemini'yi çağırır ve stil dizelerini yazar; Suno kredisi harcamaz.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { formatAlbumSummary, generateAlbum, planAlbum } from '../prep/album-chain.js';
import { apiframeProvider } from '../prep/providers/apiframe-suno.js';

const { values } = parseArgs({
  options: {
    style: { type: 'string' },
    concept: { type: 'string' },
    tracks: { type: 'string', default: '1' },
    out: { type: 'string', default: 'videolar/_album-deneme/audio' },
    model: { type: 'string' },
    'plan-only': { type: 'boolean', default: false },
  },
});

/**
 * process.exit() KULLANMA: fetch (undici) keep-alive soketleri kapanırken zorla çıkmak
 * Node 24 / Windows'ta libuv assertion'ı ile çöker (src/win/async.c). Çıkış kodu
 * process.exitCode ile verilir, süreç event loop boşalınca kendiliğinden kapanır.
 * Polling beklemeleri (setTimeout) bilerek unref EDİLMEZ — süreci job bitene kadar ayakta tutar.
 *
 * @returns {Promise<number>} çıkış kodu
 */
async function main() {
  if (!values.style || !values.concept) {
    console.error('Kullanım: node scripts/album-try.js --style <stil> --concept "<konsept>" [--tracks 1] [--out <klasör>] [--model V5_5] [--plan-only]');
    return 2;
  }

  try {
    const plan = await planAlbum({ concept: values.concept, styleName: values.style, trackCount: Number(values.tracks) });
    console.log(`Albüm: ${plan.albumTitle}`);
    for (const t of plan.tracks) {
      console.log(`\n${String(t.index).padStart(2, '0')} ${t.title} [${t.phase}] (${t.styleString.length}/1000)\n  style: ${t.styleString}\n  negative: ${t.negativeTags || '(yok)'}`);
    }
    if (values['plan-only']) return 0;

    const outputDir = resolve(values.out);
    console.log(`\nÜretim başlıyor → ${outputDir}`);
    const summary = await generateAlbum(plan.tracks, {
      outputDir,
      provider: apiframeProvider,
      albumTitle: plan.albumTitle,
      modelVersion: values.model,
      onTrack: ({ track, stage, detail }) => console.log(`  [${String(track.index).padStart(2, '0')}] ${stage}${detail?.jobId ? ` (${detail.jobId})` : ''}`),
      onProgress: ({ attempt, status, waitMs }) => console.log(`      deneme ${attempt}: ${status}, ${Math.round(waitMs / 1000)} sn bekleniyor`),
    });
    console.log(`\n${formatAlbumSummary(summary)}`);
    if (summary.manifestPath) console.log(`Manifest: ${summary.manifestPath}`);
    return summary.failed.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`HATA (${err.name}): ${err.message}`);
    return 1;
  }
}

process.exitCode = await main();
