import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { studioUploadContentType } from '@opencreator/protocol';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStudioRoutes } from '../../src/api/routes.studio.js';
import { resolveStudioEnvironment } from '../../src/studio/environment.js';
import { createStudioService } from '../../src/studio/service.js';

let dataDir = '';
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'studio-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function setup(env: NodeJS.ProcessEnv = {}) {
  const resolved = resolveStudioEnvironment({
    dataDir,
    env: { PATH: process.env.PATH, OPENCREATOR_STUDIO_PIPER: '/nonexistent', COMFYUI_URL: 'http://127.0.0.1:9', ...env }
  });
  return createStudioService({ env: resolved, unslothVideo: async () => ({ online: false, reason: 'no model' }) });
}

async function waitFor(service: ReturnType<typeof setup>, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await service.getJob(id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('job did not finish');
}

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe('studio service', () => {
  it('lists every capability with a reason when a dependency is missing', async () => {
    const { capabilities, components } = await setup().capabilities(true);
    const byId = Object.fromEntries(capabilities.map(entry => [entry.id, entry]));
    expect(byId.cinematic).toMatchObject({ runnable: false });
    expect(byId.cinematic!.reason).toMatch(/offline/i);
    expect(byId.minimax).toMatchObject({ runnable: false, reason: 'no model' });
    expect(byId.narrate!.runnable).toBe(false);
    expect(byId.course).toBeUndefined();
    expect(components.find(entry => entry.id === 'comfyui')?.available).toBe(false);
  });

  it('rejects unknown capabilities and missing prompts', async () => {
    const service = setup();
    await expect(service.createJob({ capability: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createJob({ capability: 'cinematic', prompt: '  ' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createJob({ capability: 'course' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.createJob({ capability: 'grade' })).rejects.toThrow(/uploaded video/);
    await expect(service.createJob({ capability: 'grade', uploadId: '0123456789abcdef' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('fails a job with the missing-tool message instead of hanging', async () => {
    const service = setup();
    const job = await service.createJob({ capability: 'narrate', prompt: 'hello' });
    const done = await waitFor(service, job.id);
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/Piper/);
    await service.deleteJob(job.id);
    await expect(service.getJob(job.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects unsupported and empty uploads', async () => {
    const service = setup();
    await expect(service.saveUpload({ fileName: 'x.exe', source: Readable.from([Buffer.from('a')]) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.saveUpload({ fileName: 'x.mp4', source: Readable.from([]) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it.skipIf(!hasFfmpeg)('runs an ffmpeg capability end to end over HTTP, with range support', async () => {
    const service = setup();
    const server = Fastify();
    await registerStudioRoutes(server, service);
    const source = join(dataDir, 'in.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-pix_fmt', 'yuv420p', source]);

    const upload = await server.inject({
      method: 'POST',
      url: '/studio/uploads?fileName=in.mp4',
      headers: { 'content-type': studioUploadContentType },
      payload: (await import('node:fs')).readFileSync(source)
    });
    expect(upload.statusCode).toBe(201);
    const big = await server.inject({ method: 'POST', url: '/studio/uploads?fileName=big.mp4', headers: { 'content-type': studioUploadContentType }, payload: Buffer.alloc(2 * 1024 * 1024, 1) });
    expect(big.statusCode).toBe(201);
    const { id: uploadId } = upload.json() as { id: string };

    const created = await server.inject({
      method: 'POST', url: '/studio/jobs',
      payload: { capability: 'vertical', uploadId, params: { target_aspect: 'square' } }
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { job: { id: string } }).job.id;
    expect((await waitFor(service, jobId)).status).toBe('done');

    const media = await server.inject({ method: 'GET', url: `/studio/jobs/${jobId}/media` });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('video/mp4');
    const total = Number(media.headers['content-length']);
    const partial = await server.inject({ method: 'GET', url: `/studio/jobs/${jobId}/media`, headers: { range: 'bytes=0-99' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-99/${total}`);
    expect(partial.rawPayload.length).toBe(100);
    const outOfRange = await server.inject({ method: 'GET', url: `/studio/jobs/${jobId}/media`, headers: { range: `bytes=${total + 10}-` } });
    expect(outOfRange.statusCode).toBe(416);

    const missing = await server.inject({ method: 'GET', url: '/studio/jobs/ffffffffffff/media' });
    expect(missing.statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/studio/jobs/..%2f..%2fetc/media' })).statusCode).toBe(404);
    await server.close();
  }, 60_000);
});
