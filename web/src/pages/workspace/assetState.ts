/**
 * Display-only status derived from the GET /api/projects/:id payload.
 * The workflow position itself comes from the backend `step`; these values
 * only describe whether each asset exists on disk.
 */

import type { AssetStatus } from '../../components/StatusBadge';
import type { MusicTrack, ProjectDetail } from '../../types';

export function fileName(path?: string | null) {
  if (!path) return null;
  return path.split(/[\\/]/).pop() || path;
}

export function musicTracks(project: ProjectDetail): MusicTrack[] {
  const tracks = project.projectJson?.data?.music?.tracks;
  return Array.isArray(tracks) ? tracks : [];
}

export function ambientFiles(project: ProjectDetail): string[] {
  const ambient = project.projectJson?.data?.ambient;
  if (Array.isArray(ambient)) return ambient;
  return typeof ambient === 'string' && ambient ? [ambient] : [];
}

export type ProjectAssets = Record<
  'clip' | 'music' | 'ambient' | 'assembly' | 'output',
  AssetStatus
>;

export function deriveAssets(project: ProjectDetail): ProjectAssets {
  const readiness = project.readiness;
  const clipCount = readiness?.clip ? readiness.clip.availableCount : (project.clips?.length ?? 0);
  const ambientCount = ambientFiles(project).length;
  const outputExists = readiness?.output ? readiness.output.exists : Boolean(project.output?.exists);

  if (readiness) {
    return {
      clip: readiness.clip.ready ? 'ready' : (readiness.clip.selected || clipCount > 0 ? 'waiting' : 'missing'),
      music: readiness.music.ready ? 'ready' : (readiness.music.audioCount > 0 || readiness.music.completedTrackCount > 0 ? 'waiting' : 'missing'),
      ambient: ambientCount > 0 ? 'ready' : 'optional',
      assembly: outputExists ? 'completed' : (readiness.build.ready ? 'ready' : 'waiting'),
      output: outputExists ? 'completed' : 'waiting',
    };
  }

  return {
    clip: project.clip?.exists ? 'ready' : !project.clip?.value && clipCount > 0 ? 'waiting' : 'missing',
    music: musicStatus(project),
    ambient: ambientCount > 0 ? 'ready' : 'optional',
    assembly: outputExists ? 'completed' : project.step?.id === 'build' ? 'ready' : 'waiting',
    output: outputExists ? 'completed' : 'waiting',
  };
}

function musicStatus(project: ProjectDetail): AssetStatus {
  const music = project.projectJson?.data?.music;
  const tracks = musicTracks(project);
  const audioCount = project.audioCount ?? 0;

  if (tracks.length > 0) {
    const done =
      music?.status === 'completed' ||
      music?.status === 'completed_by_user' ||
      tracks.every((track) => track.status === 'completed');
    return done ? 'ready' : 'waiting';
  }
  return audioCount > 0 ? 'ready' : 'missing';
}
