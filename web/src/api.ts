import type {
  BuildJob,
  CreateProjectPayload,
  CreateProjectResponse,
  LibraryResponse,
  ProjectDetail,
  ProjectSummary,
} from './types';

export class ApiError extends Error {
  status: number;
  details: Record<string, unknown>;
  problems?: string[];
  missing?: string[];

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    if (Array.isArray(details.problems)) {
      this.problems = details.problems as string[];
    }
    if (Array.isArray(details.missing)) {
      this.missing = details.missing as string[];
    }
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found.');
    this.name = 'ProjectNotFoundError';
  }
}

async function handleResponse<T>(response: Response, defaultMessage: string): Promise<T> {
  if (!response.ok) {
    let errorData: Record<string, unknown> | null = null;
    try {
      errorData = (await response.json()) as Record<string, unknown>;
    } catch {
      // JSON parse error fallback
    }
    const message = (typeof errorData?.error === 'string' && errorData.error) || defaultMessage;
    if (response.status === 404 && defaultMessage === 'Could not load project.') {
      throw new ProjectNotFoundError();
    }
    throw new ApiError(response.status, message, errorData || {});
  }
  return response.json() as Promise<T>;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects');
  return handleResponse<ProjectSummary[]>(response, 'Projects could not be loaded.');
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  return handleResponse<ProjectDetail>(response, 'Could not load project.');
}

export async function fetchLibrary(): Promise<LibraryResponse> {
  const response = await fetch('/api/library');
  return handleResponse<LibraryResponse>(response, 'Library could not be loaded.');
}

export async function createProject(payload: CreateProjectPayload): Promise<CreateProjectResponse> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<CreateProjectResponse>(response, 'Project could not be created.');
}

export type SelectClipPayload = {
  file: string;
  cropBottom?: number;
  watermark?: boolean;
};

export async function selectProjectClip(
  id: string,
  payload: string | SelectClipPayload,
): Promise<ProjectDetail> {
  const body = typeof payload === 'string' ? { file: payload } : payload;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/clip`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await handleResponse<ProjectDetail>(response, 'Clip could not be selected.');
  } catch (err: unknown) {
    if (
      err instanceof ApiError &&
      err.status === 400 &&
      typeof err.message === 'string' &&
      err.message.includes('Unknown field') &&
      body.file
    ) {
      const fallbackResponse = await fetch(`/api/projects/${encodeURIComponent(id)}/clip`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: body.file }),
      });
      return await handleResponse<ProjectDetail>(fallbackResponse, 'Clip could not be selected.');
    }
    throw err;
  }
}

export const updateProjectClipSettings = selectProjectClip;

export async function completeProjectMusic(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/music/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return handleResponse<ProjectDetail>(response, 'Music could not be completed.');
}

export async function startBuild(
  id: string,
  options: { overwrite?: boolean } = {},
): Promise<BuildJob> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return handleResponse<BuildJob>(response, 'Build could not be started.');
}

export async function fetchBuildStatus(id: string): Promise<BuildJob> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/build`);
  return handleResponse<BuildJob>(response, 'Build status could not be loaded.');
}

export type UpdateCropPayload = {
  watermark?: boolean;
  cropBottom?: number;
};

export async function updateProjectCrop(
  id: string,
  payload: UpdateCropPayload,
): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/crop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<ProjectDetail>(response, 'Crop settings could not be updated.');
}

export async function fetchProjectMaster(id: string): Promise<import('./types').MasterFrameInfo> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/master`);
  return handleResponse<import('./types').MasterFrameInfo>(response, 'Master frame info could not be loaded.');
}

export function getProjectMasterUrl(projectId: string, fileName?: string | null): string {
  if (!fileName) return '';
  const name = fileName.split(/[\\/]/).pop() || fileName;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/master/${encodeURIComponent(name)}`;
}

export function getProjectReferenceUrl(projectId: string, refPathOrName: string): string {
  const name = refPathOrName.split(/[\\/]/).pop() || refPathOrName;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/reference/${encodeURIComponent(name)}`;
}

export function getProjectClipUrl(projectId: string, clipPathOrName?: string | null): string {
  if (!clipPathOrName) return '';
  const name = clipPathOrName.split(/[\\/]/).pop() || clipPathOrName;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/video/${encodeURIComponent(name)}`;
}

export function getProjectOutputUrl(projectId: string, fileName?: string | null): string {
  const name = (fileName && (fileName.split(/[\\/]/).pop() || fileName)) || 'final_ambient.mp4';
  return `/api/projects/${encodeURIComponent(projectId)}/assets/output/${encodeURIComponent(name)}`;
}



