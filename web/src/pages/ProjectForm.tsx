import { type FormEvent, useState } from 'react';
import type { ProjectInput } from '../api.ts';
import { Button, ErrorNote, Field, Input, lines, Textarea } from '../ui.tsx';

export const EXAMPLE =
  'A complete real estate brokerage management and accounting system: agents, listings, transactions and commission splits, trust accounting, and reports for the brokerage owner. Laravel API, PostgreSQL, React front end.';

/** The project brief, used to create a project and to edit it later. */
export function ProjectForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<ProjectInput>;
  submitLabel: string;
  onSubmit: (input: ProjectInput) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [stack, setStack] = useState((initial?.stack ?? []).join(', '));
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [deliverables, setDeliverables] = useState(lines.format(initial?.deliverables ?? []));
  const [criteria, setCriteria] = useState(lines.format(initial?.acceptanceCriteria ?? []));
  const [workspace, setWorkspace] = useState(initial?.workspace ?? '');
  const [repository, setRepository] = useState(initial?.repository ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name,
        description,
        stack: stack
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        instructions,
        deliverables: lines.parse(deliverables),
        acceptanceCriteria: lines.parse(criteria),
        workspace,
        ...(repository.trim() ? { repository: repository.trim() } : {}),
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Project name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Brokerage back office"
            required
          />
        </Field>
        <Field
          label="Preferred stack"
          hint="Comma separated: languages, frameworks, databases, infrastructure."
        >
          <Input
            value={stack}
            onChange={(e) => setStack(e.target.value)}
            placeholder="Laravel, PostgreSQL, React, Docker"
          />
        </Field>
      </div>
      <Field
        label="What should be built?"
        hint={
          <>
            The more specific, the better the plan.{' '}
            {!description && (
              <button
                type="button"
                className="text-accent underline-offset-2 hover:underline"
                onClick={() => setDescription(EXAMPLE)}
              >
                Use an example
              </button>
            )}
          </>
        }
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          required
          placeholder="Describe the idea, the users, the requirements and the objectives."
        />
      </Field>
      <Field
        label="Rules, constraints and coding standards"
        hint="Every agent receives these. For example: PSR-12, tests for every endpoint, no new dependencies without a reason."
      >
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Expected deliverables" hint="One per line.">
          <Textarea
            value={deliverables}
            onChange={(e) => setDeliverables(e.target.value)}
            rows={4}
          />
        </Field>
        <Field label="Acceptance criteria" hint="One per line.">
          <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={4} />
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label="Workspace folder"
          hint="Where the agents read and write code. Point it at an existing repository to have it analysed; a new folder is created if needed. Leave empty for a folder under ~/.polyphony/workspaces."
        >
          <Input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="C:\\code\\brokerage or /home/me/code/brokerage"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label="GitHub repository (optional)"
          hint="For reference in the plan. The agents work on the local workspace."
        >
          <Input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="https://github.com/you/brokerage"
          />
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
