import { describe, expect, it } from 'vitest';

import { describeAudioZip } from './audioZip';

describe('describeAudioZip', () => {
  it('açılan parça sayısını ve zip adlarını söyler', () => {
    const notice = describeAudioZip({
      files: ['01.mp3', '02.mp3', '03.mp3'],
      archives: [
        { zip: 'a.zip', files: ['01.mp3', '02.mp3'] },
        { zip: 'b.zip', files: ['03.mp3'] },
      ],
    });
    expect(notice.success).toBe('3 müzik parçası eklendi (a.zip, b.zip).');
    expect(notice.problems).toEqual([]);
  });

  it('açılamayan ve müziksiz zip\'leri ayrı ayrı bildirir, başarı mesajı çıkmaz', () => {
    const notice = describeAudioZip({
      files: [],
      archives: [
        { zip: 'bozuk.zip', files: [], error: 'Dosya bir zip değil.' },
        { zip: 'resim.zip', files: [], noAudio: true },
      ],
    });
    expect(notice.success).toBeNull();
    expect(notice.problems).toEqual([
      'bozuk.zip açılamadı: Dosya bir zip değil.',
      'resim.zip içinde müzik dosyası yok.',
    ]);
  });

  it('bir zip açılırken öbürü bozuksa ikisi de söylenir', () => {
    const notice = describeAudioZip({
      files: ['x.mp3'],
      archives: [{ zip: 'iyi.zip', files: ['x.mp3'] }, { zip: 'kotu.zip', files: [], error: 'CRC' }],
    });
    expect(notice.success).toContain('1 müzik parçası');
    expect(notice.problems).toHaveLength(1);
  });
});
