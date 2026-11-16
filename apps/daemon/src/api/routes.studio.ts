import { createReadStream } from 'node:fs';
import type { CreateStudioJobRequest } from '@opencreator/protocol';
import { studioUploadContentType } from '@opencreator/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { StudioError, type StudioService } from '../studio/service.js';
import { apiError } from './errors.js';

// The service enforces the per-kind limits while streaming; this only lifts Fastify's 1 MB default.
const STUDIO_UPLOAD_LIMIT = 4 * 1024 * 1024 * 1024;

export async function registerStudioRoutes(server: FastifyInstance, service: StudioService): Promise<void> {
  server.get<{ Querystring: { refresh?: string } }>('/studio/capabilities', async request =>
    await service.capabilities(request.query.refresh === '1'));

  server.get<{ Querystring: { refresh?: string } }>('/studio/worker', async request =>
    await service.worker.status(request.query.refresh === '1'));
  server.post('/studio/worker/start', async () => await service.worker.start());
  server.post('/studio/worker/stop', async () => await service.worker.stop());

  server.addContentTypeParser(studioUploadContentType, { bodyLimit: STUDIO_UPLOAD_LIMIT }, (_request, payload, done) => done(null, payload));
  server.post<{ Body: Readable; Querystring: { fileName?: string } }>('/studio/uploads', { bodyLimit: STUDIO_UPLOAD_LIMIT }, async (request, reply) => {
    try {
      const fileName = request.query.fileName?.trim() ?? '';
      if (fileName.length === 0) throw new StudioError('VALIDATION_FAILED', 'fileName is required', 400);
      return reply.code(201).send(await service.saveUpload({ fileName, source: request.body }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.get('/studio/jobs', async () => ({ jobs: await service.listJobs() }));

  server.post<{ Body: CreateStudioJobRequest }>('/studio/jobs', async (request, reply) => {
    try {
      const body = request.body;
      if (typeof body !== 'object' || body === null || typeof body.capability !== 'string') {
        throw new StudioError('VALIDATION_FAILED', 'capability is required', 400);
      }
      return reply.code(202).send({ job: await service.createJob(body) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.get<{ Params: { id: string } }>('/studio/jobs/:id', async (request, reply) => {
    try {
      return { job: await service.getJob(request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post<{ Params: { id: string } }>('/studio/jobs/:id/cancel', async (request, reply) => {
    try {
      return { job: await service.cancelJob(request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.delete<{ Params: { id: string } }>('/studio/jobs/:id', async (request, reply) => {
    try {
      await service.deleteJob(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.get<{ Params: { id: string } }>('/studio/jobs/:id/media', async (request, reply) => {
    try {
      const media = await service.media(request.params.id);
      return sendMedia(request, reply, media);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function sendMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  media: { path: string; mime: string; fileName: string; bytes: number }
) {
  reply
    .header('Content-Type', media.mime)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `inline; filename="${media.fileName.replace(/[^\w.-]/g, '_')}"`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range === null || (range[1] === '' && range[2] === '')) {
    return reply.header('Content-Length', String(media.bytes)).send(createReadStream(media.path));
  }
  let start = range[1] === '' ? Math.max(0, media.bytes - Number(range[2])) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? media.bytes - 1 : Math.min(Number(range[2]), media.bytes - 1);
  if (start >= media.bytes || start > end) {
    return reply.code(416).header('Content-Range', `bytes */${media.bytes}`).send();
  }
  start = Math.max(0, start);
  end = Math.min(end, media.bytes - 1);
  return reply
    .code(206)
    .header('Content-Range', `bytes ${start}-${end}/${media.bytes}`)
    .header('Content-Length', String(end - start + 1))
    .send(createReadStream(media.path, { start, end }));
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof StudioError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.message));
  }
  throw error;
}
