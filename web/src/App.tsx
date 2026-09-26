import { useCallback, useEffect, useState } from 'react';

import { AppLayout } from './components/AppLayout';
import { AmbientLibrary } from './pages/AmbientLibrary';
import { Dashboard } from './pages/Dashboard';
import { MusicHub } from './pages/MusicHub';
import { NewProject } from './pages/NewProject';
import { ProjectWorkspace } from './pages/ProjectWorkspace';
import { Settings } from './pages/Settings';
import { MusicStyles } from './pages/MusicStyles';
import { parseRoute, paths, projectPath } from './router';
import { applyTheme, getStoredTheme } from './theme';
import { ToastContainer } from './toast';
import type { Navigate, Route } from './types';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback<Navigate>((path) => {
    if (path !== window.location.pathname) {
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
  switch (route.name) {
    case 'project':
      return (
        <ProjectWorkspace key={route.id} id={route.id} onBack={() => navigate(paths.dashboard)} />
      );
    case 'newProject':
      return (
        <NewProject
          onCancel={() => navigate(paths.dashboard)}
          onCreated={(id) => navigate(projectPath(id))}
        />
      );
    case 'music':
      return <MusicHub />;
    case 'styles':
      return (
        <MusicStyles
          onUseStyle={(styleName) => navigate(`${paths.newProject}?style=${encodeURIComponent(styleName)}`)}
        />
      );
    case 'ambient':
      return <AmbientLibrary />;
    case 'settings':
      return <Settings />;
    case 'dashboard':
      return (
        <Dashboard
          onOpenProject={(id) => navigate(projectPath(id))}
          onNewProject={() => navigate(paths.newProject)}
        />
      );
  }
}

