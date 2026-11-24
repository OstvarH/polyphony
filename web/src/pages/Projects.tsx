import { ArrowRight, FolderOpen, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ago, api, type Project } from '../api.ts';
import { href } from '../router.ts';
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from '../ui.tsx';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.projects().then(setProjects, setError);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-dim">
            Describe what to build. Polyphony designs the team of agents, you approve, they build
            it.
          </p>
        </div>
        <a href={href({ page: 'new-project' })}>
          <Button variant="primary" icon={<Plus className="size-4" />}>
            New project
          </Button>
        </a>
      </div>
      <ErrorNote error={error} />
      {!projects && !error && <Spinner label="Loading projects" />}
      {projects && projects.length === 0 && (
        <Card>
          <Empty icon={<FolderOpen className="size-6" />} title="No projects yet">
            Start with a description such as “A real estate brokerage management and accounting
            system using Laravel, PostgreSQL and React.”
            <div className="mt-4">
              <a href={href({ page: 'new-project' })}>
                <Button variant="primary" icon={<Plus className="size-4" />}>
                  Create your first project
                </Button>
              </a>
            </div>
          </Empty>
        </Card>
      )}
      {projects && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <a
              key={project.id}
              href={href({ page: 'project', id: project.id, tab: 'plan' })}
              className="group flex flex-col rounded-2xl border border-line bg-panel/80 p-5 transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_12px_40px_-16px_rgb(124_156_255/0.5)]"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold">{project.name}</h2>
                <ArrowRight className="size-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-dim">{project.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {project.stack.slice(0, 5).map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
              <div className="mt-auto pt-4 text-[11px] text-faint">
                Updated {ago(project.updatedAt)}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
