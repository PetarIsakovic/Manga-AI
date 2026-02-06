import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  buildVeoRequestBody,
  extractVideoUrl,
  isUnsupportedImageError,
  getUnsupportedField
} from '../veoUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '..', '.env'), override: true });

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '***';
  return `${key.slice(0, 3)}...${key.slice(-3)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ListModels failed (${response.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function pollOperation(apiKey, operationName, options = {}) {
  const maxPolls = Number.isInteger(options.maxPolls) ? options.maxPolls : 180;
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) ? options.pollIntervalMs : 5000;

  let url = `https://generativelanguage.googleapis.com/${operationName}?key=${apiKey}`;
  if (!operationName.startsWith('v')) {
    url = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
  }

  for (let i = 0; i < maxPolls; i += 1) {
    const response = await fetch(url, { method: 'GET' });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Poll failed (${response.status}): ${text}`);
    }
    const operation = JSON.parse(text);
    if (operation.done) {
      if (operation.error) {
        throw new Error(operation.error.message || JSON.stringify(operation.error));
      }
      return operation.response || operation.result || operation;
    }
    console.log(`Polling... ${i + 1}/${maxPolls}`);
    await sleep(pollIntervalMs);
  }

  throw new Error('Operation polling timed out');
}

async function runGenerate(apiKey, model, imagePath) {
  let imageData = null;
  let mimeType = null;

  if (imagePath) {
    const file = await fs.readFile(imagePath);
    imageData = file.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.webp') mimeType = 'image/webp';
    else mimeType = 'image/jpeg';
  }

  const countArg = getArgValue('--count');
  const numberOfVideos = Number.isInteger(parseInt(countArg, 10))
    ? parseInt(countArg, 10)
    : undefined;
  const personGeneration = process.env.VEO_PERSON_GENERATION && process.env.VEO_PERSON_GENERATION.trim()
    ? process.env.VEO_PERSON_GENERATION.trim()
    : undefined;

  const requestBody = buildVeoRequestBody({
    prompt: 'A calm, cinematic 8-second shot of clouds drifting over mountains.',
    imageData,
    mimeType,
    aspectRatio: '16:9',
    resolution: '720p',
    personGeneration,
    numberOfVideos,
    includeImage: Boolean(imagePath)
  });

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${apiKey}`;
  let response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  let text = await response.text();
  if (!response.ok) {
    const unsupportedField = getUnsupportedField(text);
    if (unsupportedField && requestBody.parameters?.[unsupportedField] !== undefined) {
      console.warn(`Field not supported: ${unsupportedField}. Retrying without it.`);
      delete requestBody.parameters[unsupportedField];
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      text = await response.text();
    }
  }

  if (!response.ok) {
    throw new Error(`Predict failed (${response.status}): ${text}`);
  }

  return JSON.parse(text);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = getArgValue('--model') || process.env.VEO_MODEL || 'veo-3.1-generate-preview';
  const imagePath = getArgValue('--image');
  const shouldGenerate = hasFlag('--generate');
  const dryRun = hasFlag('--dry-run');
  const shouldPoll = !hasFlag('--no-poll');

  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY in environment or .env.');
    process.exit(1);
  }

  console.log(`API key: ${maskKey(apiKey)}`);
  console.log(`Model: ${model}`);

  try {
    const models = await listModels(apiKey);
    const names = (models.models || []).map(m => m.name);
    const found = names.includes(`models/${model}`) || names.includes(model);
    console.log(`ListModels: ${names.length} models returned.`);
    console.log(`Model present: ${found ? 'yes' : 'no'}`);
  } catch (error) {
    console.error(`ListModels error: ${error.message}`);
  }

  if (!shouldGenerate) {
    console.log('Skipping generate call. Use --generate to run a predictLongRunning request.');
    if (!imagePath) {
      console.log('Tip: add --image /path/to/image.png to test image inputs.');
    }
    return;
  }

  if (dryRun) {
    console.log('Dry run requested. No request sent.');
    return;
  }

  try {
    const result = await runGenerate(apiKey, model, imagePath);
    if (result.name) {
      console.log(`Operation started: ${result.name}`);
      if (shouldPoll) {
        const finalResult = await pollOperation(apiKey, result.name);
        const videoUrl = extractVideoUrl(finalResult);
        if (videoUrl) {
          console.log(`Video URL: ${videoUrl}`);
        } else {
          console.log(`Final response: ${JSON.stringify(finalResult).slice(0, 600)}`);
        }
      } else {
        console.log('Polling skipped. Re-run without --no-poll to wait for completion.');
      }
    } else {
      console.log(`Response: ${JSON.stringify(result).slice(0, 400)}`);
    }
  } catch (error) {
    console.error(error.message);
    if (isUnsupportedImageError(error.message)) {
      console.error('Image inputs are not supported for this model in the Gemini API.');
      console.error('Use a Vertex AI image-to-video workflow or remove --image to test text-only.');
    }
    process.exit(1);
  }
}

main();
