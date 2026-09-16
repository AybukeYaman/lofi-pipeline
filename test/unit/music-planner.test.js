import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateMusicPlan, generateMusicPlanAsync, validateTrackPlan } from '../../prep/music-planner.js';

describe('music-planner', () => {
  test('1. Yeni concept -> yeni track planı oluşuyor', () => {
    const plan = generateMusicPlan({
      concept: 'Tokyo After Midnight',
      style: 'Cyberpunk Lo-fi',
      totalTracks: 17,
    });
    assert.equal(plan.concept, 'Tokyo After Midnight');
    assert.equal(plan.totalTracks, 17);
    assert.equal(plan.tracks.length, 17);
  });

  test('2. İki farklı concept -> farklı track planları ve farklı başlıklar oluşuyor', () => {
    const planA = generateMusicPlan({ concept: '2:17 AM — Everyone Is Asleep', totalTracks: 17 });
    const planB = generateMusicPlan({ concept: 'Sunday Morning Coffee', totalTracks: 17 });

    const titlesA = planA.tracks.map((t) => t.title);
    const titlesB = planB.tracks.map((t) => t.title);

    assert.notDeepEqual(titlesA, titlesB, 'İki farklı konsept için başlıklar tamamen farklı olmalı');
  });

  test('3. Track count doğru', () => {
    const plan5 = generateMusicPlan({ totalTracks: 5 });
    const plan17 = generateMusicPlan({ totalTracks: 17 });
    assert.equal(plan5.tracks.length, 5);
    assert.equal(plan17.tracks.length, 17);
  });

  test('4. Her track unique title ve prompta sahip', () => {
    const plan = generateMusicPlan({ totalTracks: 17 });
    const titles = new Set(plan.tracks.map((t) => t.title));
    const prompts = new Set(plan.tracks.map((t) => t.prompt));

    assert.equal(titles.size, 17, 'Tüm 17 başlık benzersiz olmalı');
    assert.equal(prompts.size, 17, 'Tüm 17 prompt benzersiz olmalı');
  });

  test('5. Her prompt kendi title\'ını ve [Instrumental] etiketini içeriyor', () => {
    const plan = generateMusicPlan({ totalTracks: 17 });
    for (const track of plan.tracks) {
      assert.ok(track.prompt.includes('[Instrumental]'), 'Prompt [Instrumental] etiketi içermeli');
      assert.ok(track.prompt.includes(track.title), `Prompt ("${track.prompt}") başlığı ("${track.title}") içermeli`);
    }
  });

  test('6. State yapısı doğru ve validateTrackPlan onaylıyor', () => {
    const plan = generateMusicPlan({ concept: 'Cozy Rain', totalTracks: 17 });
    assert.equal(plan.completedCount, 0);
    assert.equal(plan.tracks[0].status, 'pending');
    assert.equal(plan.tracks[0].file, null);
    assert.ok(validateTrackPlan(plan));
  });

  test('7. generateMusicPlanAsync Gemini mock ile çalışır ve fallback sunar', async () => {
    const mockEnv = { GEMINI_API_KEY: 'mock-key' };
    const mockFetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                albumDirection: 'Tokyo Night Journey',
                tracks: Array.from({ length: 5 }, (_, i) => ({
                  number: i + 1,
                  title: `Neon Track ${i + 1}`,
                  prompt: `[Instrumental] Cyberpunk synth Track 0${i + 1}: "Neon Track ${i + 1}"`,
                })),
              }),
            }],
          },
        }],
      }),
    });

    const plan = await generateMusicPlanAsync(
      { concept: 'Tokyo Neon', style: 'Synth Lofi', totalTracks: 5 },
      { env: mockEnv, fetchFn: mockFetch }
    );

    assert.equal(plan.totalTracks, 5);
    assert.equal(plan.tracks[0].title, 'Neon Track 1');
    assert.ok(validateTrackPlan(plan));
  });

  test('validateTrackPlan: yinelenen veya geçersiz başlıkları yakalar', () => {
    const invalidPlan = {
      concept: 'Test',
      totalTracks: 2,
      tracks: [
        { number: 1, title: 'Track 1', prompt: '[Instrumental] Track 1', status: 'pending' },
        { number: 2, title: 'Track 1', prompt: '[Instrumental] Track 1', status: 'pending' },
      ],
    };

    assert.throws(() => validateTrackPlan(invalidPlan), /Yinelenen track başlığı/);
  });
});
