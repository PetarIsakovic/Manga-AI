import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export async function computePdfHash(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function renderPdfToImages(arrayBuffer, options = {}) {
  const { scale = 2, maxLongSide = 1920, minLongSide = 720 } = options;
  
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const processed = processImage(canvas, { maxLongSide, minLongSide });
    
    pages.push({
      pageNumber: i,
      width: processed.width,
      height: processed.height,
      aspectRatio: processed.aspectRatio,
      dataUrl: processed.dataUrl,
      imageBase64: processed.base64,
      mimeType: 'image/jpeg'
    });
  }
  
  return pages;
}

function processImage(canvas, { maxLongSide, minLongSide }) {
  const width = canvas.width;
  const height = canvas.height;
  const longSide = Math.max(width, height);
  
  let targetLongSide = longSide;
  if (longSide > maxLongSide) {
    targetLongSide = maxLongSide;
  } else if (longSide < minLongSide) {
    targetLongSide = minLongSide;
  }
  
  const scaleFactor = targetLongSide / longSide;
  const newWidth = Math.round(width * scaleFactor);
  const newHeight = Math.round(height * scaleFactor);
  
  const isTall = newHeight > newWidth;
  const veoAspectRatio = isTall ? '9:16' : '16:9';
  
  let padWidth;
  let padHeight;
  
  if (isTall) {
    padHeight = newHeight;
    padWidth = Math.round(newHeight * (9 / 16));
    if (padWidth < newWidth) {
      padWidth = newWidth;
      padHeight = Math.round(newWidth * (16 / 9));
    }
  } else {
    padWidth = newWidth;
    padHeight = Math.round(newWidth * (9 / 16));
    if (padHeight < newHeight) {
      padHeight = newHeight;
      padWidth = Math.round(newHeight * (16 / 9));
    }
  }
  
  const paddedCanvas = document.createElement('canvas');
  paddedCanvas.width = padWidth;
  paddedCanvas.height = padHeight;
  
  const pctx = paddedCanvas.getContext('2d');
  pctx.fillStyle = '#000000';
  pctx.fillRect(0, 0, padWidth, padHeight);
  
  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = newWidth;
  scaledCanvas.height = newHeight;
  scaledCanvas.getContext('2d').drawImage(canvas, 0, 0, newWidth, newHeight);
  
  const ox = Math.round((padWidth - newWidth) / 2);
  const oy = Math.round((padHeight - newHeight) / 2);
  pctx.drawImage(scaledCanvas, ox, oy);
  
  const dataUrl = paddedCanvas.toDataURL('image/jpeg', 0.85);
  const base64 = dataUrl.split(',')[1];
  
  return {
    width: padWidth,
    height: padHeight,
    aspectRatio: veoAspectRatio,
    dataUrl: dataUrl,
    base64: base64
  };
}