import { spawnCreatorProcess } from '../creator/process-tree.js';

export class StudioCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly output: string
  ) {
    super(message);
    this.name = 'StudioCommandError';
  }
}

/** A required tool or service is missing or offline; the message says how to fix it. */
export class StudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioUnavailableError';
  }
}

export type RunCommandOptions = {
  signal: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /** Called for every complete stdout/stderr line. */
  onLine?: (line: string) => void;
};

export type RunCommandResult = { stdout: string; stderr: string };

const OUTPUT_TAIL_BYTES = 64 * 1024;

/** Run an executable, keep the output tail, and kill the whole process tree on abort or timeout. */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const local = new AbortController();
    const forward = () => local.abort(options.signal.reason);
    if (options.signal.aborted) forward();
    else options.signal.addEventListener('abort', forward, { once: true });
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => local.abort(new Error('timed out')), options.timeoutMs);

    const child = spawnCreatorProcess(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    }, local.signal);

    let stdout = '';
    let stderr = '';
    const pending = { out: '', err: '' };
    const feed = (key: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (key === 'out') stdout = tail(stdout + text);
      else stderr = tail(stderr + text);
      if (options.onLine === undefined) return;
      const lines = (pending[key] + text).split(/\r\n|\r|\n/);
      pending[key] = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) options.onLine(line);
    };
    child.stdout?.on('data', (chunk: Buffer) => feed('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => feed('err', chunk));
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin);
    }

    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort', forward);
    };
    child.once('error', error => {
      finish();
      reject(new StudioCommandError(`${command}: ${error.message}`, null, ''));
    });
    child.once('close', code => {
      finish();
      for (const rest of [pending.out, pending.err]) {
        if (rest.trim().length > 0) options.onLine?.(rest);
      }
      if (options.signal.aborted) {
        reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted'));
        return;
      }
      if (local.signal.aborted) {
        reject(new StudioCommandError(`${command} timed out`, code, stderr || stdout));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().split('\n').slice(-6).join('\n');
      reject(new StudioCommandError(
        `${command} exited with code ${code ?? 'null'}${detail.length > 0 ? `: ${detail}` : ''}`,
        code,
        stderr || stdout
      ));
    });
  });
}

function tail(value: string): string {
  return value.length > OUTPUT_TAIL_BYTES ? value.slice(value.length - OUTPUT_TAIL_BYTES) : value;
}
