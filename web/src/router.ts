import type { Route } from './types';

export const paths = {
  dashboard: '/',
  newProject: '/new',
  ambient: '/ambient',
  prompts: '/prompts',
  settings: '/settings',
} as const;

export function parseRoute(pathname: string): Route {
  const cleanPath = pathname.split('?')[0];
  const projectMatch = cleanPath.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return { name: 'project', id: decodeURIComponent(projectMatch[1]) };
  }
  if (cleanPath === paths.newProject) return { name: 'newProject' };
  if (cleanPath === paths.ambient) return { name: 'ambient' };
  if (cleanPath === paths.prompts) return { name: 'prompts' };
  if (cleanPath === paths.settings) return { name: 'settings' };
  return { name: 'dashboard' };
}

export function projectPath(id: string) {
  return `/projects/${encodeURIComponent(id)}`;
}
