import type { Route } from './types';

export const paths = {
  dashboard: '/',
  newProject: '/new',
  ambient: '/ambient',
  mimi: '/mimi',
  prompts: '/prompts',
  settings: '/settings',
} as const;

export function parseRoute(pathname: string): Route {
  const [cleanPath, queryString = ''] = pathname.split('?');
  const projectMatch = cleanPath.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    return { name: 'project', id: decodeURIComponent(projectMatch[1]) };
  }
  // Üst proje rotanın parçası: NewProject eskiden bunu window.location.search
  // üzerinden kendisi okuyordu — aynı bilgi için router'ın yanından geçen
  // ikinci bir yoldu ve prop olarak da ayrıca taşınıyordu.
  if (cleanPath === paths.newProject) {
    const parentId = new URLSearchParams(queryString).get('parent') || undefined;
    return { name: 'newProject', parentId };
  }
  if (cleanPath === paths.ambient) return { name: 'ambient' };
  if (cleanPath === paths.mimi) return { name: 'mimi' };
  if (cleanPath === paths.prompts) return { name: 'prompts' };
  if (cleanPath === paths.settings) return { name: 'settings' };
  return { name: 'dashboard' };
}

export function projectPath(id: string) {
  return `/projects/${encodeURIComponent(id)}`;
}

/** "Yeni proje" adresi — üst proje verilirse alt proje olarak açılır. */
export function newProjectPath(parentId?: string) {
  return parentId ? `${paths.newProject}?parent=${encodeURIComponent(parentId)}` : paths.newProject;
}
