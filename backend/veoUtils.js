export function buildVeoRequestBody({
  prompt,
  imageData,
  mimeType,
  aspectRatio,
  resolution,
  personGeneration,
  numberOfVideos,
  seed,
  includeImage = true,
  imageMode = 'first_frame'
}) {
  const instance = { prompt };
  const parameters = {
    aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9',
    resolution: resolution || '720p',
    ...(Number.isInteger(numberOfVideos) && numberOfVideos > 0
      ? { numberOfVideos }
      : {}),
    ...(personGeneration ? { personGeneration } : {}),
    ...(Number.isInteger(seed) ? { seed } : {})
  };

  if (includeImage && imageData && mimeType) {
    if (imageMode === 'reference') {
      // Reference mode: image goes in parameters.referenceImages
      // This tells Veo to use the image as a style/content reference
      // while generating the video, keeping it faithful to the original
      parameters.referenceImages = [
        {
          referenceType: 'REFERENCE_TYPE_STYLE',
          referenceId: 1,
          image: {
            imageBytes: imageData,
            mimeType
          }
        }
      ];
    } else {
      // first_frame mode (default): image goes in instance.image
      // This uses the image as the starting frame for image-to-video generation
      instance.image = {
        imageBytes: imageData,
        mimeType
      };
    }
  }

  return {
    instances: [instance],
    parameters
  };
}

export function extractVideoUrl(result) {
  if (!result) return null;
  if (result.generatedVideos?.[0]?.video?.uri) return result.generatedVideos[0].video.uri;
  if (result.generatedVideos?.[0]?.video?.gcsUri) return result.generatedVideos[0].video.gcsUri;
  if (result.generatedVideos?.[0]?.gcsUri) return result.generatedVideos[0].gcsUri;
  if (result.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
    return result.generateVideoResponse.generatedSamples[0].video.uri;
  }
  if (result.generateVideoResponse?.generatedSamples?.[0]?.video?.gcsUri) {
    return result.generateVideoResponse.generatedSamples[0].video.gcsUri;
  }
  if (result.video?.uri) return result.video.uri;
  if (result.video?.gcsUri) return result.video.gcsUri;
  if (result.outputUri) return result.outputUri;
  if (result.outputs?.[0]?.gcsUri) return result.outputs[0].gcsUri;
  if (result.outputs?.[0]?.uri) return result.outputs[0].uri;
  if (result.predictions?.[0]?.gcsUri) return result.predictions[0].gcsUri;
  if (result.predictions?.[0]?.uri) return result.predictions[0].uri;
  if (result.predictions?.[0]?.video?.gcsUri) return result.predictions[0].video.gcsUri;
  if (result.predictions?.[0]?.video?.uri) return result.predictions[0].video.uri;
  if (result.predictions?.[0]?.videos?.[0]?.gcsUri) return result.predictions[0].videos[0].gcsUri;
  if (result.predictions?.[0]?.videos?.[0]?.uri) return result.predictions[0].videos[0].uri;

  const findFirstUri = (value, depth = 0) => {
    if (!value || depth > 4) return null;
    if (typeof value === 'string') {
      if (value.startsWith('gs://') || value.startsWith('http')) return value;
      return null;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 10); i += 1) {
        const found = findFirstUri(value[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      for (const [key, val] of entries) {
        if (typeof val === 'string') {
          const lowerKey = key.toLowerCase();
          if (lowerKey.includes('uri') || lowerKey.includes('url')) {
            if (val.startsWith('gs://') || val.startsWith('http')) return val;
          }
        }
      }
      for (const [, val] of entries) {
        const found = findFirstUri(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return findFirstUri(result);
}

export function isUnsupportedImageError(message = '') {
  return /imageBytes\W*isn't supported|inlineData\W*isn't supported/i.test(message);
}

export function getUnsupportedField(message = '') {
  const backtickMatch = message.match(/`([^`]+)`\s+isn't supported/i);
  if (backtickMatch) return backtickMatch[1];

  const personGenerationMatch = message.match(/for\s+personGeneration\s+is currently not supported/i);
  if (personGenerationMatch) return 'personGeneration';

  const genericMatch = message.match(/\b(personGeneration|numberOfVideos|aspectRatio|resolution)\b.*not supported/i);
  return genericMatch ? genericMatch[1] : null;
}
