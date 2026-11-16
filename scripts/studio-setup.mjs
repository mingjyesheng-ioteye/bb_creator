#!/usr/bin/env node
// Prepares the Studio's local tools inside bb_creator's own data directory:
//   <studio home>/venv    Python venv with piper-tts and faster-whisper
//   <studio home>/voices  Piper voices (.onnx + .onnx.json)
// Nothing here reads from any other project. Safe to run repeatedly.
//
//   node scripts/studio-setup.mjs [--voices voice1,voice2] [--skip-python] [--skip-voices]
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dataDir = resolve(process.env.OPENCREATOR_DATA_DIR ?? join(homedir(), '.opencreator', 'data'));
const home = resolve(process.env.OPENCREATOR_STUDIO_HOME ?? join(dataDir, 'studio'));
const voicesDir = resolve(process.env.OPENCREATOR_STUDIO_VOICES ?? join(home, 'voices'));
const venv = join(home, 'venv');
const voices = (option('--voices') ?? 'en_US-lessac-medium,en_US-amy-medium,en_GB-alan-medium,en_US-ryan-high')
  .split(',').map(value => value.trim()).filter(Boolean);

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Command failed: ${command}`);
    process.exit(result.status ?? 1);
  }
}

// Service managers (systemd, pm2) start with a minimal PATH that lacks ~/.local/bin.
const uv = [process.env.UV_BIN, 'uv', join(homedir(), '.local', 'bin', 'uv')]
  .filter(Boolean)
  .find(candidate => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);

function has(command) {
  return command === 'uv' ? uv !== undefined : spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function setupPython() {
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(venv, 'bin', 'python'))) {
    if (has('uv')) run(uv, ['venv', venv, '--python', '3.12']);
    else run('python3', ['-m', 'venv', venv]);
  }
  // faster-whisper needs a PyAV that still accepts `metadata_errors` (<17) and huggingface-hub 0.x.
  const packages = ['piper-tts', 'faster-whisper', 'huggingface-hub<1', 'av<17'];
  if (has('uv')) run(uv, ['pip', 'install', '--python', join(venv, 'bin', 'python'), ...packages]);
  else run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', ...packages]);
}

// Voice ids look like en_US-lessac-medium -> en/en_US/lessac/medium/en_US-lessac-medium.onnx
function voiceUrl(id, suffix) {
  const match = /^([a-z]{2})_([A-Z]{2})-(.+)-(x_low|low|medium|high)$/.exec(id);
  if (match === null) throw new Error(`Unrecognised Piper voice id: ${id}`);
  const [, language, region, name, quality] = match;
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${language}/${language}_${region}/${name}/${quality}/${id}${suffix}`;
}

async function download(url, destination) {
  if (existsSync(destination) && statSync(destination).size > 1024) return;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
  const partial = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, destination);
}

async function setupVoices() {
  mkdirSync(voicesDir, { recursive: true });
  for (const id of voices) {
    await download(voiceUrl(id, '.onnx.json'), join(voicesDir, `${id}.onnx.json`));
    await download(voiceUrl(id, '.onnx'), join(voicesDir, `${id}.onnx`));
  }
}

if (!flag('--skip-python')) setupPython();
if (!flag('--skip-voices')) await setupVoices();
console.log(`\nStudio is ready.\n  home:   ${home}\n  voices: ${voicesDir}`);
