import { useCallback, useEffect, useState } from 'react';

import { AppLayout } from './components/AppLayout';
import { AmbientLibrary } from './pages/AmbientLibrary';
import { Dashboard } from './pages/Dashboard';
import { NewProject } from './pages/NewProject';
import { ProjectWorkspace } from './pages/ProjectWorkspace';
import { StyleLibrary } from './pages/StyleLibrary';
import { parseRoute, paths, projectPath } from './router';
import type { Navigate, Route } from './types';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

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
    <AppLayout route={route} navigate={navigate}>
      {renderRoute(route, navigate)}
    </AppLayout>
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
    case 'styles':
      return (
        <StyleLibrary
          onUseStyle={(styleId) => navigate(`${paths.newProject}?style=${encodeURIComponent(styleId)}`)}
        />
      );
    case 'ambient':
      return <AmbientLibrary />;
    case 'dashboard':
      return (
        <Dashboard
          onOpenProject={(id) => navigate(projectPath(id))}
          onNewProject={() => navigate(paths.newProject)}
        />
      );
  }
}
