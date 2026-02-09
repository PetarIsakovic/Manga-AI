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
const VEO_GEMINI_IMAGE_MODE = (process.env.VEO_GEMINI_IMAGE_MODE || 'first_frame').toLowerCase();
const VEO_USE_GEMINI3_PROMPT = process.env.VEO_USE_GEMINI3_PROMPT === 'true';
const VEO_DEBUG_PROMPT = process.env.VEO_DEBUG_PROMPT === 'true';
const VEO_DURATION_SECONDS = Number.isInteger(parseInt(process.env.VEO_DURATION_SECONDS, 10))
  ? Math.max(1, Math.min(8, parseInt(process.env.VEO_DURATION_SECONDS, 10)))
  : 4;
const GEMINI3_ANALYSIS_MODEL = process.env.GEMINI3_ANALYSIS_MODEL || 'gemini-3-flash-preview';
const GEMINI3_PROMPT_MODEL = process.env.GEMINI3_PROMPT_MODEL || GEMINI3_ANALYSIS_MODEL;
const GEMINI3_THINKING_LEVEL = process.env.GEMINI3_THINKING_LEVEL;
const VEO_MAX_CONCURRENT = Number.isInteger(parseInt(process.env.VEO_MAX_CONCURRENT, 10))
  ? parseInt(process.env.VEO_MAX_CONCURRENT, 10)
  : 1;
const VEO_MINIMAL_PROMPT = process.env.VEO_MINIMAL_PROMPT !== 'false';
const VEO_NUMBER_OF_VIDEOS = Number.isInteger(parseInt(process.env.VEO_NUMBER_OF_VIDEOS, 10))
  ? parseInt(process.env.VEO_NUMBER_OF_VIDEOS, 10)
  : undefined;
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_MODEL = process.env.VERTEX_MODEL || VEO_MODEL;
const VERTEX_OUTPUT_GCS_URI = process.env.VERTEX_OUTPUT_GCS_URI;
const PORT = process.env.PORT || 3001;

const BASE_CONSTRAINTS_TEXT = [
  'Animation Mode: HIGH IMPACT CINEMATIC.',
  'Input Image Policy: The video must start with the exact provided image (Frame 0).',
  'Output: A high-frame-rate, fluid video that evolves immediately from the start frame.',
  'Do not treat the image as just a style reference; it is the starting point of the animation.'
].join(' ');

const STYLE_PRESERVATION_TEXT = [
  'CRITICAL: ARTWORK CONSISTENCY.',
  'You represent an animator manipulating the original ink lines, NOT a new artist redrawing the scene.',
  'Preserve the exact character designs, facial features, and hatching style of Frame 0.',
  'Do not introduce new rendering styles, shading, or 3D effects.',
  'Maintain the original "hand-drawn" look throughout the video.',
  'Ensure character identity remains identical to the input image.'
].join(' ');

const PANEL_LOCK_TEXT = [
  'Treat panel borders as windows looking into active scenes.',
  'Inside every panel, there must be intense, continuous movement.'
].join(' ');

const FORBIDDEN_CHANGES_TEXT = [
  'ABSULUTELY FORBIDDEN: Changing character faces, hairstyles, or outfits.',
  'No changing of panel layouts or border thickness.',
  'No "morphing" into different people.',
  'No shifting the camera angle or perspective (preserve the original composition).'
].join(' ');

const VIDEO_SETTINGS_TEXT = [
  `Duration: ${VEO_DURATION_SECONDS} seconds.`,
  'MOTION STRATEGY: "WARP & FLOW" (High Energy).',
  '1. START: Frame 0 is the fixed anchor.',
  '2. HAIR/CLOTHES: Animate with high-frequency wavering/rippling (like strong wind). Keep the general silhouette but displace the texture.',
  '3. CHARACTERS: Use "breathing" expansion/contraction and rhythmic swaying. Do not rotate heads significantly if it distort features.',
  '4. ENVIRONMENT: Animate flying rocks, debris, leaves, particles, and dust. These elements must have distinct flight paths (flying past characters or across the view), not just vibration.',
  '5. BACKGROUND: Texture drift (speed lines, clouds) must be constant and fast.',
  '6. CROWDS: Small independent motions for background figures.',
  'High motion is required. Make the environment feel chaotic and active.'
].join(' ');

const ANIMATION_PROMPT = `BASE CONSTRAINTS:\n${BASE_CONSTRAINTS_TEXT}\n\nSTYLE & ART PRESERVATION:\n${STYLE_PRESERVATION_TEXT}\n\nPANEL LOCK:\n${PANEL_LOCK_TEXT}\n\nFORBIDDEN CHANGES:\n${FORBIDDEN_CHANGES_TEXT}\n\nVIDEO SETTINGS:\n${VIDEO_SETTINGS_TEXT}`;

let veoCooldownUntil = 0;

function setVeoCooldown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  veoCooldownUntil = Math.max(veoCooldownUntil, Date.now() + ms);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepWithCancel(ms, shouldCancel) {
  const step = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Request canceled by client');
    }
    const wait = Math.min(step, ms - elapsed);
    await sleep(wait);
    elapsed += wait;
  }
}

function maskKey(key) {
  if (!key) return 'missing';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function stableSeedFromString(input = '') {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const seed = (hash >>> 0) % 2147483647;
  return seed === 0 ? 1 : seed;
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

function getRaiFilterInfo(result) {
  if (!result || typeof result !== 'object') return null;
  const count =
    result.raiMediaFilteredCount ??
    result.generateVideoResponse?.raiMediaFilteredCount ??
    result.predictions?.[0]?.raiMediaFilteredCount ??
    null;
  const reasons =
    result.raiMediaFilteredReasons ??
    result.generateVideoResponse?.raiMediaFilteredReasons ??
    result.predictions?.[0]?.raiMediaFilteredReasons ??
    null;
  if ((typeof count === 'number' && count > 0) || (Array.isArray(reasons) && reasons.length > 0)) {
    return { count: typeof count === 'number' ? count : reasons?.length || 1, reasons: reasons || [] };
  }
  return null;
}

function sanitizePrompt(text = '') {
  let output = text;
  const replacements = [
    // Neutralize brand/IP and sensitive descriptors
    [/chainsaw\s*man/gi, 'illustrated character'],
    [/denji|kishibe|quanxi|pochita|poccontacta/gi, 'character'],
    [/\bchild(?:ren)?\b/gi, 'person'],
    [/\bkid(?:s)?\b/gi, 'person'],
    [/\bteen(?:ager|s)?\b/gi, 'person'],
    [/\bminor(?:s)?\b/gi, 'person'],
    [/\byouth(?:s)?\b/gi, 'person'],
    [/\byoung\b/gi, ''],
    [/\bboy(?:s)?\b/gi, 'person'],
    [/\bgirl(?:s)?\b/gi, 'person'],
    [/\bman\b/gi, 'person'],
    [/\bwoman\b/gi, 'person'],
    [/\bolder\b/gi, ''],
    [/chainsaw/gi, 'mechanical tool'],
    [/chain\s*saw/gi, 'mechanical tool'],
    [/blade(s)?/gi, 'edge'],
    [/\bsaw\b/gi, 'tool'],
    [/serrated/gi, 'mechanical'],
    [/jagged/gi, 'angular'],
    [/spiked?|spiky/gi, 'angular'],
    [/\blip(?:s)?\b/gi, 'face'],
    [/\bmouth(?:s)?\b/gi, 'face'],
    [/\btongue\b/gi, 'detail'],
    // Violence / harm terms
    [/kill(?:ing|ed|s|er)?/gi, ''],
    [/murder(?:ed|ing|er)?/gi, ''],
    [/death|dead|dying|die/gi, ''],
    [/corpse|guts?|viscera/gi, ''],
    [/blood(?:y)?/gi, ''],
    [/bleed(?:ing)?/gi, ''],
    [/gore|gory/gi, ''],
    [/wound(?:ed|s)?/gi, ''],
    [/injur(?:e|ed|y|ies)/gi, ''],
    [/hurt(?:ing)?/gi, ''],
    [/pain(?:ful|fully)?|agony|suffer(?:ing)?/gi, ''],
    [/victim(s)?/gi, 'figure'],
    [/attack(?:ing|ed|s)?/gi, 'dynamic motion'],
    [/fight(?:ing|s)?/gi, 'dynamic motion'],
    [/battle/gi, 'dynamic scene'],
    [/combat/gi, 'dynamic movement'],
    [/strike(?:s|ing)?|hit(?:ting|s)?|slam(?:med|ming)?|smash(?:ed|ing)?/gi, 'contact'],
    [/stomp(?:ed|ing)?|crush(?:ed|ing)?/gi, 'press'],
    [/cut(?:ting)?|slice(?:d|s|ing)?|slash(?:ed|ing)?|stab(?:bed|bing)?|pierc(?:e|ed|ing)|impal(?:e|ed|ing)/gi, ''],
    // Weapons
    [/weapon(s)?/gi, 'prop'],
    [/gun(s)?/gi, 'prop'],
    [/knife|knives/gi, 'prop'],
    [/sword(s)?/gi, 'prop'],
    [/axe(s)?/gi, 'prop'],
    [/spear(s)?/gi, 'prop'],
    // Fluids / splatter
    [/splatter(?:s|ed|ing)?/gi, 'drift'],
    [/splash(?:es|ed|ing)?/gi, 'drift'],
    [/fluid/gi, 'liquid'],
    [/droplet(s)?/gi, 'small particles'],
    [/liquid/gi, 'color wash'],
    [/ooz(?:e|ing)?/gi, 'rapid shift'],
    [/drip(?:ping|s)?/gi, 'rapid shift'],
    [/simmer(?:ing)?/gi, 'strong pulse'],
    [/gasp(?:ing)?/gi, 'heavy breathing'],
    [/collapsed|fallen|defeated|suppressed|crushing/gi, 'resting'],
    [/pile|heap/gi, 'group'],
    [/\bboot\b/gi, 'foot'],
    [/debris|fragments?/gi, 'particles'],
    [/dust|ash/gi, 'grain'],
    [/explod(?:e|ed|ing)|explosion/gi, 'glow pulse'],
    // Teeth wording
    [/maw|fang(s)?|jaw/gi, 'smile'],
    [/teeth/gi, 'smile'],
    [/toothy/gi, 'wide']
  ];

  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, replacement);
  }

  output = output.replace(/background:\s*completely static[^\\n]*/gi, 'Panel/Props: strong continuous motion of existing details');
  output = output.replace(/\s{2,}/g, ' ').trim();
  return output;
}

function amplifyMotionText(text = '') {
  return text
    .replace(/\bsubtle(?:ly)?\b/gi, 'strong')
    .replace(/\bgentle(?:ly)?\b/gi, 'strong')
    .replace(/\bslight(?:ly)?\b/gi, 'strong')
    .replace(/\bsoft(?:ly)?\b/gi, 'strong')
    .replace(/\bfaint(?:ly)?\b/gi, 'strong')
    .replace(/\bminor\b/gi, 'strong')
    .replace(/\bsmall\b/gi, 'large')
    .replace(/\bslow(?:ly)?\b/gi, 'fast')
    .replace(/\boccasional(?:ly)?\b/gi, 'frequent')
    .replace(/\bdrift(?:s|ing)?\b/gi, 'sweep');
}

function compactPrompt(text = '', maxLines = 4, maxChars = 280) {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  let output = lines.join('\n');
  if (output.length > maxChars) {
    output = output.slice(0, maxChars).trim();
  }
  return output;
}

function stripSensitiveLines(text = '') {
  const blocked = [
    /underfoot|under foot/gi,
    /\bpress(?:ed|ure|ing)?\b/gi,
    /\bcompress(?:ed|ion|ing)?\b/gi,
    /\bcrush(?:ed|ing)?\b/gi,
    /\bstomp(?:ed|ing)?\b/gi,
    /\bsmash(?:ed|ing)?\b/gi,
    /\bimpact\b/gi,
    /\blunge\b/gi,
    /\bstrike(?:s|ing)?\b/gi,
    /\bhit(?:s|ting)?\b/gi,
    /\bwound(?:ed|s)?\b/gi,
    /\binjur(?:e|ed|y|ies)\b/gi,
    /\bdefeat(?:ed|ing)?\b/gi,
    /\bdead|death|die|dying\b/gi,
    /\bblood|gore|gory\b/gi,
    /\bmoan|roar|bark|scream|panic\b/gi,
    /\bkill|attack|fight|battle|combat\b/gi,
    /\bweapon|knife|gun|sword|axe|spear\b/gi,
    /\bblade|chainsaw|chain\s*saw\b/gi
    ,/\bchild(?:ren)?\b/gi
    ,/\bkid(?:s)?\b/gi
    ,/\bteen(?:ager|s)?\b/gi
    ,/\bminor(?:s)?\b/gi
    ,/\byouth(?:s)?\b/gi
    ,/\byoung\b/gi
    ,/\bboy(?:s)?\b/gi
    ,/\bgirl(?:s)?\b/gi
    ,/\bman\b/gi
    ,/\bwoman\b/gi
    ,/\bolder\b/gi
  ];
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !blocked.some(pattern => pattern.test(line)));
  return lines.join('\n').trim();
}

function buildMinimalPrompt(userPrompt = '') {
  const base = [
    'URGENT: START WITH PROVIDED IMAGE AS FRAME 0. MAXIMIZE MOVEMENT.',
    'Video must evolve from the input image. Do not output a static image.',
    'Every character in every panel must be moving continuously (chest heaving, rapid blinking, swaying).',
    'Add strong "wind" triggers: hair and clothes must flow violently.',
    'Backgrounds must drift, shimmer, or pulse rapidly.',
    'Animate crowds with individual distinct timings.',
    'Exaggerate all motions significantly.',
    'Avoid pauses. Full loop of constant, intense activity.',
    'HIGHEST PRIORITY: Any USER REQUEST must be executed clearly and prominently while preserving character identity and art style.'
  ];
  const cleaned = userPrompt ? sanitizePrompt(userPrompt) : '';
  const safeUser = cleaned ? stripSensitiveLines(cleaned) : '';
  const wantsClean = /\b(no dust|no dirt|clean air|clear air|no debris|no particles|clean background|clear background)\b/i.test(cleaned);
  const transformative = isTransformativeRequest(cleaned);
  if (!wantsClean && !transformative) {
    base.splice(4, 0, 'ENVIRONMENT: Animate rocks, debris, and particles flying through the air with clear speed.');
  }
  if (safeUser) {
    base.push(`USER REQUEST (OVERRIDE): ${safeUser.slice(0, 160)}`);
    if (wantsClean || transformative) {
      base.push('MINIMIZE AIRBORNE DEBRIS: No dust, dirt, particles, or debris. Background should stay clean and readable.');
    }
    if (transformative) {
      base.push('TEXT BUBBLES LOCKED: Keep all speech/thought bubbles, captions, and lettering unchanged and fully readable. Do not warp, replace, or obscure text.');
    }
  }
  return base.join('\n');
}

function isTransformativeRequest(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(turn|transform|become|morph|change into|turn into|convert|mutate)\b/.test(t);
}

function buildUltraShortPrompt(userPrompt = '') {
  const base = [
    'Start with provided image. Transform into video with intense motion.',
    'Characters breathe deeply, blink often, and sway heavily.',
    'Hair and clothes must ripple like flags in strong wind.',
    'Environment: Debris and rocks must fly across the frame.',
    'Backgrounds active (clouds, dust, leaves moving fast).',
    'No static frames. Everything alive, everything moving.'
  ];
  const cleaned = userPrompt ? sanitizePrompt(userPrompt).slice(0, 120) : '';
  if (cleaned) {
    base.push(`CONTEXT: ${cleaned}`);
  }
  return base.join('\n');
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

async function listGeminiModels() {
  if (!GEMINI_API_KEY) {
    return { models: [] };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
  const response = await fetchWithRetry(url, { method: 'GET' });
  const data = response.json();
  return data || { models: [] };
}

async function buildPromptFromImage({ imageData, mimeType, userPrompt }) {
  console.log('🧠 Building prompt...');
  const cleanedUserPrompt = userPrompt && typeof userPrompt === 'string'
    ? sanitizePrompt(userPrompt).slice(0, 500)
    : '';
  const transformOverride = (cleanedUserPrompt && isTransformativeRequest(cleanedUserPrompt))
    ? '\nOVERRIDE FOR THIS REQUEST: The user explicitly wants a transformation. It is allowed to morph character bodies and faces to satisfy the USER REQUEST. Preserve panel layout and camera, but the characters must visibly transform into the requested form. The transformation must START at frame 0 and be OBVIOUS by second 1, with the transformed form sustained for the rest of the clip. Ignore any "no morphing" restrictions for this request.'
    : '';
  if (VEO_MINIMAL_PROMPT) {
    if (VEO_USE_GEMINI3_PROMPT && imageData && mimeType) {
      try {
        console.log('🧠 Gemini analysis (minimal) start');
        const analysisPrompt = 'Write 4–6 complete sentences describing the full scene: background, environment, and all visible figures. Include 12–16 visible elements and specify the exact motion each should do (blink, mouth move, breathing, hair/cloth sway, rocks move fast along trails, dust/texture sweep, clouds). If a panel shows a group, explicitly state that every person in that group must animate with at least two distinct motions and unique timing. Use only neutral terms like figure/character/object; avoid age/gender or violent words. Avoid words like subtle/gentle/slight/slow and use strong motion verbs.';
        const analysisContents = [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: imageData } },
              { text: analysisPrompt }
            ]
          }
        ];
        const analysisConfig = {
          ...(GEMINI3_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL } } : {}),
          temperature: 0,
          topP: 0.2
        };
        const analysis = await generateGeminiContent({
          model: GEMINI3_ANALYSIS_MODEL,
          contents: analysisContents,
          generationConfig: analysisConfig
        });
        let cleanedAnalysis = sanitizePrompt(analysis.text || '');
        cleanedAnalysis = cleanedAnalysis.replace(/^based on[^:]*:\s*/i, '');
        cleanedAnalysis = cleanedAnalysis.replace(/^here are[^:]*:\s*/i, '');
        cleanedAnalysis = stripSensitiveLines(cleanedAnalysis);
        cleanedAnalysis = amplifyMotionText(cleanedAnalysis)
          .replace(/\s+/g, ' ')
          .trim();
        // Keep full Gemini analysis for the prompt (no truncation).
        if (cleanedAnalysis && !/[.!?]$/.test(cleanedAnalysis)) {
          cleanedAnalysis = `${cleanedAnalysis}.`;
        }
        if (cleanedAnalysis) {
          console.log(`🧠 Gemini analysis (minimal) result: ${cleanedAnalysis}`);
          const userOverride = cleanedUserPrompt
            ? `\nUSER REQUEST MUST OVERRIDE: ${stripSensitiveLines(cleanedUserPrompt)}`
            : '';
          return `${ANIMATION_PROMPT}\n\n${buildMinimalPrompt(cleanedUserPrompt)}${userOverride}${transformOverride}\nFocus: ${cleanedAnalysis} Animate these items with strong, continuous motion.`;
        }
      } catch (error) {
        console.warn('⚠️ Gemini analysis (minimal) failed, using minimal prompt only.');
      }
    }
    const userOverride = cleanedUserPrompt
      ? `\nUSER REQUEST MUST OVERRIDE: ${stripSensitiveLines(cleanedUserPrompt)}`
      : '';
    return `${ANIMATION_PROMPT}\n\n${buildMinimalPrompt(cleanedUserPrompt)}${userOverride}${transformOverride}`;
  }

  if (!VEO_USE_GEMINI3_PROMPT) {
    if (!userPrompt || typeof userPrompt !== 'string') {
      return ANIMATION_PROMPT;
    }
    if (!cleanedUserPrompt) {
      return ANIMATION_PROMPT;
    }
    return `${ANIMATION_PROMPT}\n\nUSER DIRECTION (must comply with constraints):\n${cleanedUserPrompt}${transformOverride}`;
  }
  if (!imageData || !mimeType) {
    if (!userPrompt || typeof userPrompt !== 'string') {
      return ANIMATION_PROMPT;
    }
    if (!cleanedUserPrompt) {
      return ANIMATION_PROMPT;
    }
    return `${ANIMATION_PROMPT}\n\nUSER DIRECTION (must comply with constraints):\n${cleanedUserPrompt}${transformOverride}`;
  }

  const analysisPrompt = [
    'List visible characters and one or two clearly visible motions each, plus one background/prop motion. Use strong motion verbs; avoid words like subtle/gentle/slight/slow. Be very brief.',
    ...(cleanedUserPrompt ? [`USER DIRECTION: ${cleanedUserPrompt}`] : [])
  ].join('\n');

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

  const analysisConfig = {
    ...(GEMINI3_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL } } : {}),
    temperature: 0,
    topP: 0.2
  };

  let analysis;
  try {
    console.log('🧠 Gemini analysis start');
    analysis = await generateGeminiContent({
      model: GEMINI3_ANALYSIS_MODEL,
      contents: analysisContents,
      generationConfig: analysisConfig
    });
    console.log('🧠 Gemini analysis result:', amplifyMotionText(sanitizePrompt(analysis.text || '')).slice(0, 240));
  } catch (error) {
    console.warn('⚠️ Gemini analysis failed, using ultra-short prompt fallback.');
    return `${ANIMATION_PROMPT}\n\n${buildUltraShortPrompt(cleanedUserPrompt)}${transformOverride}`;
  }

  const promptBuilderInstruction = [
    'Write 3-4 short lines total. No headings.',
    'Each line: character/prop + 1-2 visible motions. Neutral words only.',
    'Preserve art exactly. No camera motion. No new elements.',
    ...(cleanedUserPrompt ? [`USER DIRECTION: ${cleanedUserPrompt}`] : []),
    'Reference analysis:',
    amplifyMotionText(sanitizePrompt(analysis.text || ''))
  ].join('\n');

  const promptContents = [
    {
      role: 'user',
      parts: [{ text: promptBuilderInstruction }]
    }
  ];

  const promptConfig = {
    ...(GEMINI3_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: GEMINI3_THINKING_LEVEL } } : {}),
    temperature: 0,
    topP: 0.2
  };

  let promptResult;
  try {
    console.log('🧠 Gemini prompt build start');
    promptResult = await generateGeminiContent({
      model: GEMINI3_PROMPT_MODEL,
      contents: promptContents,
      generationConfig: promptConfig
    });
    console.log('🧠 Gemini prompt build done');
  } catch (error) {
    console.warn('⚠️ Gemini prompt build failed, using ultra-short prompt fallback.');
    return `${ANIMATION_PROMPT}\n\n${buildUltraShortPrompt(cleanedUserPrompt)}${transformOverride}`;
  }

  const rawPrompt = promptResult.text || '';
  const sanitized = sanitizePrompt(rawPrompt);
  const stripped = stripSensitiveLines(sanitized);
  const boosted = amplifyMotionText(stripped || sanitized);
  const shortened = compactPrompt(boosted, 4, 280);
  const finalLines = shortened || buildUltraShortPrompt(cleanedUserPrompt);
  return `${ANIMATION_PROMPT}\n\n${finalLines}${transformOverride}`;
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

async function pollOperation(operationName, shouldCancel) {
  const maxPolls = 180;
  const pollInterval = 5000;
  let url = `https://generativelanguage.googleapis.com/${operationName}?key=${GEMINI_API_KEY}`;
  if (!operationName.startsWith('v')) {
    url = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${GEMINI_API_KEY}`;
  }

  console.log(`⏳ Polling URL: ${url.replace(GEMINI_API_KEY, 'KEY')}`);

  for (let i = 0; i < maxPolls; i++) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Request canceled by client');
    }
    const response = await fetchWithRetry(url, { method: 'GET' });
    const operation = response.json();
    if (operation.done) {
      if (operation.error) throw new Error(operation.error.message || 'Video gen failed');
      return operation.response;
    }
    console.log(`⏳ Polling... ${i + 1}/${maxPolls}`);
    await sleepWithCancel(pollInterval, shouldCancel);
  }
  throw new Error('Video generation timed out');
}

async function pollVertexOperation(operationName, shouldCancel) {
  const url = getVertexEndpoint('fetchPredictOperation');
  if (!url) throw new Error('Vertex AI is not configured');
  const maxPolls = 180;
  const pollInterval = 5000;
  console.log(`⏳ Vertex polling started: ${operationName}`);

  for (let i = 0; i < maxPolls; i += 1) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Request canceled by client');
    }
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
    await sleepWithCancel(pollInterval, shouldCancel);
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
    console.log(`🟢 Veo slot acquired (inFlight=${veoInFlight})`);
    return;
  }
  console.log(`⏳ Waiting for Veo slot (inFlight=${veoInFlight}, queue=${veoQueue.length})`);
  await new Promise(resolve => veoQueue.push(resolve));
  await waitForVeoCooldown();
  veoInFlight += 1;
  console.log(`🟢 Veo slot acquired after wait (inFlight=${veoInFlight})`);
}

function releaseVeoSlot() {
  if (VEO_MAX_CONCURRENT < 1) return;
  veoInFlight = Math.max(0, veoInFlight - 1);
  console.log(`🟣 Veo slot released (inFlight=${veoInFlight})`);
  if (veoQueue.length > 0 && veoInFlight < VEO_MAX_CONCURRENT) {
    const next = veoQueue.shift();
    next();
  }
}

app.post('/api/veo', async (req, res) => {
  const { imageBase64, mimeType, aspectRatio, model, resolution, userPrompt, pageIndex, pageNumber, source } = req.body;
  const pageLabel = Number.isFinite(pageNumber)
    ? `Page ${pageNumber}`
    : Number.isFinite(pageIndex)
      ? `Page ${pageIndex + 1}`
      : 'Page ?';
  const sourceLabel = source ? ` · ${source}` : '';
  console.log(`\n🎬 === VEO VIDEO GENERATION REQUEST (${pageLabel}${sourceLabel}) ===`);
  let requestCanceled = false;
  const markCanceled = (reason) => {
    if (requestCanceled) return;
    requestCanceled = true;
    console.warn(`⚠️ Request canceled by client (${reason}) (${pageLabel}${sourceLabel})`);
  };
  req.on('aborted', () => {
    markCanceled('aborted');
  });
  req.on('close', () => {
    if (req.aborted) {
      markCanceled('close');
    }
  });

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
  console.log('🧠 Waiting for prompt build + model call...');
  await acquireVeoSlot();
  if (requestCanceled) {
    console.warn(`⚠️ Request canceled before prompt build (${pageLabel}${sourceLabel})`);
    releaseVeoSlot();
    return;
  }
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
      mimeType: effectiveMimeType,
      userPrompt
    });
    const promptSeedPart = userPrompt && typeof userPrompt === 'string'
      ? sanitizePrompt(userPrompt).trim()
      : '';
    const imageSeedPart = imageData
      ? `${imageData.length}:${imageData.slice(0, 2048)}:${imageData.slice(-2048)}`
      : '';
    const seedInput = [promptSeedPart, imageSeedPart, pageIndex ?? '', pageNumber ?? ''].join('|');
    const seed = stableSeedFromString(seedInput);
    console.log('🧠 Prompt build complete.');
    const promptPreview = animationPrompt.length > 420
      ? `${animationPrompt.slice(0, 420)}…`
      : animationPrompt;
    console.log('🧠 Prompt preview:', promptPreview);
    console.log(`🎲 Seed: ${seed}`);
    if (VEO_DEBUG_PROMPT) {
      console.log('🧠 Full prompt:\n', animationPrompt);
    }
    if (requestCanceled) {
      console.warn(`⚠️ Request canceled after prompt build (${pageLabel}${sourceLabel})`);
      return;
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
        console.log(`🖼️ Uploading reference image to GCS: gs://${gcs.bucket}/${objectPath}`);
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
        console.log(`✅ Image uploaded successfully`);
        instance.image = {
          gcsUri: `gs://${gcs.bucket}/${objectPath}`,
          mimeType: effectiveMimeType
        };
      }

      const parameters = {
        storageUri,
        sampleCount: 1,
        durationSeconds: VEO_DURATION_SECONDS,
        ...(aspectRatio ? { aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9' } : {}),
        ...(resolution ? { resolution } : {}),
        seed,
        // CRITICAL: Negative prompt to prevent static images
        negativePrompt: 'static, frozen, still image, photograph, jpeg, motionless, pause, freeze, slide show, text only, blurred, warped, low quality'
      };

      const imageRef = instance.image ? { ...instance.image } : null;

      const callVertex = async (promptToUse) => {
        const vertexBody = {
          instances: [
            {
              prompt: promptToUse,
              ...(imageRef ? { image: imageRef } : {})
            }
          ],
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
          const result = await pollVertexOperation(vertexResult.name, () => requestCanceled);
          const videoUrl = extractVideoUrl(result);
          return { videoUrl, result };
        }

        throw new Error(`Unexpected Vertex response: ${vertexText.substring(0, 300)}`);
      };

      if (requestCanceled) {
        console.warn(`⚠️ Request canceled before Vertex call (${pageLabel}${sourceLabel})`);
        return;
      }
      const initial = await callVertex(animationPrompt);
      if (initial.videoUrl) {
        const downloadUrl = buildDownloadUrl(req, initial.videoUrl);
        console.log('✅ VIDEO READY:', initial.videoUrl);
        return res.json({
          videoUrl: initial.videoUrl,
          downloadUrl,
          status: 'ready',
          resolution,
          ...(VEO_DEBUG_PROMPT ? { prompt: animationPrompt } : {})
        });
      }

      const raiInfo = getRaiFilterInfo(initial.result);
      if (raiInfo) {
        console.warn('⚠️ Vertex RAI filter triggered. No retry (per request).');
        throw new Error('Vertex safety filter blocked the prompt. Try rephrasing to be more neutral.');
      }

      const preview = JSON.stringify(initial.result).slice(0, 1200);
      console.error('❌ Vertex response missing output URI:', preview);
      throw new Error('Vertex video generation completed but output URI not found');
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
      seed,
      includeImage: VEO_INCLUDE_IMAGE,
      imageMode
    });

    let imageMode = VEO_GEMINI_IMAGE_MODE;
    let requestBody = buildRequestBody(imageMode);
    let triedAlternateImageMode = false;

    console.log(`🖼️ Image mode: ${imageMode}, includeImage: ${VEO_INCLUDE_IMAGE}, hasImage: ${!!imageData}`);
    if (imageMode === 'first_frame' && imageData) {
      console.log(`🖼️ Using image as starting frame for image-to-video generation`);
    } else if (imageMode === 'reference' && imageData) {
      console.log(`🖼️ Using image as style reference (may not maintain visual fidelity - try VEO_GEMINI_IMAGE_MODE=first_frame)`);
    }

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
      const result = await pollOperation(generateResult.name, () => requestCanceled);
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
    if (requestCanceled || /canceled by client/i.test(error?.message || '')) {
      console.warn('⚠️ Request canceled by client, stopping polling.');
      return;
    }
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
      if (res.headersSent || res.writableEnded) {
        console.warn(`⚠️ Download stream error after headers sent: ${message}`);
        return;
      }
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
    if (res.headersSent || res.writableEnded) {
      console.warn(`⚠️ Download stream error after headers sent: ${message}`);
      return;
    }
    return res.status(500).json({ error: message });
  }
});

app.get('/api/models', async (_req, res) => {
  try {
    const data = await listGeminiModels();
    const models = Array.isArray(data.models) ? data.models : [];
    const veoModels = models.filter(model => {
      const name = (model.name || '').toLowerCase();
      const displayName = (model.displayName || '').toLowerCase();
      return name.includes('veo') || displayName.includes('veo');
    });

    res.json({
      hasVeoAccess: VEO_PROVIDER === 'vertex' ? true : veoModels.length > 0,
      totalModels: models.length,
      veoModels: veoModels.map(model => model.name || model.displayName || 'unknown')
    });
  } catch (error) {
    const message = error?.message || String(error);
    res.json({
      hasVeoAccess: VEO_PROVIDER === 'vertex',
      totalModels: 0,
      veoModels: [],
      error: message
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true
  });
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
