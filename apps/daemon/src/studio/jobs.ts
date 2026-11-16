import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StudioJob } from '@opencreator/protocol';

const JOB_ID = /^[a-f0-9]{12}$/;
const MAX_LISTED = 50;

export function isStudioJobId(value: string): boolean {
  return JOB_ID.test(value);
}

export type StudioJobStore = ReturnType<typeof createStudioJobStore>;

/** Jobs live in `<root>/<id>/job.json` next to their input and output files. */
export function createStudioJobStore(input: { root: string; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  const cache = new Map<string, StudioJob>();

  const directory = (id: string) => join(input.root, id);

  async function persist(job: StudioJob): Promise<void> {
    cache.set(job.id, job);
    const target = join(directory(job.id), 'job.json');
    await mkdir(directory(job.id), { recursive: true, mode: 0o700 });
    await writeFile(`${target}.tmp`, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  return {
    directory,
    outputPath(job: Pick<StudioJob, 'id' | 'mediaKind'>): string {
      return join(directory(job.id), job.mediaKind === 'audio' ? 'output.wav' : 'output.mp4');
    },

    async create(fields: Pick<StudioJob, 'capability' | 'title' | 'mediaKind' | 'prompt'>): Promise<StudioJob> {
      const job: StudioJob = {
        id: randomBytes(6).toString('hex'),
        ...fields,
        status: 'queued',
        log: [],
        createdAt: now().toISOString()
      };
      await persist(job);
      return job;
    },

    async update(id: string, patch: Partial<StudioJob> | ((job: StudioJob) => Partial<StudioJob>)): Promise<StudioJob | undefined> {
      const current = cache.get(id);
      if (current === undefined) return undefined;
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
      await persist(next);
      return next;
    },

    async get(id: string): Promise<StudioJob | undefined> {
      if (!isStudioJobId(id)) return undefined;
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      try {
        const job = JSON.parse(await readFile(join(directory(id), 'job.json'), 'utf8')) as StudioJob;
        cache.set(id, job);
        return job;
      } catch {
        return undefined;
      }
    },

    async list(): Promise<StudioJob[]> {
      let ids: string[];
      try {
        ids = (await readdir(input.root)).filter(isStudioJobId);
      } catch {
        return [];
      }
      const jobs = (await Promise.all(ids.map(id => this.get(id)))).filter((job): job is StudioJob => job !== undefined);
      return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_LISTED);
    },

    async remove(id: string): Promise<void> {
      if (!isStudioJobId(id)) return;
      cache.delete(id);
      await rm(directory(id), { recursive: true, force: true });
    },

    /** Jobs that were still active when the daemon stopped can never finish. */
    async recoverInterrupted(): Promise<void> {
      for (const job of await this.list()) {
        if (job.status !== 'queued' && job.status !== 'running') continue;
        await persist({
          ...job,
          status: 'error',
          error: 'Interrupted by a Runtime restart',
          finishedAt: now().toISOString()
        });
      }
    }
  };
}
