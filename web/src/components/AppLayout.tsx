import type { MouseEvent, ReactNode } from 'react';

import { paths } from '../router';
import type { Navigate, Route } from '../types';

const navItems = [
  { label: 'Projects', path: paths.dashboard, routes: ['dashboard', 'project'] },
  { label: 'New Project', path: paths.newProject, routes: ['newProject'] },
  { label: 'Music Hub', path: paths.music, routes: ['music'] },
  { label: 'Music Styles', path: paths.styles, routes: ['styles'] },
  { label: 'Ambient', path: paths.ambient, routes: ['ambient'] },
  { label: 'Settings', path: paths.settings, routes: ['settings'] },
] as const;

type AppLayoutProps = {
  route: Route;
  navigate: Navigate;
  children: ReactNode;
};

export function AppLayout({ route, navigate, children }: AppLayoutProps) {
  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar-inner">
          <AppLink className="brand" href={paths.dashboard} navigate={navigate}>
            Lofi Pipeline
          </AppLink>
          <nav className="topnav" aria-label="Primary">
            {navItems.map((item) => {
              const isActive = (item.routes as readonly string[]).includes(route.name);
              return (
                <AppLink
                  key={item.path}
                  className={isActive ? 'active' : undefined}
                  href={item.path}
                  navigate={navigate}
                  current={isActive}
                >
                  {item.label}
                </AppLink>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="app-shell">{children}</main>
    </div>
  );
}

type AppLinkProps = {
  href: string;
  navigate: Navigate;
  className?: string;
  current?: boolean;
  children: ReactNode;
};

/** Real anchor (keeps middle-click / copy link) that routes in-app on plain click. */
function AppLink({ href, navigate, className, current, children }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return (
    <a
      className={className}
      href={href}
      aria-current={current ? 'page' : undefined}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
