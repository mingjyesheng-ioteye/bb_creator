import type { CourseLessonCaptionWord } from '@opencreator/protocol';

const TIMING = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

/**
 * Parse the VTT that `edge-tts --write-subtitles` emits into caption words.
 *
 * The CLI emits one cue per short phrase, not per word, so each cue's words are
 * expanded with timing distributed across the cue proportional to word length.
 * Cue boundaries are exact; the within-cue split is an approximation (the same
 * fallback the reference engine used when a provider had no word timings).
 */
export function parseEdgeTtsVtt(vtt: string): CourseLessonCaptionWord[] {
  const words: CourseLessonCaptionWord[] = [];
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines[0]!.toUpperCase().startsWith('WEBVTT')) continue;

    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue;
    const match = TIMING.exec(lines[timingIndex]!);
    if (match === null) continue;

    const start = toSeconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = toSeconds(match[5]!, match[6]!, match[7]!, match[8]!);
    if (!(end > start)) continue;

    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]*>/g, ' ')
      .trim();
    if (!text) continue;

    words.push(...splitCue(text, start, end));
  }
  return words;
}

function splitCue(text: string, start: number, end: number): CourseLessonCaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const totalWeight = tokens.reduce((sum, token) => sum + Math.max(1, token.length), 0);
  const duration = end - start;
  const words: CourseLessonCaptionWord[] = [];
  let cursor = start;
  tokens.forEach((token, index) => {
    const last = index === tokens.length - 1;
    const share = last ? end - cursor : (duration * Math.max(1, token.length)) / totalWeight;
    const wordEnd = last ? end : cursor + share;
    words.push({ word: token, start: round(cursor), end: round(wordEnd) });
    cursor = wordEnd;
  });
  return words;
}

function toSeconds(hours: string, minutes: string, seconds: string, millis: string): number {
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis) / 1000
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
