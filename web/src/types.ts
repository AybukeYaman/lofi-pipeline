export type ProjectStep = {
  id?: string;
  title?: string;
  detail?: string;
  kind?: string;
  skippable?: boolean;
};

/** Canonical 8 adım — backend canonicalWorkflow (prep/project-status.js). */
export type WorkflowStepId =
  | 'project'
  | 'master'
  | 'angles'
  | 'video'
  | 'music'
  | 'order'
  | 'build'
  | 'publish';

export type WorkflowStepInfo = {
  id: WorkflowStepId;
  number: number;
  title: string;
  kind: 'manual' | 'auto' | 'done';
  optional: boolean;
  status: 'done' | 'current' | 'pending';
  skipped: boolean;
};

export type ProjectWorkflow = {
  current: WorkflowStepId;
  currentTitle: string;
  steps: WorkflowStepInfo[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  mtimeMs: number;
  /** Sunucunun seçtiği küçük resim: videodaki görsel, yoksa master, yoksa referans. */
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
    ambient?: string | string[];
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
    style?: string;
    order?: string[];
    workflow?: {
      angles?: { wanted: boolean; count?: number };
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
  /** Müzik stili; seçilmediyse null. */
  style: {
    name: string | null;
  };
  master: {
    ready: boolean;
  };
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
  dir?: string;
  promptsPath?: string;
  projectJson?: ProjectJsonState;
  style?: string | null;
  master?: string | null;
  angles?: string[];
  /** 'image': tüm video boyunca tek resim; clips o zaman MASTER + açı görselleri. */
  videoSource?: VideoSource;
  clips?: string[];
  clip?: ProjectFileEvidence;
  audioDir?: string;
  audioCount?: number;
  output?: ProjectFileEvidence;
  step?: ProjectStep;
  workflow?: ProjectWorkflow;
  readiness?: ProjectReadiness;
};

/** Kopyalanacak kamera açısı promptları. */
export type ProjectPrompts = {
  angles: Array<{ title: string; prompt: string }>;
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

export type ImageSlot = 'master' | 'angle';

export type MasterFrameInfo = {
  ready: boolean;
  file: string | null;
  previewUrl: string | null;
  folder: string;
  expectedName: string;
  acceptedExtensions: string[];
};

/** Müzik profili — sunucudaki prep/styles.js MUSIC_FIELDS; her alan metin ya da metin listesi. */
export type StyleMusic = {
  genre?: string | string[];
  production?: string | string[];
  instruments?: string | string[];
  aesthetic?: string | string[];
  exclude?: string | string[];
};

/** Müzik stili (GET /api/library, /api/styles). */
export type BackendStyle = {
  name: string;
  valid: boolean;
  music?: StyleMusic | null;
  hasMusicProfile?: boolean;
  suggestedAmbient?: string | null;
  problems?: string[];
  warnings?: string[];
};

/** POST/PUT /api/styles gövdesi; music: null profili siler, boş suggestedAmbient öneriyi siler. */
export type StylePayload = {
  name?: string;
  music?: StyleMusic | null;
  suggestedAmbient?: string;
};

export type BackendAmbient = {
  name: string;
};

export type LibraryResponse = {
  styles: BackendStyle[];
  ambients: BackendAmbient[];
  ambientError?: string | null;
};

export type VideoSource = 'clip' | 'image';

export type CreateProjectPayload = {
  name: string;
  /** Müzik stili, isteğe bağlı. */
  style?: string;
  ambient?: string[];
  videoSource?: VideoSource;
  concept?: string;
  totalTracks?: number;
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
  | { name: 'newProject' }
  | { name: 'project'; id: string }
  | { name: 'music' }
  | { name: 'styles' }
  | { name: 'ambient' }
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


