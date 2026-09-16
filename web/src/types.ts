export type ProjectStep = {
  id?: string;
  title?: string;
  detail?: string;
  kind?: string;
  skippable?: boolean;
};

export type ProjectSummary = {
  id: string;
  name: string;
  mtimeMs: number;
  step?: ProjectStep;
};

export type ProjectFileEvidence = {
  path?: string;
  value?: string;
  exists?: boolean;
};

export type VideoSettings = {
  cropBottom?: number;
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
  };
  error?: string | null;
};

export type MusicTrack = {
  number: number;
  title: string;
  status?: string;
  file?: string | null;
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
    watermark: boolean | null;
    defaultCropBottom: number;
  };
  build: {
    ready: boolean;
    missing: string[];
  };
  output: {
    exists: boolean;
  };
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
  clips?: string[];
  clip?: ProjectFileEvidence;
  audioDir?: string;
  audioCount?: number;
  output?: ProjectFileEvidence;
  step?: ProjectStep;
  readiness?: ProjectReadiness;
};

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

export type BackendStyle = {
  name: string;
  kind: 'custom' | 'library';
  valid: boolean;
  suggestedAmbient?: string[] | null;
  hasReference?: boolean;
  styleBlock?: string;
  motionHints?: string;
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

export type CreateProjectPayload = {
  name: string;
  style: string;
  ambient?: string[];
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
};

export type Route =
  | { name: 'dashboard' }
  | { name: 'newProject' }
  | { name: 'project'; id: string }
  | { name: 'styles' }
  | { name: 'ambient' };

export type Navigate = (path: string) => void;

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';


