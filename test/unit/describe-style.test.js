import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_IMAGE_SIZE_BYTES,
  SUPPORTED_IMAGE_EXTENSIONS,
  buildResponseSchema,
  buildStylePrompt,
  getImageMimeType,
  toStyle,
} from '../../prep/describe-style.js';

test('1. schema alan sırası ve required kontrolü', () => {
  const schema = buildResponseSchema({ ambientNames: ['rain', 'cafe'] });

  assert.equal(schema.type, 'OBJECT');
  assert.deepEqual(schema.required, ['styleBlock', 'suggestedAmbient', 'motionHints']);

  const expectedFields = ['medium', 'lines', 'palette', 'light', 'texture', 'contrast', 'shading'];
  assert.deepEqual(Object.keys(schema.properties.styleBlock.properties), expectedFields);
  assert.deepEqual(schema.properties.styleBlock.required, expectedFields);

  assert.equal(schema.properties.styleBlock.properties.palette.type, 'ARRAY');
  assert.deepEqual(schema.properties.styleBlock.properties.palette.items.required, ['hex', 'role']);
});

test('2. ambient enum sınırlaması', () => {
  const schemaWithAmbients = buildResponseSchema({ ambientNames: ['rain', 'wind'] });
  assert.deepEqual(schemaWithAmbients.properties.suggestedAmbient.enum, ['rain', 'wind']);

  const schemaWithoutAmbients = buildResponseSchema({});
  assert.equal(schemaWithoutAmbients.properties.suggestedAmbient.enum, undefined);
});

test('3. Türkçe prompt talimatı ve İngilizce çıktı kuralı', () => {
  const prompt = buildStylePrompt({ ambientNames: ['heavyRain', 'lounge'] });

  assert.match(prompt, /Bu görselin görsel stilini bir prompt fragmanı olarak tarif et/);
  assert.match(prompt, /Konuyu ve kompozisyonu ANLATMA, sadece stili anlat/);
  assert.match(prompt, /Çıktı tamamen İngilizce olacak/);
  assert.match(prompt, /palette: 5 ila 8 renk içermeli/);
  assert.match(prompt, /suggestedAmbient: Yalnızca şu listeden seçilmelidir: \[heavyRain, lounge\]/);
  assert.match(prompt, /motionHints: 4 ila 6 adet hareket ipucu tarif et/);
  assert.match(prompt, /pan, zoom, camera moves veya nesne takibi asla önerme/);
});

test('4. toStyle ile geçerli response dönüştürme', () => {
  const validResponse = JSON.stringify({
    styleBlock: {
      medium: 'Digital oil painting',
      lines: 'Soft and painterly brush strokes',
      palette: [
        { hex: '#1A2B3C', role: 'Background sky' },
        { hex: '#FF5500', role: 'Warm lights' },
        { hex: '#00FF88', role: 'Accent neon' },
        { hex: '#333333', role: 'Shadow details' },
        { hex: '#FFFFFF', role: 'Highlights' },
      ],
      light: 'Warm ambient glow with neon accents',
      texture: 'Subtle canvas texture and fine noise',
      contrast: 'High contrast between shadow and warm lights',
      shading: 'Smooth gradient shading',
    },
    suggestedAmbient: 'heavyRain',
    motionHints: [
      'Soft neon lights pulsing gently.',
      'Steam rising slowly from a cup.',
      'Raindrops falling softly against the window.',
      'Gentle flicker of warm indoor lamp.',
    ],
  });

  const { style, warnings } = toStyle(validResponse, 'cozy-neon', {
    ambients: [{ name: 'heavyRain', path: '/path/heavyRain.mp3' }],
  });

  assert.equal(style.name, 'cozy-neon');
  assert.equal(style.suggestedAmbient, 'heavyRain');
  assert.equal(style.motionHints.length, 4);
  assert.equal(warnings.length, 0);
});

test('5. toStyle - bozuk JSON hatası', () => {
  assert.throws(
    () => toStyle('Invalid JSON text', 'test-style'),
    /Gemini çıktısı geçerli bir JSON değil/,
  );
});

test('6. toStyle - eksik alan hatası', () => {
  const incompleteResponse = JSON.stringify({
    styleBlock: {
      medium: 'Digital oil painting',
    },
    suggestedAmbient: 'heavyRain',
  });

  assert.throws(
    () => toStyle(incompleteResponse, 'test-style'),
    /Gemini tarafından üretilen stil geçersiz/,
  );
});

test('7. toStyle - yasak içerik (<, >, {{, }}) hatası', () => {
  const forbiddenResponse = JSON.stringify({
    styleBlock: {
      medium: 'Digital painting <tag>',
      lines: 'Soft lines',
      palette: [{ hex: '#112233', role: 'base' }],
      light: 'Soft light',
      texture: 'Grain',
      contrast: 'Low',
      shading: 'Soft',
    },
    suggestedAmbient: 'rain',
    motionHints: ['Hint 1'],
  });

  assert.throws(
    () => toStyle(forbiddenResponse, 'test-style'),
    /"<" ya da ">" içeremez/,
  );
});

test('8. Görsel uzantı ve MIME tipi eşleşmesi', () => {
  assert.equal(getImageMimeType('.jpg'), 'image/jpeg');
  assert.equal(getImageMimeType('.JPEG'), 'image/jpeg');
  assert.equal(getImageMimeType('.png'), 'image/png');
  assert.equal(getImageMimeType('.webp'), 'image/webp');
  assert.equal(getImageMimeType('.bmp'), null);
});

test('9. MAX_IMAGE_SIZE_BYTES ve SUPPORTED_IMAGE_EXTENSIONS sabiti', () => {
  assert.equal(MAX_IMAGE_SIZE_BYTES, 15 * 1024 * 1024);
  assert.deepEqual(SUPPORTED_IMAGE_EXTENSIONS, ['.jpg', '.jpeg', '.png', '.webp']);
});

test('10. buildMultiReferenceStylePrompt visual language ve concept doğrulaması', async () => {
  const prompt = (await import('../../prep/describe-style.js')).buildMultiReferenceStylePrompt({
    concept: '2:17 AM — Everyone Is Asleep',
    ambientNames: ['heavyRain'],
  });

  assert.match(prompt, /Verilen referans görsellerin ortak visual language \/ ambience özelliklerini/);
  assert.match(prompt, /Video Concept Context: "2:17 AM — Everyone Is Asleep"/);
  assert.match(prompt, /Konuyu veya sahneyi \(WHAT IS HAPPENING\) ANLATMA, sadece stili ve atmosferi \(HOW IT LOOKS\) anlat/);
  assert.match(prompt, /palette: Referans görsellerden baskın\/destekleyici 5 ila 8 renk seç/);
});
