import { Boxes, FolderKanban, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.ts';
import { NewProjectPage } from './pages/NewProject.tsx';
import { ProjectPage } from './pages/Project.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { RunPage } from './pages/Run.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { href, useRoute } from './router.ts';
import './styles.css';
import { cx } from './ui.tsx';

function App() {
  const route = useRoute();
  const [demo, setDemo] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh the demo banner on every navigation
  useEffect(() => {
    api.settings().then(
      (s) => setDemo(s.demoMode),
      () => {},
    );
  }, [route.page]);

  const nav = [
    {
      label: 'Projects',
      icon: <FolderKanban className="size-4" />,
      to: href({ page: 'projects' }),
      active: route.page !== 'settings',
    },
    {
      label: 'Settings',
      icon: <SettingsIcon className="size-4" />,
      to: href({ page: 'settings' }),
      active: route.page === 'settings',
    },
  ];

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-5 backdrop-blur md:flex">
        <a href="#/" className="mb-8 flex items-center gap-2.5 px-2">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 shadow-[0_8px_24px_-8px_rgb(124_156_255/0.8)]">
            <Boxes className="size-4.5 text-[#0a0f1c]" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-wide">Polyphony</div>
            <div className="text-[10.5px] text-faint">Agent orchestration</div>
          </div>
        </a>
        <nav className="space-y-1">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.to}
              className={cx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                item.active ? 'bg-panel-2 text-ink' : 'text-dim hover:bg-panel-2 hover:text-ink',
              )}
            >
              {item.icon}
              {item.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto rounded-xl border border-line bg-panel-2/60 p-3 text-[11px] leading-relaxed text-dim">
          Runs on your machine with your own API keys. Nothing is sent anywhere except to the model
          providers you configure.
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {demo && route.page !== 'settings' && (
          <div className="flex items-center justify-center gap-2 border-b border-accent/20 bg-accent/10 px-4 py-2 text-xs text-accent">
            <Sparkles className="size-3.5" />
            Demo mode: plans and agents use the offline mock model.
            <a
              href={href({ page: 'settings' })}
              className="font-semibold underline underline-offset-2"
            >
              Add an API key
            </a>
            to use real models.
          </div>
        )}
        <div className="mx-auto max-w-[1500px] px-5 py-7 md:px-8">
          {route.page === 'projects' && <ProjectsPage />}
          {route.page === 'new-project' && <NewProjectPage />}
          {route.page === 'project' && <ProjectPage id={route.id} tab={route.tab} />}
          {route.page === 'run' && <RunPage id={route.id} />}
          {route.page === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
