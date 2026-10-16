import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CourseLessonModule } from '@opencreator/protocol';
import type { CourseRenderRequest } from './render-contract.js';

type SlideMedia = { audio?: string; avatar?: string; broll?: string };

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  const resultPath = process.argv[3];
  if (!requestPath || !resultPath) throw new Error('course_render_worker_arguments_missing');
  try {
    const request = JSON.parse(await readFile(resolve(requestPath), 'utf8')) as CourseRenderRequest;
    const workdir = resolve(request.workdir);
    const jobRoot = resolve(request.jobRoot);
    const runtimeRoot = resolve(request.runtimeRoot);
    assertInside(workdir, request.outputPath, 'output');
    assertInside(workdir, requestPath, 'request');
    assertInside(workdir, resultPath, 'result');
    assertInside(runtimeRoot, request.bundlePath, 'bundle');
    assertInside(runtimeRoot, request.browserExecutable, 'browser');
    if (request.rendererEntry) assertInside(runtimeRoot, request.rendererEntry, 'renderer');
    if (!existsSync(resolve(request.bundlePath)) || !statSync(resolve(request.bundlePath)).isDirectory()) {
      throw new Error('course_render_worker_bundle_missing');
    }
    if (!existsSync(resolve(request.browserExecutable)) || !statSync(resolve(request.browserExecutable)).isFile()) {
      throw new Error('course_render_worker_browser_missing');
    }

    const lesson = JSON.parse(await readFile(resolve(request.lessonPath), 'utf8')) as CourseLessonModule;
    const media = collectMedia(lesson, jobRoot);

    const assetServer = await startAssetServer(resolve(request.bundlePath), media);
    try {
      const renderLesson: CourseLessonModule = {
        ...lesson,
        slides: lesson.slides.map((slide, index) => ({
          ...slide,
          ...(media[index]?.audio ? { audioSrc: `${assetServer.url}/media/${index}/audio${extname(media[index]!.audio!)}` } : {}),
          ...(media[index]?.avatar ? { avatarSrc: `${assetServer.url}/media/${index}/avatar${extname(media[index]!.avatar!)}` } : {}),
          ...(media[index]?.broll ? { brollSrc: `${assetServer.url}/media/${index}/broll${extname(media[index]!.broll!)}` } : {})
        }))
      };
      const renderer = await import(request.rendererEntry ? pathToFileURL(request.rendererEntry).href : '@remotion/renderer') as typeof import('@remotion/renderer');
      const inputProps = {
        ratio: request.ratio,
        fps: request.fps,
        width: request.width,
        height: request.height,
        lesson: renderLesson
      };
      const composition = await renderer.selectComposition({
        serveUrl: assetServer.url,
        id: 'CourseLessonLandscape',
        inputProps,
        browserExecutable: resolve(request.browserExecutable)
      });
      await renderer.renderMedia({
        composition: { ...composition, durationInFrames: request.totalFrames, fps: request.fps },
        serveUrl: assetServer.url,
        codec: 'h264',
        outputLocation: resolve(request.outputPath),
        inputProps,
        browserExecutable: resolve(request.browserExecutable),
        concurrency: 1
      });
    } finally {
      await assetServer.close();
    }
    await writeFile(resolve(resultPath), JSON.stringify({ ok: true }), 'utf8');
  } catch (error) {
    await writeFile(resolve(resultPath), JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }), 'utf8');
    process.exitCode = 1;
  }
}

function collectMedia(lesson: CourseLessonModule, jobRoot: string): SlideMedia[] {
  return lesson.slides.map((slide) => {
    const entry: SlideMedia = {};
    if (slide.audioSrc) entry.audio = inside(jobRoot, slide.audioSrc, 'audio');
    if (slide.avatarSrc) entry.avatar = inside(jobRoot, slide.avatarSrc, 'avatar');
    if (slide.brollSrc) entry.broll = inside(jobRoot, slide.brollSrc, 'broll');
    return entry;
  });
}

function inside(jobRoot: string, path: string, label: string): string {
  const resolved = resolve(path);
  assertInside(jobRoot, resolved, label);
  return resolved;
}

async function startAssetServer(
  bundleRoot: string,
  media: SlideMedia[]
): Promise<{ url: string; close(): Promise<void> }> {
  const files = new Map<string, string>();
  for (const [index, entry] of media.entries()) {
    if (entry.audio) files.set(`/media/${index}/audio${extname(entry.audio)}`, entry.audio);
    if (entry.avatar) files.set(`/media/${index}/avatar${extname(entry.avatar)}`, entry.avatar);
    if (entry.broll) files.set(`/media/${index}/broll${extname(entry.broll)}`, entry.broll);
  }
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const mediaPath = files.get(pathname);
      if (mediaPath !== undefined) {
        serveFile(request, response, mediaPath);
        return;
      }
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const bundlePath = resolve(bundleRoot, relativePath);
      const value = relative(bundleRoot, bundlePath);
      if (value.startsWith('..') || isAbsolute(value)) {
        respond(response, 403, 'Forbidden');
        return;
      }
      serveFile(request, response, bundlePath);
    } catch {
      respond(response, 400, 'Bad Request');
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error('course_render_worker_asset_server_failed');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    })
  };
}

function serveFile(request: IncomingMessage, response: ServerResponse, path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    respond(response, 404, 'Not Found');
    return;
  }
  const size = statSync(path).size;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const requestedEnd = range?.[2] ? Number(range[2]) : size - 1;
  const end = Math.min(size - 1, requestedEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': mimeType(path),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  });
  createReadStream(path, { start, end }).pipe(response);
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.woff2') return 'font/woff2';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.json') return 'application/json';
  return 'application/octet-stream';
}

function assertInside(root: string, child: string, label: string): void {
  const target = resolve(child);
  const value = relative(root, target);
  if (value.startsWith('..') || isAbsolute(value)) {
    throw new Error(`course_render_worker_${label}_path_escape`);
  }
}

void main();
