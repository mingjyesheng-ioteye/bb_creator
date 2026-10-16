import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CourseLessonCaptionWord, CourseLessonModule } from '@opencreator/protocol';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { validateMediaFile, type MediaProbe } from '../validators/media.js';
import { COURSE_VIDEO_FPS, COURSE_VIDEO_TAIL_PAD_SECONDS } from './constants.js';
import { parseEdgeTtsVtt } from './edge-tts-vtt.js';

export type SlideNarration = {
  path: string;
  durationSeconds: number;
  captions?: CourseLessonCaptionWord[];
};

export type SynthesizeSlide = (request: {
  text: string;
  voiceId: string;
  rate: string;
  index: number;
  workdir: string;
  signal: AbortSignal;
}) => Promise<SlideNarration>;

/**
 * Synthesizes narration for every slide of a planned lesson and writes a
 * `course-narrated-lesson` manifest: the lesson with `audioSrc`, optional
 * word-level `captions`, and `durationInFrames` filled in per slide.
 */
export function createCourseNarrationExecutor(input: { synthesizeSlide: SynthesizeSlide }): CreatorExecutor {
  return {
    id: 'course-narration',
    async run(stage) {
      const artifact = stage.inputArtifacts.find((candidate) => (
        candidate.kind === 'course-lesson' && candidate.status === 'completed'
      ));
      if (!artifact?.path) {
        throw new CreatorExecutorError('course_lesson_missing', 'The planned course lesson is required');
      }
      const lesson = JSON.parse(await readFile(artifact.path, 'utf8')) as CourseLessonModule;
      if (!Array.isArray(lesson.slides) || lesson.slides.length === 0) {
        throw new CreatorExecutorError('course_lesson_invalid', 'The course lesson has no slides');
      }

      const voiceId = readString(stage.job.state.voice) || 'en-US-AvaNeural';
      const rate = readString(stage.job.state.rate) || '-4%';
      const total = lesson.slides.length;
      const slides: CourseLessonModule['slides'] = [];

      for (let index = 0; index < total; index += 1) {
        const slide = lesson.slides[index]!;
        stage.reportProgress({
          phase: 'synthesizing',
          percent: Math.round((index / total) * 100),
          completed: index,
          failed: 0,
          total
        });
        const narration = await input.synthesizeSlide({
          text: slide.narration,
          voiceId,
          rate,
          index,
          workdir: stage.workdir,
          signal: stage.signal
        });
        if (!(narration.durationSeconds > 0)) {
          throw new CreatorExecutorError('course_audio_invalid', `Narration for slide ${slide.id} has no duration`);
        }
        slides.push({
          ...slide,
          audioSrc: narration.path,
          ...(narration.captions && narration.captions.length > 0 ? { captions: narration.captions } : {}),
          durationInFrames: Math.ceil((narration.durationSeconds + COURSE_VIDEO_TAIL_PAD_SECONDS) * COURSE_VIDEO_FPS)
        });
      }

      const narrated: CourseLessonModule = { ...lesson, slides };
      const path = join(stage.workdir, 'course-narrated-lesson.json');
      await writeFile(path, `${JSON.stringify(narrated, null, 2)}\n`);
      stage.reportProgress({ phase: 'completed', percent: 100, completed: total, failed: 0, total });
      return {
        outputs: [{
          kind: 'course-narrated-lesson',
          status: 'completed',
          path,
          sourceArtifactIds: [artifact.id],
          metadata: {
            slideCount: total,
            fps: COURSE_VIDEO_FPS,
            fileName: 'course-narrated-lesson.json',
            mimeType: 'application/json'
          }
        }]
      };
    }
  };
}

/**
 * Default narration synthesizer: the `edge-tts` CLI (no API key, local) plus
 * ffprobe for the exact slide duration. Word-level captions come from the VTT
 * that edge-tts writes alongside the audio (`--write-subtitles`).
 */
export function createEdgeTtsSlideSynthesizer(input: {
  ffprobePath: string;
  command?: string;
  probe?: (path: string, ffprobePath: string) => Promise<MediaProbe>;
}): SynthesizeSlide {
  const probe = input.probe ?? validateMediaFile;
  return async (request) => {
    const output = join(request.workdir, `slide-${String(request.index).padStart(2, '0')}.mp3`);
    const subtitles = output.replace(/\.mp3$/i, '.vtt');
    const command = input.command ?? process.env.OPENCREATOR_EDGE_TTS_COMMAND ?? 'edge-tts';
    try {
      await execFileAsync(command, [
        '--voice', request.voiceId,
        `--rate=${request.rate}`,
        '--text', request.text,
        '--write-media', output,
        '--write-subtitles', subtitles
      ], request.signal);
    } catch (error) {
      throw new CreatorExecutorError(
        'creator_tts_runtime_unavailable',
        `Edge TTS command failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const media = await probe(output, input.ffprobePath);
    if (!media.hasAudio || media.duration <= 0) {
      throw new CreatorExecutorError('course_audio_invalid', 'Edge TTS produced an invalid audio file');
    }
    let captions: CourseLessonCaptionWord[] | undefined;
    try {
      const parsed = parseEdgeTtsVtt(await readFile(subtitles, 'utf8'));
      if (parsed.length > 0) captions = parsed;
    } catch {
      captions = undefined;
    }
    return {
      path: output,
      durationSeconds: media.duration,
      ...(captions ? { captions } : {})
    };
  };
}

function execFileAsync(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, timeout: 120_000, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
