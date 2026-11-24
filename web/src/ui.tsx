import { Loader2 } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  busy = false,
  icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  icon?: ReactNode;
}) {
  const styles: Record<Variant, string> = {
    primary:
      'bg-accent text-[#0a0f1c] hover:brightness-110 shadow-[0_0_0_1px_rgb(124_156_255/0.4),0_8px_24px_-8px_rgb(124_156_255/0.6)]',
    secondary: 'bg-panel-2 text-ink border border-line hover:border-line-strong hover:bg-[#162033]',
    ghost: 'text-dim hover:text-ink hover:bg-panel-2',
    danger: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20',
  };
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        styles[variant],
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Card({
  className,
  children,
  title,
  action,
}: {
  className?: string;
  children: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cx('rounded-2xl border border-line bg-panel/80 backdrop-blur', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES = {
  neutral: 'bg-panel-2 text-dim border-line',
  accent: 'bg-accent/10 text-accent border-accent/30',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  bad: 'bg-bad/10 text-bad border-bad/30',
  info: 'bg-info/10 text-info border-info/30',
  violet: 'bg-accent-2/10 text-accent-2 border-accent-2/30',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="block space-y-1.5">
      <span className="text-xs font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint">{hint}</span>}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(inputClass, 'min-h-24 resize-y leading-relaxed', props.className)}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(inputClass, 'cursor-pointer pr-8', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-panel">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-dim">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="rounded-2xl border border-line bg-panel-2 p-3 text-accent">{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="max-w-md text-sm text-dim">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = (error as { issues?: string[] }).issues ?? [];
  return (
    <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
      {message}
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {issues.slice(0, 8).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Meter({
  value,
  tone = 'accent',
}: {
  value: number;
  tone?: 'accent' | 'warn' | 'bad' | 'ok';
}) {
  const colors = { accent: 'bg-accent', warn: 'bg-warn', bad: 'bg-bad', ok: 'bg-ok' };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div
        className={cx('h-full rounded-full transition-all duration-500', colors[tone])}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 truncate font-mono text-lg font-semibold text-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-dim">{sub}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { value: T; label: string; count?: number }[];
}) {
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cx(
            '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition',
            value === tab.value
              ? 'border-accent text-ink'
              : 'border-transparent text-dim hover:text-ink',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1.5 rounded bg-panel-2 px-1.5 text-[11px] text-dim">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Splits a multi-line text box into a list, and back. */
export const lines = {
  parse: (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  format: (items: string[]) => items.join('\n'),
};
