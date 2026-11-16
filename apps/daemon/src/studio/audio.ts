import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PIPER_VOICE, listPiperVoices, type StudioEnvironment } from './environment.js';
import { StudioUnavailableError, runCommand } from './process.js';

/** Offline neural narration with Piper; writes a WAV file. */
export async function synthesizeSpeech(input: {
  env: StudioEnvironment;
  text: string;
  voice?: string;
  output: string;
  signal: AbortSignal;
}): Promise<void> {
  if (input.env.piper === undefined) {
    throw new StudioUnavailableError('Piper is not installed. Run `pnpm studio:setup` to install it.');
  }
  const voices = listPiperVoices(input.env.voicesDir);
  const voice = input.voice?.trim() || DEFAULT_PIPER_VOICE;
  if (!voices.includes(voice)) {
    throw new StudioUnavailableError(
      voices.length === 0
        ? `No Piper voices are installed in ${input.env.voicesDir}. Run \`pnpm studio:setup\`.`
        : `Unknown voice "${voice}". Installed voices: ${voices.join(', ')}`
    );
  }
  const text = input.text.trim();
  if (text.length === 0) throw new Error('text is required');
  await runCommand(input.env.piper, [
    '--model', join(input.env.voicesDir, `${voice}.onnx`),
    '--output_file', input.output
  ], { signal: input.signal, stdin: `${text}\n`, timeoutMs: 15 * 60_000 });
}

export type TranscriptWord = { start: number; end: number; word: string };
export type TranscriptSegment = { start: number; end: number; text: string; words: TranscriptWord[] };
export type Transcript = { language: string; duration: number; segments: TranscriptSegment[] };

export async function transcribeMedia(input: {
  env: StudioEnvironment;
  source: string;
  output: string;
  modelSize: string;
  signal: AbortSignal;
  onLine?: (line: string) => void;
}): Promise<Transcript> {
  if (input.env.python === undefined) {
    throw new StudioUnavailableError('The Studio Python environment is missing. Run `pnpm studio:setup`.');
  }
  await runCommand(input.env.python, [
    input.env.transcribeScript, input.source, input.output, input.modelSize
  ], {
    signal: input.signal,
    timeoutMs: 60 * 60_000,
    ...(input.onLine === undefined ? {} : { onLine: input.onLine })
  });
  return JSON.parse(await readFile(input.output, 'utf8')) as Transcript;
}

/** Group word timings into readable caption cues (SRT). */
export function buildSrt(segments: TranscriptSegment[], options: { maxChars?: number; maxSeconds?: number } = {}): string {
  const maxChars = options.maxChars ?? 42;
  const maxSeconds = options.maxSeconds ?? 5;
  type Cue = { start: number; end: number; text: string };
  const cues: Cue[] = [];
  for (const segment of segments) {
    const words = segment.words.length > 0
      ? segment.words
      : [{ start: segment.start, end: segment.end, word: segment.text }];
    let cue: Cue | undefined;
    for (const word of words) {
      if (word.word.length === 0) continue;
      const joined = cue === undefined ? word.word : `${cue.text} ${word.word}`;
      if (cue !== undefined && (joined.length > maxChars || word.end - cue.start > maxSeconds)) {
        cues.push(cue);
        cue = undefined;
      }
      cue = cue === undefined
        ? { start: word.start, end: word.end, text: word.word }
        : { start: cue.start, end: word.end, text: `${cue.text} ${word.word}` };
    }
    if (cue !== undefined) cues.push(cue);
  }
  return `${cues.map((cue, index) => `${index + 1}\n${timecode(cue.start)} --> ${timecode(Math.max(cue.end, cue.start + 0.4))}\n${cue.text}\n`).join('\n')}`;
}

function timecode(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
