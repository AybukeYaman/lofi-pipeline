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
  /** Pomodoro açık mı ve hangi düzen — süre/müzik doğrulaması ayrı uçta (GET .../pomodoro). */
  pomodoro?: {
    enabled: boolean;
    preset?: string | null;
    /** Program: setler sırayla, her set `repeat` kez. */
    sets?: StepSet[];
    /** Bir turun açılmış (set tekrarları dahil) adım listesi — `sets`ten türer. */
    statuses?: PomodoroStatus[];
    intro?: { visual: string | null };
    rounds?: number;
    countdownBeep?: boolean;
    totalMinutes?: number;
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
  /** Yalnızca zip işlenen yanıtta: müzik klasöründeki zip'lerin açılma sonucu. */
  audioZip?: AudioZipResult;
  /** Pomodoro durum görüntüleri için seçilebilecek dosyalar (proje klasörüne göreli, iki klasörden). */
  visualCandidates?: string[];
  /** GET READY ve her durumun kayıtlı görüntüsü (`statuses` ile aynı sırada); boş value = ana görüntüyle aynı. */
  pomodoroVisuals?: {
    intro: { value: string; exists: boolean };
    statuses: Array<{ value: string; exists: boolean }>;
  };
  audioDir?: string;
  audioCount?: number;
  output?: ProjectFileEvidence;
  step?: ProjectStep;
  workflow?: ProjectWorkflow;
  /** Sunucu her zaman gönderir (getProject koşulsuz üretir). */
  readiness: ProjectReadiness;
};

export type AudioZipResult = {
  /** Klasöre eklenen yeni parçalar. */
  files: string[];
  archives: Array<{ zip: string; files: string[]; error?: string; noAudio?: boolean }>;
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

/** Programdaki bir adım (STUDY, BREAK, STRETCH…) — core/pomodoro-plan.js `PomodoroStatus` aynası. */
export type PomodoroStatus = {
  /** Ekranda yazan ad. */
  name: string;
  minutes: number;
  /** Çalışma mı mola mı (addan tahmin edilir, değiştirilebilir). */
  kind: StepKind;
  /** Bitişinde 3 bip çalsın mı. */
  beep: boolean;
  /** Görüntü yolu (proje klasörüne göreli); null → ana görüntüyle aynı. */
  visual: string | null;
};

export type StepKind = 'work' | 'break';

/** Set: art arda gelen adımlar + kaç kez art arda uygulanacağı. */
export type StepSet = {
  name: string;
  repeat: number;
  steps: PomodoroStatus[];
};

/**
 * Hazır/kayıtlı PROGRAM (setler + adımlar; görüntü girmez) — GET /api/pomodoro-sets.
 * Rota ve yanıt alanı adı tarihsel olarak "sets"; arayüzde bunlara "program" denir.
 * Hazır programlar `builtin: true`.
 */
export type PomodoroProgram = {
  id: string;
  name: string;
  builtin: boolean;
  sets: Array<{ name: string; repeat: number; steps: Array<Omit<PomodoroStatus, 'visual'>> }>;
  updatedAt: string | null;
  /** Dosya bozuksa sebebi; bozuk program seçilemez. */
  error?: string;
};

/** `sets` = programların listesi (sunucunun alan adı). */
export type PomodoroProgramsResponse = { sets: PomodoroProgram[]; limits: { name: number } };

/** Sunucuya giden set şekli (PUT .../pomodoro, POST /api/projects, kayıtlı program). */
export type StepSetPayload = {
  name?: string;
  repeat?: number;
  steps: Array<{ name: string; minutes: number; kind?: StepKind; beep?: boolean; visual?: string }>;
};

/** project.json'daki normalize edilmiş Pomodoro ayarı. */
export type PomodoroSettings = {
  /** Program: setler sırayla, her set `repeat` kez; hepsi bitince `rounds` kez başa döner. */
  sets: StepSet[];
  /** Bir turun açılmış (set tekrarları dahil) adım listesi. */
  statuses: PomodoroStatus[];
  /** GET READY görüntüsü; null → ana görüntü. */
  intro: { visual: string | null };
  rounds: number;
  /** Değerler bir hazır düzene denk geliyorsa onun kimliği. */
  preset: string | null;
  countdownSeconds: number;
  /** Her oturumun son 3 saniyesinde 3 bip. */
  countdownBeep: boolean;
  cue: {
    volumeDb: number;
    beepFile: string | null;
  };
};

/** Video üstü etiket türü — core/label-plan.js `LABEL_KINDS` aynası. */
export type LabelKind = 'text' | 'pomodoro-status' | 'pomodoro-countdown';

/** Bir etiketin GÖRSEL durumu. `x`/`y` 0–1, etiketin MERKEZİ; `size` kare yüksekliğinin oranı. */
export type VideoLabel = {
  id: string;
  kind: LabelKind;
  /** Yalnızca `text` türünde anlamlı; sistem etiketlerinin metni Pomodoro'dan gelir. */
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  /** Yalnızca `text` türünde: ikisi birlikte dolu ya da null (tüm video). */
  start: number | null;
  end: number | null;
};

export type ProjectLabels = {
  labels: VideoLabel[];
  problems: string[];
  warnings: string[];
  /** Çıktı kadrajının oranı, ör. "16:9". */
  aspect: string;
  /** Önizleme arka planı: sunucunun verdiği adres (klip, görsel ya da Shorts kaynağı). */
  preview: { url: string; kind: 'image' | 'video' } | null;
  /** GET READY oturumunda arkada görünen görüntü; null → ana görüntüyle aynı. */
  introPreview?: { url: string; kind: 'image' | 'video' } | null;
  /** Her durumun (döngüdeki sırayla) arkada görünen görüntüsü; null → ana görüntüyle aynı. */
  statusPreviews?: Array<{ url: string; kind: 'image' | 'video' } | null>;
  /** Yalnızca OKUNUR — oturum zamanlarını gösterir, Pomodoro ayarı burada değişmez. */
  pomodoro: { enabled: boolean; totalSeconds: number; sessions: PomodoroSession[] };
};

export type UpdateLabelsPayload = { labels: Array<Partial<VideoLabel> & { id: string }> };

/** Timeline'daki bir oturum: GET READY ya da döngüdeki bir durum (STUDY, BREAK, STRETCH…). */
export type PomodoroSession = {
  index: number;
  /** 'ready' = videonun başındaki 2 dakikalık GET READY oturumu. */
  kind: 'ready' | 'status';
  /** Döngüdeki sırası (GET READY için -1). */
  statusIndex: number;
  /** Ekranda yazan ad: "GET READY", "STUDY", "BREAK"… */
  name: string;
  stepKind: 'ready' | StepKind;
  round: number;
  /** Hangi set (GET READY için -1) ve o setin kaçıncı tekrarı. */
  setIndex: number;
  setName: string | null;
  repeat: number;
  /** "GET READY" / "STUDY 01" / "BREAK 03". */
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
  defaults: Pick<PomodoroSettings, 'sets' | 'statuses' | 'rounds' | 'countdownSeconds' | 'countdownBeep'> & { enabled: boolean };
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
    comparison: PomodoroComparison | null;
    trim: PomodoroTrim | null;
    timeline: { sessions: PomodoroSession[]; totalSeconds: number; totalMinutes: number } | null;
    cueCount: number;
  };
};

/** PUT /api/projects/:id/pomodoro gövdesi. `enabled: false` ayarı kaldırır. */
export type UpdatePomodoroPayload = {
  enabled: boolean;
  rounds?: number;
  /** Program; adımda `visual` yoksa ana görüntü kullanılır. */
  sets?: StepSetPayload[];
  intro?: { visual?: string };
  countdownSeconds?: number;
  countdownBeep?: boolean;
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
  /** Yalnızca "Pomodoro" seçildiyse; Ambiance'ta hiç gönderilmez. */
  pomodoro?: {
    /** Görüntü kurulumda verilemez (sunucu 400). */
    sets: StepSetPayload[];
    rounds: number;
    countdownBeep?: boolean;
  };
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
