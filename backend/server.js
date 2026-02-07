import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  buildVeoRequestBody,
  extractVideoUrl,
  isUnsupportedImageError,
  getUnsupportedField
} from './veoUtils.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GoogleAuth } from 'google-auth-library';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env'), override: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-generate-preview';
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || 'veo-3.1-fast-generate-preview';
const VEO_PERSON_GENERATION = process.env.VEO_PERSON_GENERATION && process.env.VEO_PERSON_GENERATION.trim()
  ? process.env.VEO_PERSON_GENERATION.trim()
  : undefined;
const VEO_INCLUDE_IMAGE = process.env.VEO_INCLUDE_IMAGE !== 'false';
const VEO_PROVIDER = (process.env.VEO_PROVIDER || 'gemini').toLowerCase();
const VEO_REQUIRE_IMAGE = process.env.VEO_REQUIRE_IMAGE !== 'false';
const VEO_ALLOW_IMAGE_FALLBACK = process.env.VEO_ALLOW_IMAGE_FALLBACK === 'true';
const VEO_GEMINI_IMAGE_MODE = (process.env.VEO_GEMINI_IMAGE_MODE || 'reference').toLowerCase();
const VEO_USE_GEMINI3_PROMPT = process.env.VEO_USE_GEMINI3_PROMPT === 'true';
const VEO_DEBUG_PROMPT = process.env.VEO_DEBUG_PROMPT === 'true';
const GEMINI3_ANALYSIS_MODEL = process.env.GEMINI3_ANALYSIS_MODEL || 'gemini-3-flash-preview';
const GEMINI3_PROMPT_MODEL = process.env.GEMINI3_PROMPT_MODEL || GEMINI3_ANALYSIS_MODEL;
const GEMINI3_THINKING_LEVEL = process.env.GEMINI3_THINKING_LEVEL;
const VEO_MAX_CONCURRENT = Number.isInteger(parseInt(process.env.VEO_MAX_CONCURRENT, 10))
  ? parseInt(process.env.VEO_MAX_CONCURRENT, 10)
  : 1;
const VEO_NUMBER_OF_VIDEOS = Number.isInteger(parseInt(process.env.VEO_NUMBER_OF_VIDEOS, 10))
  ? parseInt(process.env.VEO_NUMBER_OF_VIDEOS, 10)
  : undefined;
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_MODEL = process.env.VERTEX_MODEL || VEO_MODEL;
const VERTEX_OUTPUT_GCS_URI = process.env.VERTEX_OUTPUT_GCS_URI;
const PORT = process.env.PORT || 3001;

const ANIMATION_PROMPT = `You are an anime motion director. Animate this manga page into an 8-second MP4 that feels like a high-quality anime adaptation of the SAME page.

Rules:
- Match the original manga art style exactly. Preserve line art, proportions, faces, outfits, and panel layout. No restyling or redesign.
- Animate every character/subject in every panel. If a character appears in multiple panels, animate each instance separately.
- Motion should feel anime-like and action-driven: strong limb motion, pose shifts, expressive gestures, hair/cloth movement, and clear action beats implied by the panel. Keep it readable and faithful to the original art.
- Text & props are sacred: do NOT alter, warp, erase, or replace any text, bubbles, SFX, or props (e.g., chainsaws/weapons). Keep them perfectly static and intact.
- Colors must stay exactly as the source (no desaturation or B/W conversion).
- Page integrity: treat the page as a fixed canvas. No page drift, no scaling, no rotation. Panel borders and gutters are fixed and aligned.
- Panel integrity: each panel is a HARD MASK. Content must stay inside its own panel and never cross borders or leak into another panel.
- Do NOT scroll, crop, reveal, or invent any new parts of the page. Do NOT extend the canvas or generate off-page content. Preserve margins, borders, watermarks, and printing artifacts exactly.
- Camera: ABSOLUTELY LOCKED. Zero zoom, pan, tilt, parallax, or scrolling. Full page always in frame.

Output: MP4 only. 8s, 24fps, resolution and aspect ratio as specified. No audio.`;

let veoCooldownUntil = 0;

function setVeoCooldown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  veoCooldownUntil = Math.max(veoCooldownUntil, Date.now() + ms);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskKey(key) {
  if (!key) return 'missing';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

const vertexAuth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

async function getAccessToken() {
  const client = await vertexAuth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to obtain Vertex AI access token');
  }
  return token;
}

function getVertexModelPath() {
  if (!GOOGLE_CLOUD_PROJECT) return null;
  return `projects/${GOOGLE_CLOUD_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}`;
}

function getVertexEndpoint(method) {
  const modelPath = getVertexModelPath();
  if (!modelPath) return null;
  return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/${modelPath}:${method}`;
}

function parseGcsUri(uri) {
  if (!uri || !uri.startsWith('gs://')) return null;
  const withoutScheme = uri.slice(5);
  const [bucket, ...rest] = withoutScheme.split('/');
  const prefix = rest.join('/');
  return { bucket, prefix };
}

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function buildDownloadUrl(req, videoUrl) {
  if (!videoUrl) return null;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const encoded = encodeURIComponent(videoUrl);
  return `${baseUrl}/api/veo/download?url=${encoded}`;
}

function extractGeminiText(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => part?.text).filter(Boolean).join('\n').trim();
}

async function generateGeminiContent({ model, contents, generationConfig }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents,
    ...(generationConfig ? { generationConfig } : {})
  };
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const result = response.json();
  if (result.error) {
    throw new Error(result.error.message || 'Gemini generateContent error');
  }
  return { result, text: extractGeminiText(result) };
}

async function buildPromptFromImage({ imageData, mimeType }) {
  if (!VEO_USE_GEMINI3_PROMPT) {
    return ANIMATION_PROMPT;
  }
  if (!imageData || !mimeType) {
    return ANIMATION_PROMPT;
  }

  const analysisPrompt = [
    'Analyze this manga page for animation.',
    'Return a concise, factual summary focused on: characters, setting, actions, emotions, camera/framing, text notes, and any implied motion/effects.',
    'Do not invent details that are not visible.'
  ].join(' ');

  const analysisContents = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType,
            data: imageData
          }
        },
        { text: analysisPrompt }
      ]
    }
  ];

  const analysisConfig = GEMINI3_THINKING_LEVEL
    ? { thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL } }
    : undefined;

  const analysis = await generateGeminiContent({
    model: GEMINI3_ANALYSIS_MODEL,
    contents: analysisContents,
    generationConfig: analysisConfig
  });

  const promptBuilderInstruction = [
    'You are writing a single prompt for a video generation model.',
    'Use the analysis below to tailor the prompt to this exact manga page.',
    'Keep the prompt concise and specific to visible details.',
    'Follow these strict animation constraints:',
    ANIMATION_PROMPT,
    'Return only the final prompt text (no bullets, no JSON).',
    'Analysis:',
    analysis.text || '(no analysis)'
  ].join('\n');

  const promptContents = [
    {
      role: 'user',
      parts: [{ text: promptBuilderInstruction }]
    }
  ];

  const promptConfig = GEMINI3_THINKING_LEVEL
    ? { thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL } }
    : undefined;

  const promptResult = await generateGeminiContent({
    model: GEMINI3_PROMPT_MODEL,
    contents: promptContents,
    generationConfig: promptConfig
  });

  return promptResult.text || ANIMATION_PROMPT;
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        console.log(`Rate limited, waiting ${waitTime}ms...`);
        setVeoCooldown(waitTime);
        lastError = new Error('API error 429: Rate limited');
        await sleep(waitTime);
        continue;
      }
      const responseText = await response.text();
      if (!response.ok) {
        console.error(`❌ API error ${response.status}`);
        console.error(`❌ Response body:`, responseText.substring(0, 800));
        throw new Error(`API error ${response.status}: ${responseText.substring(0, 200)}`);
      }
      try {
        return {
          ok: response.ok,
          status: response.status,
          json: () => JSON.parse(responseText),
          text: () => responseText
        };
      } catch (parseError) {
        throw new Error('Invalid JSON response from API');
      }
    } catch (error) {
      const message = error?.message || String(error);
      lastError = error;
      if (attempt < maxRetries - 1 && !message.includes('400') && !message.includes('401') && !message.includes('403')) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await sleep(waitTime);
      } else {
        break;
      }
    }
  }
  throw lastError || new Error('API error: Unknown failure');
}

async function pollOperation(operationName) {
  const maxPolls = 180;
  const pollInterval = 5000;
  let url = `https://generativelanguage.googleapis.com/${operationName}?key=${GEMINI_API_KEY}`;
  if (!operationName.startsWith('v')) {
    url = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${GEMINI_API_KEY}`;
  }

  console.log(`⏳ Polling URL: ${url.replace(GEMINI_API_KEY, 'KEY')}`);

  for (let i = 0; i < maxPolls; i++) {
    const response = await fetchWithRetry(url, { method: 'GET' });
    const operation = response.json();
    if (operation.done) {
      if (operation.error) throw new Error(operation.error.message || 'Video gen failed');
      return operation.response;
    }
    console.log(`⏳ Polling... ${i + 1}/${maxPolls}`);
    await sleep(pollInterval);
  }
  throw new Error('Video generation timed out');
}

async function pollVertexOperation(operationName) {
  const url = getVertexEndpoint('fetchPredictOperation');
  if (!url) throw new Error('Vertex AI is not configured');
  const maxPolls = 180;
  const pollInterval = 5000;

  for (let i = 0; i < maxPolls; i += 1) {
    const token = await getAccessToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ operationName })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Vertex poll error ${response.status}: ${text.substring(0, 200)}`);
    }

    const operation = JSON.parse(text);
    if (operation.done) {
      if (operation.error) throw new Error(operation.error.message || 'Vertex video gen failed');
      return operation.response || operation.result || operation;
    }

    console.log(`⏳ Vertex polling... ${i + 1}/${maxPolls}`);
    await sleep(pollInterval);
  }

  throw new Error('Vertex video generation timed out');
}

let veoInFlight = 0;
const veoQueue = [];

async function waitForVeoCooldown() {
  if (veoCooldownUntil <= Date.now()) return;
  const waitMs = veoCooldownUntil - Date.now();
  console.log(`⏸️ Veo cooldown active, waiting ${waitMs}ms`);
  await sleep(waitMs);
}

async function acquireVeoSlot() {
  if (VEO_MAX_CONCURRENT < 1) return;
  await waitForVeoCooldown();
  if (veoInFlight < VEO_MAX_CONCURRENT) {
    veoInFlight += 1;
    return;
  }
  await new Promise(resolve => veoQueue.push(resolve));
  await waitForVeoCooldown();
  veoInFlight += 1;
}

function releaseVeoSlot() {
  if (VEO_MAX_CONCURRENT < 1) return;
  veoInFlight = Math.max(0, veoInFlight - 1);
  if (veoQueue.length > 0 && veoInFlight < VEO_MAX_CONCURRENT) {
    const next = veoQueue.shift();
    next();
  }
}

app.post('/api/veo', async (req, res) => {
  console.log('\n🎬 === VEO VIDEO GENERATION REQUEST ===');

  const { imageBase64, mimeType, aspectRatio, model, resolution } = req.body;

  if (VEO_REQUIRE_IMAGE && !VEO_INCLUDE_IMAGE) {
    return res.status(400).json({ error: 'VEO_INCLUDE_IMAGE must be true when VEO_REQUIRE_IMAGE is enabled.' });
  }

  if (VEO_INCLUDE_IMAGE && (!imageBase64 || !mimeType)) {
    return res.status(400).json({ error: 'Missing imageBase64 or mimeType' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const queuedAt = Date.now();
  await acquireVeoSlot();
  const waitedMs = Date.now() - queuedAt;
  if (waitedMs > 0) {
    console.log(`⏳ Request queued ${waitedMs}ms`);
  }

  try {
    const selectedModel = model === 'fast' ? VEO_MODEL_FAST : VEO_MODEL;
    const modelId = selectedModel.startsWith('models/') ? selectedModel.split('/')[1] : selectedModel;

    const imageData = imageBase64
      ? (imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64)
      : null;
    const effectiveMimeType = mimeType || 'image/jpeg';
    const animationPrompt = await buildPromptFromImage({
      imageData,
      mimeType: effectiveMimeType
    });
    if (VEO_DEBUG_PROMPT) {
      console.log('🧠 Gemini3 prompt:\n', animationPrompt);
    }

    if (VEO_PROVIDER === 'vertex') {
      if (!GOOGLE_CLOUD_PROJECT) {
        throw new Error('GOOGLE_CLOUD_PROJECT not configured for Vertex AI');
      }
      if (!VERTEX_OUTPUT_GCS_URI) {
        throw new Error('VERTEX_OUTPUT_GCS_URI not configured for Vertex AI');
      }
      if (VEO_INCLUDE_IMAGE && (!imageData || !effectiveMimeType)) {
        throw new Error('Missing image data for Vertex AI request');
      }

      const gcs = parseGcsUri(VERTEX_OUTPUT_GCS_URI);
      if (!gcs?.bucket) {
        throw new Error(`Invalid VERTEX_OUTPUT_GCS_URI: ${VERTEX_OUTPUT_GCS_URI}`);
      }

      const prefix = normalizePrefix(gcs.prefix);
      const basePrefix = prefix ? `${prefix}/` : '';
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const storageUri = `gs://${gcs.bucket}/${basePrefix}outputs/veo-${requestId}`;
      const vertexUrl = getVertexEndpoint('predictLongRunning');
      if (!vertexUrl) {
        throw new Error('Vertex AI endpoint not configured');
      }

      const instance = { prompt: animationPrompt };
      if (VEO_INCLUDE_IMAGE && imageData) {
        const ext = effectiveMimeType === 'image/png'
          ? 'png'
          : effectiveMimeType === 'image/webp'
            ? 'webp'
            : 'jpg';
        const objectPath = `${basePrefix}inputs/${requestId}.${ext}`;
        const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${gcs.bucket}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
        const token = await getAccessToken();
        const uploadResp = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': effectiveMimeType
          },
          body: Buffer.from(imageData, 'base64')
        });
        const uploadText = await uploadResp.text();
        if (!uploadResp.ok) {
          throw new Error(`GCS upload error ${uploadResp.status}: ${uploadText.substring(0, 200)}`);
        }
        instance.image = {
          gcsUri: `gs://${gcs.bucket}/${objectPath}`,
          mimeType: effectiveMimeType
        };
      }

      const parameters = {
        storageUri,
        sampleCount: 1,
        durationSeconds: 8,
        ...(aspectRatio ? { aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9' } : {}),
        ...(resolution ? { resolution } : {})
      };

      const vertexBody = {
        instances: [instance],
        parameters
      };

      console.log(`📤 Vertex model: ${VERTEX_MODEL}`);
      console.log(`📤 Vertex call: ${vertexUrl}`);

      const token = await getAccessToken();
      const vertexResp = await fetch(vertexUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(vertexBody)
      });

      const vertexText = await vertexResp.text();
      if (!vertexResp.ok) {
        throw new Error(`Vertex API error ${vertexResp.status}: ${vertexText.substring(0, 200)}`);
      }

      const vertexResult = JSON.parse(vertexText);
      if (vertexResult.error) {
        console.error('❌ Vertex API Error:', JSON.stringify(vertexResult.error, null, 2));
        throw new Error(vertexResult.error.message);
      }

      if (vertexResult.name) {
        console.log(`⏳ Vertex operation started: ${vertexResult.name}`);
        const result = await pollVertexOperation(vertexResult.name);
        const videoUrl = extractVideoUrl(result);
        if (videoUrl) {
          const downloadUrl = buildDownloadUrl(req, videoUrl);
          console.log('✅ VIDEO READY:', videoUrl);
          return res.json({
            videoUrl,
            downloadUrl,
            status: 'ready',
            resolution,
            ...(VEO_DEBUG_PROMPT ? { prompt: animationPrompt } : {})
          });
        }
        const preview = JSON.stringify(result).slice(0, 1200);
        console.error('❌ Vertex response missing output URI:', preview);
        throw new Error('Vertex video generation completed but output URI not found');
      }

      throw new Error(`Unexpected Vertex response: ${vertexText.substring(0, 300)}`);
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning?key=${GEMINI_API_KEY}`;

    console.log(`📤 Model: ${modelId}`);
    console.log(`📤 Calling: ${apiUrl.replace(GEMINI_API_KEY, 'KEY')}`);

    const buildRequestBody = (imageMode) => buildVeoRequestBody({
      prompt: animationPrompt,
      imageData,
      mimeType: effectiveMimeType,
      aspectRatio,
      resolution,
      personGeneration: VEO_PERSON_GENERATION,
      numberOfVideos: VEO_NUMBER_OF_VIDEOS,
      includeImage: VEO_INCLUDE_IMAGE,
      imageMode
    });

    let imageMode = VEO_GEMINI_IMAGE_MODE;
    let requestBody = buildRequestBody(imageMode);
    let triedAlternateImageMode = false;

    let generateResponse;
    try {
      generateResponse = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const message = error?.message || String(error);
      const unsupportedField = getUnsupportedField(message);
      if (unsupportedField === 'referenceImages') {
        if (VEO_REQUIRE_IMAGE) {
          if (imageMode === 'reference' && !triedAlternateImageMode) {
            triedAlternateImageMode = true;
            imageMode = 'first_frame';
            requestBody = buildRequestBody(imageMode);
            console.warn('⚠️ referenceImages not supported. Retrying with first_frame image mode.');
            generateResponse = await fetchWithRetry(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(requestBody)
            });
          } else {
            throw new Error('referenceImages is not supported by this model. Try VEO_GEMINI_IMAGE_MODE=first_frame.');
          }
        } else {
          console.warn(`⚠️ Field not supported by model: ${unsupportedField}. Retrying without it.`);
          delete requestBody.parameters.referenceImages;
          generateResponse = await fetchWithRetry(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
        }
      } else if (unsupportedField === 'personGeneration') {
        console.warn('⚠️ personGeneration not supported. Retrying without it.');
        if (requestBody.parameters?.personGeneration !== undefined) {
          delete requestBody.parameters.personGeneration;
        }
        generateResponse = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
      } else if (unsupportedField && requestBody.parameters?.[unsupportedField] !== undefined) {
        console.warn(`⚠️ Field not supported by model: ${unsupportedField}. Retrying without it.`);
        delete requestBody.parameters[unsupportedField];
        generateResponse = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
      } else if (isUnsupportedImageError(message) &&
        (requestBody.instances?.[0]?.image || requestBody.parameters?.referenceImages?.length)) {
        if (VEO_REQUIRE_IMAGE) {
          if (!triedAlternateImageMode) {
            triedAlternateImageMode = true;
            imageMode = imageMode === 'reference' ? 'first_frame' : 'reference';
            requestBody = buildRequestBody(imageMode);
            console.warn(`⚠️ Image payload rejected. Retrying with image mode: ${imageMode}.`);
            generateResponse = await fetchWithRetry(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(requestBody)
            });
          } else {
            throw new Error('Image inputs are required but the Gemini API rejected both image modes.');
          }
        } else if (!VEO_ALLOW_IMAGE_FALLBACK) {
          throw new Error('Image inputs are required but the Gemini API rejected the image payload.');
        } else {
          console.warn('⚠️ Image inputs not supported by model. Retrying without image.');
          if (requestBody.instances?.[0]?.image) delete requestBody.instances[0].image;
          if (requestBody.parameters?.referenceImages) delete requestBody.parameters.referenceImages;
          generateResponse = await fetchWithRetry(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
        }
      } else {
        throw error;
      }
    }

    const generateResult = generateResponse.json();

    if (generateResult.error) {
      console.error('❌ API Error:', JSON.stringify(generateResult.error, null, 2));
      throw new Error(generateResult.error.message);
    }

    if (generateResult.name) {
      console.log(`⏳ Operation started: ${generateResult.name}`);
      const result = await pollOperation(generateResult.name);
      const videoUrl = extractVideoUrl(result);
      if (videoUrl) {
        const downloadUrl = buildDownloadUrl(req, videoUrl);
        console.log('✅ VIDEO READY:', videoUrl);
        return res.json({
          videoUrl,
          downloadUrl,
          status: 'ready',
          resolution,
          ...(VEO_DEBUG_PROMPT ? { prompt: animationPrompt } : {})
        });
      }
      throw new Error('Video generation completed but output URI not found');
    }

    throw new Error(`Unexpected response format: ${JSON.stringify(generateResult).substring(0, 300)}`);
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('429')) {
      return res.status(429).json({
        error: message,
        details: 'Rate limit reached. Please wait and retry.',
        status: 'rate_limited'
      });
    }
    if (isUnsupportedImageError(message)) {
      console.error('❌ Final error:', message);
      return res.status(400).json({
        error: 'This Veo model does not accept image inputs via the Gemini API.',
        details: 'Try VEO_GEMINI_IMAGE_MODE=reference or first_frame. If both fail, use Vertex or Gemini Files API.',
        status: 'failed'
      });
    }

    console.error('❌ Final error:', message);
    return res.status(500).json({ error: message, details: 'API call failed. Check server logs.', status: 'failed' });
  } finally {
    releaseVeoSlot();
  }
});

app.get('/api/veo/download', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const urlParam = req.query.url;
  if (!urlParam || typeof urlParam !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  if (urlParam.startsWith('gs://')) {
    const match = urlParam.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid GCS URI' });
    }
    const [, bucket, objectPath] = match;
    try {
      const token = await getAccessToken();
      const encodedObject = encodeURIComponent(objectPath);
      const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedObject}?alt=media`;
      const upstream = await fetch(gcsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        return res.status(upstream.status).send(text);
      }

      const contentType = upstream.headers.get('content-type');
      const contentLength = upstream.headers.get('content-length');
      const contentDisposition = upstream.headers.get('content-disposition');
      if (contentType) res.setHeader('Content-Type', contentType);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

      if (!upstream.body) {
        return res.status(502).json({ error: 'Upstream response had no body' });
      }

      const bodyStream = Readable.fromWeb(upstream.body);
      await pipeline(bodyStream, res);
      return;
    } catch (error) {
      const message = error?.message || String(error);
      return res.status(500).json({ error: message });
    }
  }

  let target;
  try {
    target = new URL(urlParam);
  } catch {
    return res.status(400).json({ error: 'Invalid url parameter' });
  }

  if (target.protocol !== 'https:' || target.hostname !== 'generativelanguage.googleapis.com') {
    return res.status(400).json({ error: 'Unsupported download host' });
  }

  if (!target.pathname.startsWith('/v1beta/files/')) {
    return res.status(400).json({ error: 'Unsupported download path' });
  }

  target.searchParams.set('key', GEMINI_API_KEY);

  try {
    const upstream = await fetch(target.toString(), { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }

    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');
    const contentDisposition = upstream.headers.get('content-disposition');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    if (!upstream.body) {
      return res.status(502).json({ error: 'Upstream response had no body' });
    }

    const bodyStream = Readable.fromWeb(upstream.body);
    await pipeline(bodyStream, res);
  } catch (error) {
    const message = error?.message || String(error);
    return res.status(500).json({ error: message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    apiKey: maskKey(GEMINI_API_KEY),
    project: GOOGLE_CLOUD_PROJECT || 'not_set',
    includeImage: VEO_INCLUDE_IMAGE,
    requireImage: VEO_REQUIRE_IMAGE,
    maxConcurrent: VEO_MAX_CONCURRENT,
    provider: VEO_PROVIDER,
    gemini3Prompt: VEO_USE_GEMINI3_PROMPT,
    debugPrompt: VEO_DEBUG_PROMPT,
    gemini3AnalysisModel: GEMINI3_ANALYSIS_MODEL,
    gemini3PromptModel: GEMINI3_PROMPT_MODEL,
    vertexLocation: VERTEX_LOCATION,
    vertexModel: VERTEX_MODEL,
    vertexOutputGcs: VERTEX_OUTPUT_GCS_URI ? 'set' : 'not_set'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🎬 Target Veo model: ${VEO_MODEL}`);
  console.log(`🔑 API key configured: ${!!GEMINI_API_KEY}`);
  console.log(`🔑 API key: ${maskKey(GEMINI_API_KEY)}`);
  console.log(`🧾 Project: ${GOOGLE_CLOUD_PROJECT || 'not_set'}`);
  console.log(`🧭 Provider: ${VEO_PROVIDER}`);
  console.log(`🗺️ Vertex location: ${VERTEX_LOCATION}`);
  console.log(`🗄️ Vertex output: ${VERTEX_OUTPUT_GCS_URI ? 'set' : 'not_set'}`);
});
