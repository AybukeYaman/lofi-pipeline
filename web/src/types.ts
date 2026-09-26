export type ProjectStep = {
  id?: string;
  title?: string;
  detail?: string;
  kind?: string;
  skippable?: boolean;
};

/** Canonical 10 adım — backend canonicalWorkflow (prep/project-status.js). */
export type WorkflowStepId =
  | 'project'
  | 'style'
  | 'reference'
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
      order?: 'alphabetical' | 'manual';
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
  style: {
    ready: boolean;
    name: string | null;
    styleBlockExists?: boolean;
    referenceCount: number;
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
  styleBlockExists?: boolean;
  references?: string[];
  projectJson?: ProjectJsonState;
  style?: string | null;
  master?: string | null;
  styleRef?: string | null;
  sceneRef?: string | null;
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

export type ProjectPrompts = {
  master: string | null;
  angles: Array<{ title: string; prompt: string }>;
  video: string | null;
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
};

export type ImageSlot = 'scene' | 'master' | 'angle';

export type MasterFrameInfo = {
  ready: boolean;
  file: string | null;
  previewUrl: string | null;
  folder: string;
  expectedName: string;
  acceptedExtensions: string[];
  prompt: string | null;
  promptError?: string | null;
};

export type StylePaletteColor = {
  hex: string;
  role: string;
};

export type StyleBlock = {
  medium?: string;
  lines?: string;
  palette?: StylePaletteColor[];
  light?: string;
  texture?: string;
  contrast?: string;
  shading?: string;
};

export type StyleMusic = {
  genre?: string;
  production?: string[];
  instruments?: string[];
  aesthetic?: string;
  exclude?: string[];
};

export type BackendStyle = {
  name: string;
  kind: 'custom' | 'library';
  valid: boolean;
  suggestedAmbient?: string[] | string | null;
  hasReference?: boolean;
  refUrl?: string | null;
  refUrls?: string[];
  references?: { name: string; url: string }[];
  styleBlock?: StyleBlock | string;
  motionHints?: string[] | string;
  music?: StyleMusic;
  raw?: Record<string, unknown>;
  problems?: string[];
  warnings?: string[];
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
  style: string;
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


