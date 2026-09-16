#!/usr/bin/env node
/**
 * Suno tarayıcı botu — canlı deneme. Elle çalıştırılır, npm test'e dahil değil
 * (görünür Chromium açar, gerçek suno.com'a bağlanır, Suno kredisi harcar).
 *
 *   node scripts/suno-bot-try.js --style "lofi hip hop, rhodes, tape hiss" --title "Rain" --negative "vocals, EDM"
 *
 * Oturum kalıcı tarayıcı profilinden gelir (önce: node scripts/suno-login.js). Profilde oturum
 * yoksa varsa SUNO_COOKIE denenir, o da olmazsa tarayıcıda elle giriş beklenir.
 * Captcha çıkarsa terminal "captcha bekleniyor, elle çöz" der; tarayıcıda çöz, bot devam eder.
 * Seçiciler tutmazsa hata mesajı hangi alanın bulunamadığını söyler → SELECTORS güncellenir.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { generateSong, waitForSong } from '../prep/suno-generate.js';
import { audioExtension, downloadAudio, sanitizeFilename } from '../prep/suno-ingest.js';
import { PROFILE_API_KEY, createSunoBrowserBot, resolveSunoCookie } from '../prep/providers/suno-browser-bot.js';

const { values } = parseArgs({
  options: {
    style: { type: 'string' },
    title: { type: 'string', default: 'Bot Deneme' },
    negative: { type: 'string', default: '' },
    out: { type: 'string', default: 'videolar/_bot-deneme/audio' },
    vocal: { type: 'boolean', default: false },
  },
});

/** process.exit() kullanılmaz (bkz. album-try.js); çıkış kodu process.exitCode ile. */
async function main() {
  if (!values.style) {
    console.error('Kullanım: node scripts/suno-bot-try.js --style "<style>" [--title "<başlık>"] [--negative "<exclude>"] [--out <klasör>] [--vocal]');
    return 2;
  }

  const bot = createSunoBrowserBot();
  try {
    // Cookie yalnızca yedek; yoksa suno-generate'in zorunlu apiKey'i yer tutucuyla karşılanır.
    const cookie = resolveSunoCookie({ required: false });
    const common = { provider: bot, apiKey: cookie ?? PROFILE_API_KEY };

    console.log('Tarayıcı açılıyor, suno.com/create…');
    const jobId = await generateSong(`[Instrumental] ${values.title}`, {
      ...common,
      style: values.style,
      title: values.title,
      negativeTags: values.negative,
      instrumental: !values.vocal,
    });
    console.log(`Clip id(ler): ${jobId}`);

    const { audioUrls } = await waitForSong(jobId, {
      ...common,
      onProgress: ({ attempt, status, waitMs }) => console.log(`  deneme ${attempt}: ${status}, ${Math.round(waitMs / 1000)} sn bekleniyor`),
    });

    const outputDir = resolve(values.out);
    await mkdir(outputDir, { recursive: true });
    for (const [i, url] of audioUrls.entries()) {
      const file = join(outputDir, `${sanitizeFilename(values.title)}-v${i + 1}${audioExtension(url)}`);
      await downloadAudio({ url, localPath: file, label: `Varyant ${i + 1}` });
      console.log(`İndirildi: ${file}`);
    }
    return 0;
  } catch (err) {
    console.error(`HATA (${err.name}): ${err.message}`);
    return 1;
  } finally {
    await bot.close().catch(() => {});
  }
}

process.exitCode = await main();
