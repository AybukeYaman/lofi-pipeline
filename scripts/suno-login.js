#!/usr/bin/env node
/**
 * Suno tarayıcı botu — kalıcı profilde bir kez elle oturum açma. Şarkı üretmez, kredi harcamaz.
 *
 *   node scripts/suno-login.js
 *
 * Görünür Chromium profil klasörüyle (.auth/suno-profile ya da SUNO_PROFILE_DIR) açılır ve
 * suno.com/create'e gider. Oturum yoksa tarayıcıda giriş yap (captcha çıkarsa elle çöz);
 * create formu görününce oturum doğrulanır, tarayıcı kapatılır ve oturum profilde kalır.
 * Bot (suno-bot-try.js) açıkken çalıştırma: aynı profili iki süreç aynı anda açamaz.
 */

import { createSunoBrowserBot, resolveProfileDir } from '../prep/providers/suno-browser-bot.js';

/** process.exit() kullanılmaz (bkz. album-try.js); çıkış kodu process.exitCode ile. */
async function main() {
  const profileDir = resolveProfileDir();
  const bot = createSunoBrowserBot({ profileDir });
  try {
    console.log(`Profil: ${profileDir}`);
    console.log('Tarayıcı açılıyor, suno.com/create…');
    await bot.login();
    console.log('Oturum doğrulandı (create formu göründü). Tarayıcı kapatılıyor; oturum profilde kaldı.');
    return 0;
  } catch (err) {
    console.error(`HATA (${err.name}): ${err.message}`);
    return 1;
  } finally {
    await bot.close().catch(() => {});
  }
}

process.exitCode = await main();
