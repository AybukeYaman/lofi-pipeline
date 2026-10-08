export type ProjectStep = {
  id?: string;
  title?: string;
  detail?: string;
  kind?: string;
  skippable?: boolean;
};

/** Canonical 6 adım — backend canonicalWorkflow (prep/project-status.js). */
export type WorkflowStepId =
  | 'project'
  | 'video'
  | 'music'
  | 'order'
  | 'build'
  | 'publish';

/**
 * Shorts alt projesinin adımları (`prep/project-status.js`
 * SHORTS_WORKFLOW_STEPS aynası) — canonical 6 adımın yerine geçer.
 */
export type ShortsStepId = 'source' | 'clips' | 'export';

export type WorkflowStepInfo = {
  id: WorkflowStepId | ShortsStepId;
  number: number;
  title: string;
  kind: 'manual' | 'auto' | 'done';
  optional: boolean;
  status: 'done' | 'current' | 'pending';
  skipped: boolean;
};

export type ProjectWorkflow = {
  current: WorkflowStepId | ShortsStepId;
  currentTitle: string;
  steps: WorkflowStepInfo[];
};

/** Proje türü: normal montaj projesi ya da 9:16 Shorts alt projesi. */
export type ProjectKind = 'video' | 'shorts';

export type ProjectSummary = {
  id: string;
  name: string;
  parentId?: string | null;
  kind?: ProjectKind;
  mtimeMs: number;
  /** Sunucunun seçtiği küçük resim: videodaki görsel, yoksa resimler/ altındaki ilk görsel. */
  thumbnailUrl?: string | null;
  step?: ProjectStep;
  workflow?: ProjectWorkflow;
};

export type ProjectFileEvidence = {
  path?: string;
  value?: string;
  exists?: boolean;
};

export type VideoSettings = {
  cropBottom?: number;
  cropTop?: number;
  cropLeft?: number;
  cropRight?: number;
  aspect?: string;
  watermark?: boolean;
  crf?: number;
  preset?: string;
  fadeOut?: number;
  crossfadeSeconds?: number;
  scaleWidth?: number | null;
};

export type ProjectJsonState = {
  ok?: boolean;
  data?: {
    /** core/ambient-plan.js üç şekli de kabul ediyor. */
    ambient?:
      | string
      | string[]
      | { mode?: AmbientMode; crossfade?: number; volumeDb?: number;
          tracks?: (string | { path: string; volumeDb?: number })[] };
    video?: VideoSettings;
    music?: {
      concept?: string;
      totalTracks?: number;
      completedCount?: number;
      status?: string;
      tracks?: MusicTrack[];
    };
    output?: {
      dir?: string;
      name?: string;
    };
    order?: string[];
    workflow?: {
      order?: TrackOrderMode;
    };
  };
  error?: string | null;
};

export type MusicTrack = {
  number: number;
  title: string;
  status?: string;
  file?: string | null;
  prompt?: string | null;
  atmosphere?: string | null;
  instrumentation?: string | null;
};

export type ProjectReadiness = {
  clip: {
    ready: boolean;
    selected: string | null;
    availableCount: number;
  };
  music: {
    ready: boolean;
    audioCount: number;
    trackCount: number;
    completedTrackCount: number;
    status: string | null;
  };
  video?: {
    ready: boolean;
    cropBottom: number | null;
    cropTop?: number | null;
    cropLeft?: number | null;
    cropRight?: number | null;
    watermark: boolean | null;
    defaultCropBottom: number;
  };
  build: {
    ready: boolean;
    missing: string[];
  };
  output: OutputInfo;
};

export type OutputFileInfo = {
  exists: boolean;
  file?: string;
  size?: number | null;
  mtimeMs?: number | null;
  previewUrl?: string | null;
};

export type OutputInfo = OutputFileInfo & {
  tracklist?: OutputFileInfo & { text?: string | null };
};

export type ProjectDetail = {
  id: string;
  name: string;
  parentId?: string | null;
  kind?: ProjectKind;
  dir?: string;
  projectJson?: ProjectJsonState;
  /** 'image': tüm video boyunca tek resim; clips o zaman resimler/ altındaki görseller. */
  videoSource?: VideoSource;
  /** Her modun aday sayısı — kaynak değiştirme kutusu bunu gösterir. */
  videoSourceCandidates?: Record<VideoSource, { count: number; dir: string }>;
  clips?: string[];
  clip?: ProjectFileEvidence;
  audioDir?: string;
  audioCount?: number;
  output?: ProjectFileEvidence;
  step?: ProjectStep;
  workflow?: ProjectWorkflow;
  readiness?: ProjectReadiness;
};

export type ProjectMusicAudio = {
  file: string;
  size: number;
  duration: number | null;
  previewUrl: string | null;
  trackNumber: number | null;
};

export type ProjectMusicInfo = {
  ready: boolean;
  audioDir: string;
  audioFiles: ProjectMusicAudio[];
  /** Parçaların klasöre eklenme sırası (dosya adları). */
  addedOrder?: string[];
};

/** 8. adım sıralama yöntemi — project.json workflow.order. */
export type TrackOrderMode = 'alphabetical' | 'added' | 'manual';

export type BackendAmbient = {
  name: string;
};

export type LibraryResponse = {
  ambients: BackendAmbient[];
  ambientError?: string | null;
};

/** Çoklu Ambiance kullanım modu — core/ambient-plan.js AMBIENT_MODES aynası. */
export type AmbientMode = 'layer' | 'sequence';

/** Projede seçili bir Ambiance. */
export type SelectedAmbient = {
  name: string;
  /** Bu parçaya özel ses ofseti (LU); null ise plan/proje varsayılanı. */
  volumeDb: number | null;
  /** Seçili ama ortak klasörde bulunamıyor (dosya taşınmış/silinmiş). */
  missing: boolean;
};

/** GET/PUT /api/projects/:id/ambient yanıtı. */
export type ProjectAmbient = {
  /** Ortak ses efektleri klasörü — kullanıcıya nereye dosya atacağını söyler. */
  dir: string;
  available: BackendAmbient[];
  /** Seçim sırası = katman/çalma sırası. */
  selected: SelectedAmbient[];
  mode: AmbientMode;
  modes: AmbientMode[];
  /** Döngü dikişinde harmanlanan saniye; 0 = harman yok. */
  crossfade: number;
  /** Bütün parçalar için ofset; null ise audio.ambientOffsetDb. */
  volumeDb: number | null;
  defaultVolumeDb: number;
  /** Ortak klasör okunamadı. */
  error?: string | null;
  /** project.json'daki ambient alanı bozuksa açıklamalar. */
  problems?: string[];
};

// ------------------------------------------------------------------ Pomodoro

/** Hazır düzen — core/pomodoro-plan.js POMODORO_PRESETS aynası. */
export type PomodoroPreset = {
  id: string;
  workMinutes: number;
  breakMinutes: number;
};

/** project.json'daki normalize edilmiş Pomodoro ayarı. */
export type PomodoroSettings = {
  workMinutes: number;
  breakMinutes: number;
  rounds: number;
  /** Değerler bir hazır düzene denk geliyorsa onun kimliği. */
  preset: string | null;
  countdownSeconds: number;
  countdownBeep: boolean;
  workStartSound: boolean;
  breakStartSound: boolean;
  /** Fazla müziğin kırpılması kullanıcı tarafından onaylandı mı. */
  trimExcess: boolean;
  cue: {
    volumeDb: number;
    beepFile: string | null;
    workStartFile: string | null;
    breakStartFile: string | null;
  };
};

/** Bir WORK ya da BREAK oturumu. */
export type PomodoroSession = {
  index: number;
  kind: 'work' | 'break';
  round: number;
  /** "WORK 01" / "BREAK 03". */
  label: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
};

/** Müzik toplamı ile timeline'ın karşılaştırması. */
export type PomodoroComparison = {
  status: 'exact' | 'excess' | 'short';
  ok: boolean;
  musicSeconds: number;
  timelineSeconds: number;
  excessSeconds: number;
  shortSeconds: number;
};

/** Fazla müziğin nasıl kırpılacağı — orijinal dosyalara dokunulmaz. */
export type PomodoroTrim = {
  tracks: {
    index: number;
    path: string;
    duration: number;
    usedDuration: number;
    startSeconds: number;
    trimmed: boolean;
    dropped: boolean;
  }[];
  usedSeconds: number;
  trimmedSeconds: number;
  droppedCount: number;
  trimmedCount: number;
};

/** GET/PUT /api/projects/:id/pomodoro yanıtı. */
export type ProjectPomodoro = {
  enabled: boolean;
  presets: PomodoroPreset[];
  defaults: Omit<PomodoroSettings, 'preset'> & { enabled: boolean };
  /** Kapalıyken null. */
  settings: PomodoroSettings | null;
  /** project.json'daki pomodoro bloğu bozuksa açıklamalar. */
  problems: string[];
  music: {
    trackCount: number;
    totalSeconds: number;
    unmeasuredCount: number;
  };
  /** MONTAJ ÖNCESİ doğrulama — `ok: false` ise montaj başlatılmaz. */
  validation: {
    ok: boolean;
    /** Kullanıcıya gösterilecek hazır metin (timeline / müzik / fazla-eksik). */
    message: string | null;
    problems: string[];
    warnings: string[];
    needsTrimConfirmation: boolean;
    comparison: PomodoroComparison | null;
    trim: PomodoroTrim | null;
    timeline: { sessions: PomodoroSession[]; totalSeconds: number; totalMinutes: number } | null;
    cueCount: number;
  };
};

/** PUT /api/projects/:id/pomodoro gövdesi. `enabled: false` ayarı kaldırır. */
export type UpdatePomodoroPayload = {
  enabled: boolean;
  preset?: string;
  workMinutes?: number;
  breakMinutes?: number;
  rounds?: number;
  countdownSeconds?: number;
  countdownBeep?: boolean;
  workStartSound?: boolean;
  breakStartSound?: boolean;
  trimExcess?: boolean;
};

/** PUT /api/projects/:id/ambient gövdesi. */
export type UpdateAmbientPayload = {
  tracks: (string | { name: string; volumeDb?: number | null })[];
  mode?: AmbientMode;
  crossfade?: number;
  volumeDb?: number;
};

export type VideoSource = 'clip' | 'image';

/** PUT /video-source yanıtı: güncel proje + ne değiştiği. */
export type VideoSourceChange = {
  source: VideoSource;
  previous: VideoSource;
  changed: boolean;
  /** Yeni moda uymadığı için boşaltılan klip/görsel; boşaltılmadıysa null. */
  clearedClip: string | null;
  warnings: string[];
};

export type VideoSourceResponse = ProjectDetail & { videoSourceChange: VideoSourceChange };

export type CreateProjectPayload = {
  name: string;
  ambient?: string[];
  videoSource?: VideoSource;
  concept?: string;
  totalTracks?: number;
  parentId?: string;
  selectedTracks?: string[];
  aspect?: string;
};

export type CreateProjectResponse = {
  project: ProjectDetail;
  warnings: string[];
};

export type BuildJobState = 'idle' | 'running' | 'succeeded' | 'failed';

export type BuildJob = {
  projectId?: string;
  state: BuildJobState;
  overwrite?: boolean;
  startedAt?: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
  log?: string[];
  /** Yalnızca stderr — hatanın gerçek nedeni. */
  errorLog?: string[];
};

export type Route =
  | { name: 'dashboard' }
  | { name: 'newProject'; parentId?: string }
  | { name: 'project'; id: string }
  | { name: 'ambient' }
  | { name: 'mimi' }
  | { name: 'prompts' }
  | { name: 'settings' };

export type Navigate = (path: string) => void;

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export type MusicLibraryTrack = {
  file: string;
  name: string;
  size: number;
  duration: number | null;
  durationFormatted: string | null;
  previewUrl: string;
  mtimeMs?: number;
};

export type MusicLibraryAlbum = {
  id: string;
  name: string;
  path: string;
  trackCount: number;
  totalSize: number;
  totalDuration: number;
  totalDurationFormatted: string;
  tracks: MusicLibraryTrack[];
};

export type MusicLibraryResponse = {
  musicDir: string;
  albums: MusicLibraryAlbum[];
  projects: Array<{ id: string; name: string; step?: ProjectStep }>;
};

export type SunoIngestPayload = {
  url: string;
  targetType: 'album' | 'project';
  targetId?: string;
  newAlbumName?: string;
};

export type SunoIngestResponse = {
  ok: boolean;
  targetType: 'album' | 'project';
  albumId?: string;
  projectId?: string;
  downloadedCount: number;
  tracks: Array<{
    index: number;
    title: string;
    file: string;
    duration?: number;
  }>;
};



/** Prompt kütüphanesi etiketi — hangi aşamada işe yaradığı. */
export type PromptTag = 'general' | 'image' | 'music' | 'video';

/** Kullanıcının kütüphaneye kaydettiği bir prompt. */
export type LibraryPrompt = {
  id: string;
  title: string;
  text: string;
  note: string | null;
  tags: PromptTag[];
  updatedAt: string | null;
  /** Dosya elle bozulmuşsa doldurulur; kart salt okunur gösterilir. */
  error?: string;
};

export type PromptLibraryResponse = {
  prompts: LibraryPrompt[];
  tags: PromptTag[];
  limits: { title: number; text: number; note: number };
};

export type PromptPayload = {
  title?: string;
  text?: string;
  note?: string | null;
  tags?: PromptTag[];
};

// ------------------------------------------------------------- Mimi galerisi

/**
 * Dosyanın galerideki rolü: elle atılmış resim, o resimden üretilmiş loop
 * video (`<ad>.loop.mp4`) ya da elle atılmış bağımsız video.
 */
export type MimiRole = 'image' | 'loop' | 'video';

/** Mimi için üretilip indirilen tek bir dosya (ortak klasörden okunur). */
export type MimiAsset = {
  /** Uzantılı dosya adı — API'de kimlik olarak kullanılır. */
  file: string;
  /** Uzantısız ad (ekranda görünen). */
  name: string;
  kind: 'image' | 'video';
  ext: string;
  size: number;
  mtimeMs: number;
  /** <img src> / <video src> olarak doğrudan kullanılır. */
  previewUrl: string;
  role: MimiRole;
  /** Resim için: bu resimden üretilmiş loop videonun dosya adı (yoksa null). */
  loopVideo: string | null;
  /** Loop video için: üretildiği resmin dosya adı (resim silinmişse null). */
  sourceImage: string | null;
  /** Resim ve henüz loop videosu yok — "videoya çevrilmesi gerekiyor". */
  needsVideo: boolean;
};

/** GET /api/mimi yanıtı — en yeni dosya başta. */
export type MimiGalleryResponse = {
  /** Ortak klasörün tam yolu — kullanıcıya nereye dosya atacağını söyler. */
  dir: string;
  items: MimiAsset[];
  /** Klasör okunamadıysa açıklama. */
  error?: string | null;
  /** Yükleme/dönüştürme yanıtında yazılan dosyanın son adı. */
  file?: string;
  /** Dönüştürme yanıtında: kaynak resim ve loop süresi. */
  source?: string;
  seconds?: number;
};

// -------------------------------------------------------------- Shorts (9:16)

/** Kaynak videodaki 9:16 kadraj — oranlar (0–1) ve yakınlaştırma. */
export type ShortsFrame = {
  /** 1 = kaynağa sığan en büyük 9:16 kutu; büyüdükçe yakınlaşır. */
  zoom: number;
  /** Kutunun yatay konumu: 0 sol, 0.5 orta, 1 sağ. */
  x: number;
  /** Kutunun dikey konumu: 0 üst, 0.5 orta, 1 alt. */
  y: number;
};

/** Kadrajın kaynak videodaki piksel karşılığı (sunucu hesaplar). */
export type ShortsCrop = {
  width: number;
  height: number;
  x: number;
  y: number;
};

/** Bir Shorts kesiti: kaynak videonun bir zaman aralığı + kadrajı. */
export type ShortsClip = {
  id: string;
  title: string;
  start: number;
  end: number;
  duration: number;
  startLabel: string;
  endLabel: string;
  durationLabel: string;
  frame: ShortsFrame;
  crop: ShortsCrop | null;
  /** Çıktı dosya adı (`out/shorts/` altında). */
  output: string;
  outputPath: string;
  /** Dosya diskte var mı — render edilmiş mi. */
  rendered: boolean;
  outputSize: number | null;
  renderedAt: string | null;
  /** Render edilmişse oynatma adresi. */
  videoUrl: string | null;
  /** Süre YouTube Shorts sınırını aşıyor. */
  overLimit: boolean;
};

/** Kesitlerin alındığı kaynak video — KOPYALANMAZ, yol tutulur. */
export type ShortsSource = {
  value: string | null;
  path: string | null;
  exists: boolean;
  name: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean | null;
  /** <video src> — Range destekli akış. */
  url: string | null;
};

/** Arka planda süren render işi. */
export type ShortsRenderJob = {
  projectId: string;
  clipId: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  progressSeconds: number;
  duration: number;
  output: string;
  error: string | null;
};

/** GET /api/projects/:id/shorts yanıtı. */
export type ShortsState = {
  id: string;
  name: string;
  parentId?: string | null;
  kind: ProjectKind;
  dir: string;
  outputDir: string;
  target: { width: number; height: number; aspect: string };
  limits: { minSeconds: number; maxSeconds: number; minZoom: number; maxZoom: number };
  source: ShortsSource;
  clips: ShortsClip[];
  problems: string[];
  warnings: string[];
  renders: ShortsRenderJob[];
  step?: ProjectStep;
  workflow?: ProjectWorkflow;
};

/** POST /api/projects/:id/shorts/clips gövdesi. */
export type ShortsClipPayload = {
  start: number;
  end: number;
  title?: string;
  frame?: Partial<ShortsFrame>;
};
