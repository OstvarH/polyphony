import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SKIP = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.polyphony',
]);
const MAX_READ = 200_000;

export class WorkspaceError extends Error {}

/**
 * The folder agents work in. Every path an agent supplies is untrusted model output, so it is
 * resolved against the root and rejected if it escapes it, lexically and through symlinks.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  resolve(path: string): string {
    if (typeof path !== 'string' || path.includes('\0')) throw new WorkspaceError('invalid path');
    const target = resolve(this.root, path || '.');
    const rel = relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceError(`path "${path}" is outside the workspace`);
    }
    // Follow symlinks of the deepest existing ancestor and check again.
    let existing = target;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = realpathSync(existing);
    const realRel = relative(this.root, real);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new WorkspaceError(`path "${path}" leads outside the workspace`);
    }
    return target;
  }

  /** Workspace-relative path with forward slashes. */
  rel(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/') || '.';
  }

  list(path = '.', depth = 2): string[] {
    const start = this.resolve(path);
    if (!existsSync(start)) throw new WorkspaceError(`"${path}" does not exist`);
    const out: string[] = [];
    const walk = (dir: string, level: number) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (out.length >= 500) return;
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(`${this.rel(full)}/`);
          if (level < depth) walk(full, level + 1);
        } else {
          out.push(this.rel(full));
        }
      }
    };
    walk(start, 1);
    return out;
  }

  read(path: string, offset = 0, limit = MAX_READ): string {
    const file = this.resolve(path);
    if (!existsSync(file) || !statSync(file).isFile())
      throw new WorkspaceError(`"${path}" is not a file`);
    const text = readFileSync(file, 'utf8');
    const slice = text.slice(offset, offset + Math.min(limit, MAX_READ));
    const more = offset + slice.length < text.length;
    return more
      ? `${slice}\n[... ${text.length - offset - slice.length} more characters; read again with offset]`
      : slice;
  }

  write(path: string, content: string): string {
    const file = this.resolve(path);
    if (existsSync(file) && statSync(file).isDirectory())
      throw new WorkspaceError(`"${path}" is a directory`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return this.rel(file);
  }

  /** Replaces exactly one occurrence of `find`, so edits are unambiguous. */
  edit(path: string, find: string, replace: string): string {
    const file = this.resolve(path);
    if (!existsSync(file)) throw new WorkspaceError(`"${path}" does not exist`);
    const text = readFileSync(file, 'utf8');
    const first = text.indexOf(find);
    if (find.length === 0 || first === -1)
      throw new WorkspaceError('the text to replace was not found');
    if (text.indexOf(find, first + 1) !== -1) {
      throw new WorkspaceError('the text to replace occurs more than once; include more context');
    }
    writeFileSync(file, text.slice(0, first) + replace + text.slice(first + find.length), 'utf8');
    return this.rel(file);
  }

  search(query: string, path = '.', maxResults = 100): string[] {
    const start = this.resolve(path);
    const results: string[] = [];
    const needle = query.toLowerCase();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= maxResults || SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (statSync(full).size < 1_000_000) {
          const lines = readFileSync(full, 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (results.length < maxResults && line.toLowerCase().includes(needle)) {
              results.push(`${this.rel(full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
      }
    };
    if (existsSync(start)) walk(start);
    return results;
  }
}
