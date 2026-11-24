import { useEffect, useState } from 'react';

/** Hash routes keep the app a static bundle the local server can serve as-is. */
export type Route =
  | { page: 'projects' }
  | { page: 'new-project' }
  | { page: 'project'; id: string; tab: 'plan' | 'runs' | 'files' | 'brief' }
  | { page: 'run'; id: string }
  | { page: 'settings' };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'projects' && parts[1] === 'new') return { page: 'new-project' };
  if (parts[0] === 'projects' && parts[1]) {
    const tab = parts[2];
    return {
      page: 'project',
      id: parts[1],
      tab: tab === 'runs' || tab === 'files' || tab === 'brief' ? tab : 'plan',
    };
  }
  if (parts[0] === 'runs' && parts[1]) return { page: 'run', id: parts[1] };
  if (parts[0] === 'settings') return { page: 'settings' };
  return { page: 'projects' };
}

export function href(route: Route): string {
  switch (route.page) {
    case 'projects':
      return '#/';
    case 'new-project':
      return '#/projects/new';
    case 'project':
      return `#/projects/${route.id}/${route.tab}`;
    case 'run':
      return `#/runs/${route.id}`;
    case 'settings':
      return '#/settings';
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
