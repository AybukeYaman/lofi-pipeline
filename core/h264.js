/**
 * H.264 parametre setleri (SPS/PPS) — konteyner başlığı ile akış içi kopyaların
 * tutarlılığı.
 *
 * Neden gerekli: concat demuxer ile kopyalanan dosyalar birleşince MP4'ün avcC
 * kutusu (tek) ilk dosyadan gelir; sonraki dosyaların SPS/PPS'i her dosya sınırında
 * akışın İÇİNE gömülür. İçerik aynıysa zararsız. Farklıysa (ör. kuyruk başka
 * crf/preset ile encode edilmiş) ffmpeg yine sorunsuz çözer — `-xerror` ve kare
 * karşılaştırması bunu YAKALAMAZ — ama konteynerin bildirdiği profile göre kurulan
 * donanım çözücüler/tarayıcılar bozulabilir. Tek güvenilir sinyal içerik farkı.
 *
 * Tek sorumluluk: ffmpeg `trace_headers` çıktısından parametre setlerini okuyup
 * karşılaştırmak. Karar (hata mı) çağıranın.
 */

import { ffmpeg } from './ffmpeg.js';

const PARAMETER_SET_TYPES = { 7: 'SPS', 8: 'PPS' };

/**
 * `trace_headers` satırı: `[trace_headers @ 0x…] <bit> <alan> <bitler> = <değer>`
 * Bit konumu ve ham bitler atılır; alan = değer kalır.
 */
const TRACE_FIELD = /^\[trace_headers @ [^\]]+\]\s+\d+\s+(\S+)\s+[01]+\s+=\s+(-?\d+)\s*$/;
const TRACE_PACKET = /^\[trace_headers @ [^\]]+\] Packet: /;

/**
 * İçerik karşılaştırmasına girmeyen alanlar: NAL başlığı (bir SONRAKİ NAL'ın
 * başlığı `nal_unit_type`'tan önce basıldığı için önceki sete yapışır) ve
 * bayt hizalama/bitiş bitleri (sayısı konuma göre değişir, anlam taşımaz).
 */
const IGNORED_FIELD = /^(forbidden_zero_bit|nal_ref_idc|rbsp_\w+|trailing_\w+|cabac_alignment_\w+)$/;

/**
 * Bir dosyanın (ya da penceresinin) parametre setlerini okur.
 *
 * Pencere verilirse `-ss` giriş araması yapılır — kopyada en yakın önceki anahtar
 * kareye iner, birleşme noktası pencerede kalır. 48 dk dosyada 10 sn ≈ 0.1 sn.
 *
 * @param {string} path
 * @param {{ start?: number, duration?: number }} [window]
 * @returns {Promise<{
 *   container: Array<{ type: string, id: number, fields: string }>,
 *   inband: Array<{ packet: number, type: string, id: number, fields: string }>,
 *   packets: number,
 * }>}
 */
export async function readParameterSets(path, window = {}) {
  const seek = [];
  if (window.start !== undefined) seek.push('-ss', String(window.start));
  if (window.duration !== undefined) seek.push('-t', String(window.duration));

  const { stderr } = await ffmpeg([
    '-loglevel', 'verbose',
    ...seek,
    '-i', path,
    '-map', '0:v:0',
    '-c', 'copy',
    '-bsf:v', 'trace_headers',
    '-f', 'null', '-',
  ], { fullStderr: true });

  const container = [];
  const inband = [];
  let packets = 0;
  let current = null;

  const close = () => {
    if (!current) return;
    const set = { type: current.type, id: current.id, fields: current.fields.join(';') };
    if (current.packet === 0) container.push(set);
    else inband.push({ packet: current.packet, ...set });
    current = null;
  };

  for (const line of stderr.split('\n')) {
    if (TRACE_PACKET.test(line)) {
      close();
      packets += 1;
      continue;
    }
    const match = TRACE_FIELD.exec(line);
    if (!match) continue;
    const [, name, value] = match;

    if (name === 'nal_unit_type') {
      close();
      const type = PARAMETER_SET_TYPES[value];
      // Paket sayacı 0 iken okunanlar extradata'dır (bsf başlangıçta onu izler).
      if (type) current = { type, id: 0, packet: packets, fields: [] };
      continue;
    }
    if (!current || IGNORED_FIELD.test(name)) continue;
    if (name === 'seq_parameter_set_id' && current.type === 'SPS') current.id = Number(value);
    if (name === 'pic_parameter_set_id' && current.type === 'PPS') current.id = Number(value);
    current.fields.push(`${name}=${value}`);
  }
  close();

  return { container, inband, packets };
}

/**
 * Akış içi parametre setlerinden konteynerdekiyle (aynı tür + id) içerik olarak
 * uyuşmayanları döndürür. Konteynerde karşılığı olmayan set de uyuşmaz sayılır.
 *
 * @param {Awaited<ReturnType<typeof readParameterSets>>} sets
 * @returns {Array<{ packet: number, type: string, id: number, reason: string }>}
 */
export function parameterSetMismatches({ container, inband }) {
  const byKey = new Map(container.map((s) => [`${s.type}:${s.id}`, s.fields]));

  return inband
    .map((set) => {
      const expected = byKey.get(`${set.type}:${set.id}`);
      if (expected === undefined) {
        return { ...set, reason: 'konteynerde karşılığı yok' };
      }
      if (expected !== set.fields) {
        const want = new Map(expected.split(';').map((f) => f.split('=')));
        const diff = set.fields.split(';')
          .map((f) => f.split('='))
          .filter(([k, v]) => want.get(k) !== v)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${want.get(k) ?? '—'} → ${v}`);
        return { ...set, reason: diff.join(', ') || 'alan sayısı farklı' };
      }
      return null;
    })
    .filter(Boolean)
    .map(({ packet, type, id, reason }) => ({ packet, type, id, reason }));
}
