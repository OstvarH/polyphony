import { ArrowLeft } from 'lucide-react';
import { api } from '../api.ts';
import { href, navigate } from '../router.ts';
import { Card } from '../ui.tsx';
import { ProjectForm } from './ProjectForm.tsx';

export function NewProjectPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <a
        href={href({ page: 'projects' })}
        className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-ink"
      >
        <ArrowLeft className="size-4" /> Projects
      </a>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-dim">
          Next, the orchestration architect analyses it and proposes layers, agents, models and
          tasks for you to review.
        </p>
      </div>
      <Card className="p-6">
        <ProjectForm
          submitLabel="Create project"
          onSubmit={async (input) => {
            const project = await api.createProject(input);
            navigate({ page: 'project', id: project.id, tab: 'plan' });
          }}
        />
      </Card>
    </div>
  );
}
