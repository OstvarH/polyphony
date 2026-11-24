import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Scale,
  Server,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ModelInfo,
  type ProviderView,
  type SettingsView,
  type Strategy,
} from '../api.ts';
import { Badge, Button, Card, cx, ErrorNote, Field, Input, Spinner } from '../ui.tsx';

const PROVIDERS: {
  id: string;
  kind: ProviderView['kind'];
  label: string;
  keyUrl?: string;
  keyHint: string;
  baseURL?: string;
}[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Starts with sk-ant-',
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Starts with sk-',
  },
  {
    id: 'google',
    kind: 'google',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'From Google AI Studio',
  },
  {
    id: 'ollama',
    kind: 'openai-compatible',
    label: 'Ollama (local models)',
    keyHint: 'No key needed for a local server',
    baseURL: 'http://127.0.0.1:11434/v1',
  },
  {
    id: 'mock',
    kind: 'mock',
    label: 'Mock (offline demo)',
    keyHint: 'No key: deterministic offline model for trying Polyphony',
  },
];

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    () =>
      Promise.all([api.providers(), api.models(), api.settings()]).then(([p, m, s]) => {
        setProviders(p);
        setModels(m);
        setSettings(s);
      }, setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorNote error={error} />;
  if (!providers || !settings) return <Spinner label="Loading settings" />;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-dim">
          Keys are encrypted on this machine and only sent to their own provider. You pay the
          providers directly for what your agents use.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4 text-accent" /> Model providers
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {PROVIDERS.map((def) => (
            <ProviderCard
              key={def.id}
              def={def}
              current={providers.find((p) => p.id === def.id)}
              onChanged={load}
            />
          ))}
        </div>
      </section>

      <StrategyCard settings={settings} onSaved={load} />

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Server className="size-4 text-accent" /> Model catalog
        </h2>
        <p className="text-xs text-dim">
          The orchestrator matches each agent's needs against these ratings. Rate new models
          yourself; “heuristic” ratings were guessed from the name. Prices are per million tokens
          and drive cost tracking.
        </p>
        <ModelTable models={models} onSaved={load} />
      </section>
    </div>
  );
}

function ProviderCard({
  def,
  current,
  onChanged,
}: {
  def: (typeof PROVIDERS)[number];
  current: ProviderView | undefined;
  onChanged: () => void;
}) {
  const [key, setKey] = useState('');
  const [baseURL, setBaseURL] = useState(current?.baseURL ?? def.baseURL ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const needsKey = def.kind !== 'mock' && def.kind !== 'openai-compatible';

  const act = (name: string, action: () => Promise<unknown>) => async () => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const save = (enabled: boolean, apiKey?: string | null) =>
    api.saveProvider(def.id, {
      kind: def.kind,
      label: def.label,
      enabled,
      ...(def.kind === 'openai-compatible' && baseURL ? { baseURL } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            {def.label}
            {current?.usable ? (
              <Badge tone="ok">
                <CheckCircle2 className="size-3" /> Connected
              </Badge>
            ) : current ? (
              <Badge tone="warn">{current.enabled ? 'Needs a key' : 'Disabled'}</Badge>
            ) : (
              <Badge>Not set up</Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-faint">{def.keyHint}</div>
        </div>
        {def.keyUrl && (
          <a
            href={def.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Get a key <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {needsKey && (
          <Field label={current?.hasKey ? `API key (saved: ${current.maskedKey})` : 'API key'}>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={current?.hasKey ? 'Paste a new key to replace it' : 'Paste your key'}
              autoComplete="off"
            />
          </Field>
        )}
        {def.kind === 'openai-compatible' && (
          <Field
            label="Server URL"
            hint="Any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, OpenRouter..."
          >
            <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
          </Field>
        )}
        {note && <div className="text-xs text-ok">{note}</div>}
        <ErrorNote error={error} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            busy={busy === 'save'}
            disabled={needsKey && !key && !current?.hasKey}
            onClick={act('save', async () => {
              await save(true, key ? key : undefined);
              setKey('');
              if (def.kind !== 'mock') {
                const result = await api.syncProvider(def.id);
                setNote(
                  `Connected: ${result.models} models available, ${result.added} new in the catalog.`,
                );
              }
            })}
          >
            {current ? 'Save and test' : 'Connect'}
          </Button>
          {current && def.kind !== 'mock' && (
            <Button
              icon={<RefreshCw className="size-4" />}
              busy={busy === 'sync'}
              onClick={act('sync', async () => {
                const result = await api.syncProvider(def.id);
                setNote(`${result.models} models available, ${result.added} new in the catalog.`);
              })}
            >
              Sync models
            </Button>
          )}
          {current && (
            <Button
              variant="ghost"
              busy={busy === 'toggle'}
              onClick={act('toggle', () => save(!current.enabled))}
            >
              {current.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          {current?.hasKey && (
            <Button
              variant="ghost"
              className="text-bad"
              icon={<Trash2 className="size-4" />}
              busy={busy === 'forget'}
              onClick={act('forget', () => save(current.enabled, null))}
            >
              Forget key
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function StrategyCard({ settings, onSaved }: { settings: SettingsView; onSaved: () => void }) {
  const [strategy, setStrategy] = useState<Strategy>(settings.strategy);
  const [busy, setBusy] = useState(false);
  const total = strategy.weights.capability + strategy.weights.cost + strategy.weights.speed || 1;
  const weight = (key: keyof Strategy['weights'], label: string) => (
    <Field label={`${label} · ${Math.round((strategy.weights[key] / total) * 100)}%`}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={strategy.weights[key]}
        onChange={(e) =>
          setStrategy({
            ...strategy,
            name: 'Custom',
            weights: { ...strategy.weights, [key]: Number(e.target.value) },
          })
        }
        className="w-full accent-[#7c9cff]"
      />
    </Field>
  );
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Scale className="size-4 text-accent" /> Model selection strategy
      </h2>
      <Card className="p-5">
        <div className="flex flex-wrap gap-2">
          {Object.entries(settings.presets).map(([key, preset]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStrategy(preset)}
              className={cx(
                'rounded-lg border px-3 py-1.5 text-sm transition',
                strategy.name === preset.name
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-line text-dim hover:text-ink',
              )}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <div className="mt-5 grid gap-5 md:grid-cols-3">
          {weight('capability', 'Capability fit')}
          {weight('cost', 'Cost')}
          {weight('speed', 'Speed')}
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-dim">
          <input
            type="checkbox"
            checked={strategy.avoidOverkill}
            onChange={(e) =>
              setStrategy({ ...strategy, name: 'Custom', avoidOverkill: e.target.checked })
            }
            className="accent-[#7c9cff]"
          />
          Avoid models far stronger than a role needs
        </label>
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await api.setStrategy(strategy).finally(() => setBusy(false));
              onSaved();
            }}
          >
            Save strategy
          </Button>
        </div>
      </Card>
    </section>
  );
}

function ModelTable({ models, onSaved }: { models: ModelInfo[]; onSaved: () => void }) {
  const update = async (model: ModelInfo, patch: Partial<ModelInfo>) => {
    await api.saveModel({ ...model, ...patch });
    onSaved();
  };
  const rating = (model: ModelInfo, key: 'reasoning' | 'coding' | 'speed') => (
    <select
      value={model[key]}
      onChange={(e) => update(model, { [key]: Number(e.target.value) })}
      className="rounded border border-line bg-panel-2 px-1 py-0.5 text-xs"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <option key={n}>{n}</option>
      ))}
    </select>
  );
  const price = (model: ModelInfo, key: 'inputPrice' | 'outputPrice') => (
    <input
      defaultValue={model[key] ?? ''}
      placeholder="?"
      onBlur={(e) => {
        const value = e.target.value.trim() === '' ? null : Number(e.target.value);
        if (value !== model[key] && (value === null || Number.isFinite(value)))
          update(model, { [key]: value });
      }}
      className="w-16 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-right font-mono text-xs"
    />
  );
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-[11px] uppercase tracking-wider text-faint">
          <tr>
            {[
              '',
              'Model',
              'Provider',
              'Reasoning',
              'Coding',
              'Speed',
              'Context',
              '$ in',
              '$ out',
              'Ratings',
            ].map((h) => (
              <th key={h} className="px-3 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {models.map((model) => (
            <tr
              key={`${model.provider}/${model.id}`}
              className={cx(!model.enabled && 'opacity-50')}
            >
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={model.enabled}
                  onChange={(e) => update(model, { enabled: e.target.checked })}
                  className="accent-[#7c9cff]"
                  aria-label={`Use ${model.label}`}
                />
              </td>
              <td className="px-3 py-2">
                <div className="font-medium">{model.label}</div>
                <code className="text-[10.5px] text-faint">{model.id}</code>
              </td>
              <td className="px-3 py-2 text-dim">{model.provider}</td>
              <td className="px-3 py-2">{rating(model, 'reasoning')}</td>
              <td className="px-3 py-2">{rating(model, 'coding')}</td>
              <td className="px-3 py-2">{rating(model, 'speed')}</td>
              <td className="px-3 py-2 font-mono text-xs text-dim">
                {model.contextWindow >= 1_000_000
                  ? `${model.contextWindow / 1_000_000}M`
                  : `${Math.round(model.contextWindow / 1000)}k`}
              </td>
              <td className="px-3 py-2">{price(model, 'inputPrice')}</td>
              <td className="px-3 py-2">{price(model, 'outputPrice')}</td>
              <td className="px-3 py-2">
                <Badge
                  tone={
                    model.source === 'heuristic'
                      ? 'warn'
                      : model.source === 'user'
                        ? 'accent'
                        : 'neutral'
                  }
                >
                  {model.source}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
