import { describe, expect, it } from 'vitest';
import { parseEdgeTtsVtt } from '../../src/creator/course-video/edge-tts-vtt.js';

describe('edge-tts VTT parsing', () => {
  it('expands cues into caption words with cue-accurate boundaries', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.100 --> 00:00:01.300',
      'Hello world',
      '',
      '00:00:01.300 --> 00:00:03.000',
      'this is a caption test'
    ].join('\n');

    const words = parseEdgeTtsVtt(vtt);
    expect(words.map((word) => word.word)).toEqual(['Hello', 'world', 'this', 'is', 'a', 'caption', 'test']);
    expect(words[0]!.start).toBeCloseTo(0.1, 3);
    expect(words[words.length - 1]!.end).toBeCloseTo(3.0, 3);
    // Second cue starts exactly at the cue boundary.
    const secondCueFirst = words.find((word) => word.word === 'this')!;
    expect(secondCueFirst.start).toBeCloseTo(1.3, 3);
    // Words are ordered and contiguous within a cue.
    for (let index = 1; index < words.length; index += 1) {
      expect(words[index]!.start).toBeGreaterThanOrEqual(words[index - 1]!.end - 0.001);
    }
  });

  it('strips inline tags and ignores headers or empty input', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      '',
      '1',
      '00:00:00.000 --> 00:00:01.000',
      '<c.yellow>Tagged</c> text'
    ].join('\n');
    expect(parseEdgeTtsVtt(vtt).map((word) => word.word)).toEqual(['Tagged', 'text']);
    expect(parseEdgeTtsVtt('')).toEqual([]);
    expect(parseEdgeTtsVtt('WEBVTT\n')).toEqual([]);
  });
});
