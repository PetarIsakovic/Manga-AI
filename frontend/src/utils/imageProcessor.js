export function getAspectRatioForDimensions(width, height) {
  return height > width ? '9:16' : '16:9';
}

export function padImageToAspectRatio(canvas, targetAspectRatio) {
  const { width, height } = canvas;
  const targetRatio = targetAspectRatio === '9:16' ? 9 / 16 : 16 / 9;
  const currentRatio = width / height;
  
  let newWidth = width;
  let newHeight = height;
  
  if (currentRatio > targetRatio) {
    // Image is wider, add vertical padding
    newHeight = Math.round(width / targetRatio);
  } else {
    // Image is taller, add horizontal padding
    newWidth = Math.round(height * targetRatio);
  }
  
  const paddedCanvas = document.createElement('canvas');
  paddedCanvas.width = newWidth;
  paddedCanvas.height = newHeight;
  
  const ctx = paddedCanvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, newWidth, newHeight);
  
  const offsetX = Math.round((newWidth - width) / 2);
  const offsetY = Math.round((newHeight - height) / 2);
  ctx.drawImage(canvas, offsetX, offsetY);
  
  return paddedCanvas;
}
