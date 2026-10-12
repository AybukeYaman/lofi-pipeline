/**
 * Etiket editörünün saf hesapları — `core/label-filter.js`'in AYNASI.
 *
 * Önizlemede gördüğün konum render'da çıkan konum olsun diye formül iki yerde
 * aynı olmak zorunda: sunucu (ffmpeg `drawtext` ifadeleri) ve burası. Aynı
 * sebeple `shortsFrame.ts` de `core/shorts-plan.js`'i yansıtıyor. Bir formül
 * değişirse ikisi birlikte değişir; `labelFrame.test.ts` sözleşmeyi tutar.
 *
 * Konum etiketin MERKEZİdir (`x`, `y` ∈ [0,1]); metin kareden taşmasın diye
 * sol-üst köşe [0, kare − metin] aralığına kıstırılır.
 */

import type { LabelKind, PomodoroSession, VideoLabel } from './types';

export const DEFAULT_LABEL_SIZE = 0.05;
export const DEFAULT_LABEL_COLOR = '#ffffff';

/** Pomodoro oturum türü → ekrandaki yazı (core/label-filter.js `STATUS_TEXT` aynası). */
export const STATUS_TEXT = { ready: 'GET READY', work: 'STUDY', break: 'BREAK' } as const;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** "16:9" → 1.777…; çözülemezse 16:9. */
export function aspectRatioOf(aspect: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? '');
  if (!match) return 16 / 9;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
}

/** Yeni etiketin başlangıç konumu — core/label-plan.js `DEFAULT_POSITIONS` aynası. */
const DEFAULT_POSITIONS: Record<LabelKind, { x: number; y: number }> = {
  text: { x: 0.5, y: 0.9 },
  'pomodoro-countdown': { x: 0.9, y: 0.07 },
  'pomodoro-status': { x: 0.9, y: 0.14 },
};

/** Listede olmayan ilk `etiket-NN` kimliği. */
export function nextLabelId(labels: VideoLabel[]): string {
  const used = new Set(labels.map((label) => label.id));
  for (let counter = 1; counter < 1000; counter++) {
    const id = `etiket-${String(counter).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  return `etiket-${Date.now()}`;
}

/** Varsayılan konum/boyut/renkle yeni etiket (`createLabel` aynası). */
export function newLabel(kind: LabelKind, labels: VideoLabel[], text = 'Yeni etiket'): VideoLabel {
  return {
    id: nextLabelId(labels),
    kind,
    text: kind === 'text' ? text : '',
    ...DEFAULT_POSITIONS[kind],
    size: DEFAULT_LABEL_SIZE,
    color: DEFAULT_LABEL_COLOR,
    start: null,
    end: null,
  };
}

/**
 * Etiketin sol-üst köşesi (kare pikseli). `textW`/`textH` ölçülmüş metin
 * kutusu; ffmpeg ifadesi `max(0,min(w-text_w, w*x-text_w/2))` ile aynı.
 */
export function labelTopLeft(
  position: { x: number; y: number },
  text: { width: number; height: number },
  frame: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(frame.width - text.width, frame.width * position.x - text.width / 2)),
    top: Math.max(0, Math.min(frame.height - text.height, frame.height * position.y - text.height / 2)),
  };
}

/** Ekran noktası → kare içi oran (0–1). */
export function pointerFraction(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clamp((point.x - rect.left) / rect.width, 0, 1),
    y: clamp((point.y - rect.top) / rect.height, 0, 1),
  };
}

/**
 * Sürükleme: tutulan noktanın etiket merkezine uzaklığı korunur (etiket
 * parmağın altında zıplamaz), sonuç 0–1'e kıstırılır.
 */
export function dragPosition(
  origin: { x: number; y: number; pointerX: number; pointerY: number },
  pointer: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: round4(clamp(origin.x + (pointer.x - origin.pointerX), 0, 1)),
    y: round4(clamp(origin.y + (pointer.y - origin.pointerY), 0, 1)),
  };
}

/** İnce ayar: yön tuşları / ± düğmeleri. */
export function nudge(position: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
  return {
    x: round4(clamp(position.x + dx, 0, 1)),
    y: round4(clamp(position.y + dy, 0, 1)),
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** `dd:dd` — core/label-filter.js geri sayım ifadesinin aynısı (`ceil(bitiş − t)`). */
export function formatCountdown(remainingSeconds: number): string {
  const total = Math.max(0, Math.ceil(remainingSeconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** `t` anındaki oturum (başlangıç dahil, bitiş hariç). */
export function sessionAt(sessions: PomodoroSession[], time: number): PomodoroSession | null {
  return sessions.find((session) => time >= session.startSeconds && time < session.endSeconds) ?? null;
}

/**
 * Önizlemede `t` anında etiketin gösterdiği yazı; görünmüyorsa null. Hesap
 * yapmaz, yalnızca Pomodoro oturumlarını OKUR — gerçek zamanlama sistemde kalır.
 */
export function previewText(
  label: VideoLabel,
  sessions: PomodoroSession[],
  time: number,
): string | null {
  if (label.kind === 'text') return label.text;
  const session = sessionAt(sessions, time);
  if (!session) return null;
  return label.kind === 'pomodoro-status'
    ? STATUS_TEXT[session.kind]
    : formatCountdown(session.endSeconds - time);
}

/** Listede etikete verilecek kısa ad. */
export function labelTitle(label: VideoLabel): string {
  if (label.kind === 'pomodoro-status') return 'Çalışma / Mola yazısı';
  if (label.kind === 'pomodoro-countdown') return 'Kalan süre sayacı';
  return label.text || 'Boş etiket';
}

export const MIN_LABEL_SIZE = 0.02;
export const MAX_LABEL_SIZE = 0.2;

/** Yapışma noktaları: kenar boşluğu (%10), orta (%50), kenar boşluğu (%90). */
const SNAP_POINTS = [0.1, 0.5, 0.9];
export const SNAP_THRESHOLD = 0.02;

/**
 * Sürüklerken konumu orta/kenar çizgilerine yaklaştırır (Canva gibi): eşik
 * içindeyse çizgiye oturur. `guideX`/`guideY` hangi çizgiye oturduğunu söyler
 * (kılavuz çizgisi çizmek için), oturmadıysa null.
 */
export function snapPosition(
  position: { x: number; y: number },
  threshold = SNAP_THRESHOLD,
): { x: number; y: number; guideX: number | null; guideY: number | null } {
  const snap = (value: number): { value: number; guide: number | null } => {
    const hit = SNAP_POINTS.find((point) => Math.abs(value - point) <= threshold);
    return hit === undefined ? { value, guide: null } : { value: hit, guide: hit };
  };
  const x = snap(position.x);
  const y = snap(position.y);
  return { x: x.value, y: y.value, guideX: x.guide, guideY: y.guide };
}

/**
 * Köşeden sürükleyerek boyutlandırma: yazı kutusunun genişliği `deltaPx`
 * kadar büyürse boyut da aynı oranda büyür (en-boy orantısı korunur).
 */
export function scaledSize(originSize: number, originWidth: number, deltaPx: number): number {
  if (originWidth <= 0) return originSize;
  const scaled = originSize * ((originWidth + deltaPx) / originWidth);
  return Math.round(clamp(scaled, MIN_LABEL_SIZE, MAX_LABEL_SIZE) * 1000) / 1000;
}
