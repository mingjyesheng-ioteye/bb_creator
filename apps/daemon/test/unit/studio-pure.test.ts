import { describe, expect, it } from 'vitest';
import {
  buildStillImage,
  buildWanImageToVideo,
  buildWanTextToVideo,
  missingWanFiles,
  wanFrames,
  wanSize
} from '../../src/studio/comfyui.js';
import { buildMotionComposition, buildWorldProject, deriveWorldSpec } from '../../src/studio/compositions.js';
import {
  burnSubtitlesArgs,
  crossfadeArgs,
  escapeFilterValue,
  gradeArgs,
  reframeCrop,
  trimArgs
} from '../../src/studio/ffmpeg.js';
import { buildSrt } from '../../src/studio/audio.js';
import { StudioValidationError, capabilityDefinitions, findCapability, resolveParams } from '../../src/studio/catalog.js';

describe('Wan graphs', () => {
  const common = { prompt: 'a fox', width: 832, height: 480, frames: 81, seed: 7, steps: 4, prefix: 'p' };

  it('snaps frame counts to 4n+1 and sizes to 16 px', () => {
    expect(wanFrames(80)).toBe(81);
    expect(wanFrames(49)).toBe(49);
    expect(wanSize('850x470')).toEqual([848, 464]);
    expect(wanSize('garbage')).toEqual([832, 480]);
  });

  it('wires every node reference to an existing node', () => {
    for (const graph of [buildWanTextToVideo(common), buildWanImageToVideo({ ...common, imageName: 'a.png' }), buildStillImage(common)]) {
      for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs)) {
          if (Array.isArray(value) && typeof value[0] === 'string') expect(graph[value[0]]).toBeDefined();
        }
      }
    }
  });

  it('splits the steps between the two Wan experts', () => {
    const graph = buildWanTextToVideo(common);
    expect(graph.sampleHigh!.inputs).toMatchObject({ start_at_step: 0, end_at_step: 2, add_noise: 'enable' });
    expect(graph.sampleLow!.inputs).toMatchObject({ start_at_step: 2, add_noise: 'disable' });
    expect(graph.latent!.inputs.length).toBe(81);
  });

  it('feeds the image conditioning outputs into the samplers', () => {
    const graph = buildWanImageToVideo({ ...common, imageName: 'a.png' });
    expect(graph.sampleHigh!.inputs.positive).toEqual(['conditioning', 0]);
    expect(graph.sampleHigh!.inputs.latent_image).toEqual(['conditioning', 2]);
  });

  it('reports the model files ComfyUI lacks', () => {
    expect(missingWanFiles({}, 'text')).toHaveLength(6);
    expect(missingWanFiles({ CLIPLoader: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'] }, 'image')).toHaveLength(5);
  });
});

describe('ffmpeg argument builders', () => {
  it('crops to the target aspect with even dimensions and honours the focus', () => {
    expect(reframeCrop({ width: 1920, height: 1080, aspect: 'portrait' })).toEqual({ width: 606, height: 1080, x: 657, y: 0 });
    expect(reframeCrop({ width: 1920, height: 1080, aspect: 'portrait', focusX: 0 }).x).toBe(0);
    expect(reframeCrop({ width: 1080, height: 1920, aspect: 'landscape' })).toMatchObject({ width: 1080, height: 606 });
  });

  it('trims with a duration rather than an absolute end', () => {
    const args = trimArgs({ source: 'in.mp4', output: 'out.mp4', start: 2, end: 5 });
    expect(args.slice(0, 4)).toEqual(['-ss', '2.000', '-i', 'in.mp4']);
    expect(args).toContain('3.000');
  });

  it('only blends when the grade intensity is below one', () => {
    expect(gradeArgs({ source: 'a', output: 'b', profile: 'neutral', intensity: 1 })).not.toContain('-filter_complex');
    expect(gradeArgs({ source: 'a', output: 'b', profile: 'neutral', intensity: 0.5 })).toContain('-filter_complex');
  });

  it('chains crossfades with cumulative offsets', () => {
    const args = crossfadeArgs({ clips: ['a', 'b', 'c'], durations: [3, 3, 3], output: 'o', fade: 0.5 });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('offset=2.500');
    expect(graph).toContain('offset=5.000');
    expect(crossfadeArgs({ clips: ['a'], durations: [3], output: 'o', fade: 0.5 })).toContain('copy');
  });

  it('escapes subtitle paths for the filter graph', () => {
    expect(escapeFilterValue("/tmp/a b/it's,x:y.srt")).toBe("/tmp/a b/it'\\\\\\''s\\,x\\:y.srt");
    expect(burnSubtitlesArgs({ source: 's', subtitles: '/t/c.srt', output: 'o' }).join(' ')).toContain("filename='/t/c.srt'");
  });
});

describe('captions', () => {
  it('groups words into timed cues', () => {
    const srt = buildSrt([{
      start: 0, end: 4, text: 'one two three four',
      words: [
        { start: 0, end: 0.5, word: 'one' }, { start: 0.5, end: 1, word: 'two' },
        { start: 1, end: 1.5, word: 'three' }, { start: 6, end: 6.5, word: 'four' }
      ]
    }], { maxChars: 12 });
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\none two');
    expect(srt).toContain('00:00:06,000 --> 00:00:06,500\nfour');
  });
});

describe('compositions', () => {
  it('escapes user text in the motion composition', () => {
    const html = buildMotionComposition({ text: '<script>alert(1)</script> & go', duration: 5, width: 1280, height: 720 })['index.html']!;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-duration="5"');
  });

  it('derives the same world from the same prompt and a different one from another', () => {
    const base = { seed: 42, duration: 8, width: 1280, height: 720 };
    const a = deriveWorldSpec({ prompt: 'misty highlands with pine forests and a distant observatory at sunrise', ...base });
    expect(a).toMatchObject({ landform: 'mountains', landmark: 'observatory', theme: 'dawn' });
    expect(deriveWorldSpec({ prompt: 'misty highlands with pine forests and a distant observatory at sunrise', ...base })).toEqual(a);
    expect(deriveWorldSpec({ prompt: 'desert dunes at night, tower', ...base })).toMatchObject({ landform: 'dunes', theme: 'night', landmark: 'tower' });
  });

  it('keeps prompt text from closing the embedded spec script', () => {
    const spec = deriveWorldSpec({ prompt: '</script><b>x', seed: 1, duration: 4, width: 640, height: 360 });
    const html = buildWorldProject(spec)['index.html']!;
    expect(html.match(/<\/script>/g)?.length).toBe(3);
    expect(html).toContain('hf-seek');
  });
});

describe('capability catalog', () => {
  it('has unique ids and a runner for each', () => {
    const ids = capabilityDefinitions.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['cinematic', 'minimax', 'motion', 'documentary', 'captions', 'narrate', 'upscale', 'course']));
  });

  it('applies defaults, rejects bad values and checks voices', () => {
    const grade = findCapability('grade')!;
    expect(resolveParams(grade, {}, [])).toEqual({ profile: 'cinematic_warm', intensity: 1 });
    expect(() => resolveParams(grade, { intensity: 3 }, [])).toThrow(StudioValidationError);
    expect(() => resolveParams(grade, { profile: 'nope' }, [])).toThrow(StudioValidationError);
    const narrate = findCapability('narrate')!;
    expect(resolveParams(narrate, { voice: 'a' }, ['a', 'b'])).toEqual({ voice: 'a' });
    expect(() => resolveParams(narrate, { voice: 'z' }, ['a', 'b'])).toThrow(/one of/);
    expect(resolveParams(findCapability('tighten')!, { start_seconds: '1' }, [])).toEqual({ start_seconds: 1 });
  });
});
