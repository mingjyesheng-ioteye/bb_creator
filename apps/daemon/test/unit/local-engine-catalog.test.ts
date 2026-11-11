import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocModelDownloadedModels } from '../../src/creator-services/local-engine-catalog.js';

describe('LocModel local engine catalog', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    delete process.env.LOCMODEL_SETTINGS_FILE;
  });

  it('lists downloaded image and video models and filters components', async () => {
    root = await mkdtemp(join(tmpdir(), 'locmodel-catalog-'));
    const imageDir = join(root, 'image');
    await mkdir(join(imageDir, 'qwen-image-2.1'), { recursive: true });
    await mkdir(join(imageDir, 'wan2.2-ti2v-5b'), { recursive: true });
    await mkdir(join(imageDir, 'common'), { recursive: true });
    await writeFile(join(imageDir, 'qwen-image-2.1', 'qwen_image_2.1-Q8_0.gguf'), 'image');
    await writeFile(join(imageDir, 'wan2.2-ti2v-5b', 'Wan2.2-TI2V-5B-Q8_0.gguf'), 'video');
    await writeFile(join(imageDir, 'common', 'qwen_image_2.1_vae_bf16.safetensors'), 'vae');
    await writeFile(join(imageDir, 'common', 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'), 'encoder');
    const settings = join(root, 'settings.json');
    await writeFile(settings, JSON.stringify({ models_dir: root }));
    process.env.LOCMODEL_SETTINGS_FILE = settings;

    const models = await readLocModelDownloadedModels();

    expect(models.map(model => model.name)).toEqual([
      'Qwen-Image 2.1 Q8_0',
      'Wan2.2 TI2V 5B Q8_0'
    ]);
    expect(models[0]).toMatchObject({ kind: 'image', quantization: 'Q8_0' });
    expect(models[1]).toMatchObject({ kind: 'video', quantization: 'Q8_0' });
  });
});
