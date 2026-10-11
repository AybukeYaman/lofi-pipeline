/**
 * Display-only status derived from the GET /api/projects/:id payload.
 * The workflow position itself comes from the backend `step`; these values
 * only describe whether each asset exists on disk.
 */

import type { AssetStatus } from '../../components/StatusBadge';
import type { ProjectDetail } from '../../types';

export function fileName(path?: string | null) {
  if (!path) return null;
  return path.split(/[\\/]/).pop() || path;
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

/**
 * `readiness` sunucudan HER ZAMAN geliyor (`getProject` onu koşulsuz üretiyor),
 * bu yüzden burada "readiness yoksa diskten kendimiz çıkaralım" dalı yoktu —
 * hiç çalışmıyordu ve aynı kuralın ikinci, sapmaya açık bir kopyasıydı.
 */
export function deriveAssets(project: ProjectDetail): ProjectAssets {
  const { clip, music, build, output } = project.readiness;
  const ambientCount = ambientFiles(project).length;

  return {
    clip: clip.ready ? 'ready' : (clip.selected || clip.availableCount > 0 ? 'waiting' : 'missing'),
    music: music.ready ? 'ready' : (music.audioCount > 0 || music.completedTrackCount > 0 ? 'waiting' : 'missing'),
    ambient: ambientCount > 0 ? 'ready' : 'optional',
    assembly: output.exists ? 'completed' : (build.ready ? 'ready' : 'waiting'),
    output: output.exists ? 'completed' : 'waiting',
  };
}
