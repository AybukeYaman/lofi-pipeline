import type { Route } from './types';

export const paths = {
  dashboard: '/',
  newProject: '/new',
  styles: '/styles',
  ambient: '/ambient',
} as const;

export function parseRoute(pathname: string): Route {
  const cleanPath = pathname.split('?')[0];
  const projectMatch = cleanPath.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return { name: 'project', id: decodeURIComponent(projectMatch[1]) };
  }
  if (cleanPath === paths.newProject) return { name: 'newProject' };
  if (cleanPath === paths.styles) return { name: 'styles' };
  if (cleanPath === paths.ambient) return { name: 'ambient' };
  return { name: 'dashboard' };
}

export function projectPath(id: string) {
  return `/projects/${encodeURIComponent(id)}`;
}
