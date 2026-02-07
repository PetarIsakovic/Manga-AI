import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVeoRequestBody,
  extractVideoUrl,
  isUnsupportedImageError,
  getUnsupportedField
} from './veoUtils.js';

test('buildVeoRequestBody includes image when enabled', () => {
  const body = buildVeoRequestBody({
    prompt: 'test',
    imageData: 'abc123',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '720p',
    personGeneration: 'allow_adult',
    numberOfVideos: 2,
    includeImage: true
  });

  assert.equal(body.instances[0].prompt, 'test');
  assert.deepEqual(body.instances[0].image, {
    imageBytes: 'abc123',
    mimeType: 'image/png'
  });
  assert.equal(body.parameters.numberOfVideos, 2);
});

test('buildVeoRequestBody omits image when disabled', () => {
  const body = buildVeoRequestBody({
    prompt: 'test',
    imageData: 'abc123',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '720p',
    personGeneration: undefined,
    numberOfVideos: undefined,
    includeImage: false
  });

  assert.equal(body.instances[0].prompt, 'test');
  assert.equal(body.instances[0].image, undefined);
  assert.equal(body.parameters.numberOfVideos, undefined);
  assert.equal(body.parameters.personGeneration, undefined);
});

test('buildVeoRequestBody uses first_frame mode by default', () => {
  const body = buildVeoRequestBody({
    prompt: 'test',
    imageData: 'abc123',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '720p',
    includeImage: true
  });

  // Default mode should put image in instance.image
  assert.deepEqual(body.instances[0].image, {
    imageBytes: 'abc123',
    mimeType: 'image/png'
  });
  assert.equal(body.parameters.referenceImages, undefined);
});

test('buildVeoRequestBody uses first_frame mode explicitly', () => {
  const body = buildVeoRequestBody({
    prompt: 'test',
    imageData: 'abc123',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '720p',
    includeImage: true,
    imageMode: 'first_frame'
  });

  assert.deepEqual(body.instances[0].image, {
    imageBytes: 'abc123',
    mimeType: 'image/png'
  });
  assert.equal(body.parameters.referenceImages, undefined);
});

test('buildVeoRequestBody uses reference mode for style reference', () => {
  const body = buildVeoRequestBody({
    prompt: 'test',
    imageData: 'abc123',
    mimeType: 'image/png',
    aspectRatio: '16:9',
    resolution: '720p',
    includeImage: true,
    imageMode: 'reference'
  });

  // Reference mode should put image in parameters.referenceImages
  assert.equal(body.instances[0].image, undefined);
  assert.equal(body.parameters.referenceImages.length, 1);
  assert.deepEqual(body.parameters.referenceImages[0], {
    referenceType: 'REFERENCE_TYPE_STYLE',
    referenceId: 1,
    image: {
      imageBytes: 'abc123',
      mimeType: 'image/png'
    }
  });
});

test('extractVideoUrl handles multiple response shapes', () => {
  assert.equal(
    extractVideoUrl({ generatedVideos: [{ video: { uri: 'a' } }] }),
    'a'
  );
  assert.equal(
    extractVideoUrl({ generateVideoResponse: { generatedSamples: [{ video: { uri: 'b' } }] } }),
    'b'
  );
  assert.equal(
    extractVideoUrl({ video: { uri: 'c' } }),
    'c'
  );
  assert.equal(extractVideoUrl(null), null);
});

test('isUnsupportedImageError detects image payload errors', () => {
  assert.equal(
    isUnsupportedImageError("`imageBytes` isn't supported by this model."),
    true
  );
  assert.equal(
    isUnsupportedImageError("`inlineData` isn't supported by this model."),
    true
  );
  assert.equal(
    isUnsupportedImageError('Some other error'),
    false
  );
});

test('getUnsupportedField extracts unsupported field name', () => {
  assert.equal(
    getUnsupportedField("`numberOfVideos` isn't supported by this model."),
    'numberOfVideos'
  );
  assert.equal(
    getUnsupportedField('allow_adult for personGeneration is currently not supported.'),
    'personGeneration'
  );
  assert.equal(getUnsupportedField('Some other error'), null);
});
