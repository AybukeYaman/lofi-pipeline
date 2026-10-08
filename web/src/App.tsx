import { useCallback, useEffect, useState } from 'react';

import { AppLayout } from './components/AppLayout';
import { AmbientLibrary } from './pages/AmbientLibrary';
import { MimiGallery } from './pages/MimiGallery';
import { PromptLibrary } from './pages/PromptLibrary';
import { Dashboard } from './pages/Dashboard';
import { NewProject } from './pages/NewProject';
import { ProjectWorkspace } from './pages/ProjectWorkspace';
import { Settings } from './pages/Settings';
import { newProjectPath, parseRoute, paths, projectPath } from './router';
import { applyTheme, getStoredTheme } from './theme';
import { ToastContainer } from './toast';
import type { Navigate, Route } from './types';

function currentPath() {
  return `${window.location.pathname}${window.location.search}`;
}

export function App() {
  // pathname + search birlikte: rota `?parent=` taşıyor, pathname tek başına
  // onu düşürüyordu (sayfa yenilenince üst proje seçimi kayboluyordu).
  const [route, setRoute] = useState<Route>(() => parseRoute(currentPath()));

  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(currentPath()));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback<Navigate>((path) => {
    if (path !== currentPath()) {
      window.history.pushState(null, '', path);
    }
    setRoute(parseRoute(path));
    window.scrollTo(0, 0);
  }, []);

  return (
    <>
      <AppLayout route={route} navigate={navigate}>
        {renderRoute(route, navigate)}
      </AppLayout>
      <ToastContainer />
    </>
  );
}

function renderRoute(route: Route, navigate: Navigate) {
  const goToNewProject = (parentId?: string) => navigate(newProjectPath(parentId));
  switch (route.name) {
    case 'project':
      return (
        <ProjectWorkspace
          key={route.id}
          id={route.id}
          onBack={() => navigate(paths.dashboard)}
          onOpenProject={(id) => navigate(projectPath(id))}
          onNewProject={goToNewProject}
        />
      );
    case 'newProject':
      return (
        <NewProject
          initialParentId={route.parentId}
          onCancel={() => navigate(paths.dashboard)}
          onCreated={(id) => navigate(projectPath(id))}
        />
      );
    case 'ambient':
      return <AmbientLibrary />;
    case 'mimi':
      return <MimiGallery />;
    case 'prompts':
      return <PromptLibrary />;
    case 'settings':
      return <Settings />;
    case 'dashboard':
      return (
        <Dashboard
          onOpenProject={(id) => navigate(projectPath(id))}
          onNewProject={goToNewProject}
        />
      );
  }
}
