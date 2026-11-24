import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/** What the planner learns about an existing codebase before it proposes anything. */
export interface RepoAnalysis {
  root: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  /** File counts per language, largest first. */
  languages: { language: string; files: number }[];
  /** Frameworks and tools detected from manifests. */
  frameworks: string[];
  manifests: string[];
  /** Directory outline, two levels deep. */
  outline: string[];
  readme: string | null;
}

const IGNORED = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode',
  '.polyphony',
  'storage',
]);
const MAX_FILES = 20_000;

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.php': 'PHP',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.swift': 'Swift',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.dart': 'Dart',
  '.c': 'C',
  '.cpp': 'C++',
  '.h': 'C/C++',
};

const MANIFESTS: Record<string, (text: string) => string[]> = {
  'package.json': (text) => {
    const pkg = safeJson(text) as { dependencies?: object; devDependencies?: object } | null;
    const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
    const known: Record<string, string> = {
      react: 'React',
      vue: 'Vue',
      svelte: 'Svelte',
      next: 'Next.js',
      nuxt: 'Nuxt',
      '@angular/core': 'Angular',
      express: 'Express',
      fastify: 'Fastify',
      '@nestjs/core': 'NestJS',
      vite: 'Vite',
      tailwindcss: 'Tailwind CSS',
      prisma: 'Prisma',
      'drizzle-orm': 'Drizzle',
      typescript: 'TypeScript',
      vitest: 'Vitest',
      jest: 'Jest',
      '@inertiajs/react': 'Inertia',
    };
    return ['Node.js', ...deps.flatMap((d) => (known[d] ? [known[d]] : []))];
  },
  'composer.json': (text) => {
    const pkg = safeJson(text) as { require?: object } | null;
    const deps = Object.keys(pkg?.require ?? {});
    return [
      'PHP (Composer)',
      ...(deps.includes('laravel/framework') ? ['Laravel'] : []),
      ...(deps.some((d) => d.startsWith('symfony/')) ? ['Symfony'] : []),
    ];
  },
  'requirements.txt': (text) => [
    'Python',
    ...(/django/i.test(text) ? ['Django'] : []),
    ...(/fastapi/i.test(text) ? ['FastAPI'] : []),
    ...(/flask/i.test(text) ? ['Flask'] : []),
  ],
  'pyproject.toml': (text) => ['Python', ...(/django/i.test(text) ? ['Django'] : [])],
  'go.mod': () => ['Go modules'],
  'Cargo.toml': () => ['Rust (Cargo)'],
  'pom.xml': () => ['Java (Maven)'],
  'build.gradle': () => ['Gradle'],
  Gemfile: (text) => ['Ruby', ...(/rails/.test(text) ? ['Rails'] : [])],
  Dockerfile: () => ['Docker'],
  'docker-compose.yml': () => ['Docker Compose'],
  'compose.yaml': () => ['Docker Compose'],
};

export function analyzeRepository(root: string): RepoAnalysis {
  const analysis: RepoAnalysis = {
    root,
    exists: existsSync(root),
    fileCount: 0,
    totalBytes: 0,
    truncated: false,
    languages: [],
    frameworks: [],
    manifests: [],
    outline: [],
    readme: null,
  };
  if (!analysis.exists) return analysis;

  const languageCounts = new Map<string, number>();
  const frameworks = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (analysis.fileCount >= MAX_FILES) {
        analysis.truncated = true;
        return;
      }
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth < 2) analysis.outline.push(`${'  '.repeat(depth)}${entry.name}/`);
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        analysis.fileCount += 1;
        try {
          analysis.totalBytes += statSync(path).size;
        } catch {
          // unreadable file: counted, not sized
        }
        const language = LANGUAGES[extname(entry.name).toLowerCase()];
        if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        const detect = MANIFESTS[entry.name];
        if (detect && depth <= 2) {
          analysis.manifests.push(rel);
          for (const framework of detect(readSmall(path))) frameworks.add(framework);
        }
        if (depth === 0 && /^readme(\.md|\.txt)?$/i.test(entry.name)) {
          analysis.readme = readSmall(path).slice(0, 4000);
        }
      }
    }
  };
  walk(root, 0);
  analysis.languages = [...languageCounts]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files);
  analysis.frameworks = [...frameworks];
  analysis.outline = analysis.outline.slice(0, 120);
  return analysis;
}

/** A compact text version for a prompt. */
export function describeAnalysis(analysis: RepoAnalysis): string {
  if (!analysis.exists || analysis.fileCount === 0) {
    return 'The workspace is empty: this is a new project.';
  }
  const lines = [
    `Existing codebase: ${analysis.fileCount} files, ${(analysis.totalBytes / 1024).toFixed(0)} KiB${analysis.truncated ? ' (scan truncated)' : ''}.`,
    `Languages: ${analysis.languages.map((l) => `${l.language} (${l.files})`).join(', ') || 'none detected'}.`,
    `Frameworks and tools: ${analysis.frameworks.join(', ') || 'none detected'}.`,
    `Manifests: ${analysis.manifests.join(', ') || 'none'}.`,
    'Outline:',
    ...analysis.outline,
  ];
  if (analysis.readme) lines.push('README (start):', analysis.readme.slice(0, 1500));
  return lines.join('\n');
}

function readSmall(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 64_000);
  } catch {
    return '';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
