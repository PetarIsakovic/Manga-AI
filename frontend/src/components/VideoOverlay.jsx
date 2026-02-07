import React, { useRef, useEffect, useState } from 'react';

const SAMPLE_SIZE = 128;
const BORDER_SIZE = 10;
const EDGE_DIFF_THRESHOLD = 8;

export default function VideoOverlay({ videoUrl, baseImageUrl, isPlaying, visible }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [edgeDrift, setEdgeDrift] = useState(false);
  const baseCanvasRef = useRef(null);
  const frameCanvasRef = useRef(null);
  const rafRef = useRef(null);
  const driftLockedRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setReady(false);
    video.load();

    const handleReady = () => setReady(true);
    video.addEventListener('loadeddata', handleReady);
    video.addEventListener('canplay', handleReady);

    return () => {
      video.removeEventListener('loadeddata', handleReady);
      video.removeEventListener('canplay', handleReady);
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!baseImageUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = baseImageUrl;
    img.onload = () => {
      const canvas = baseCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    };
  }, [baseImageUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    const baseCanvas = baseCanvasRef.current;
    if (!video || !baseCanvas) return undefined;

    const frameCanvas = frameCanvasRef.current;
    if (!frameCanvas) return undefined;

    frameCanvas.width = SAMPLE_SIZE;
    frameCanvas.height = SAMPLE_SIZE;
    const frameCtx = frameCanvas.getContext('2d');
    const baseCtx = baseCanvas.getContext('2d');

    const checkEdges = () => {
      if (driftLockedRef.current) {
        rafRef.current = requestAnimationFrame(checkEdges);
        return;
      }
      if (visible && video.readyState >= 2) {
        frameCtx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const baseData = baseCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
        const frameData = frameCtx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
        let diffSum = 0;
        let count = 0;

        for (let y = 0; y < SAMPLE_SIZE; y += 1) {
          for (let x = 0; x < SAMPLE_SIZE; x += 1) {
            const isBorder = x < BORDER_SIZE ||
              x >= SAMPLE_SIZE - BORDER_SIZE ||
              y < BORDER_SIZE ||
              y >= SAMPLE_SIZE - BORDER_SIZE;
            if (!isBorder) continue;
            const idx = (y * SAMPLE_SIZE + x) * 4;
            const dr = Math.abs(frameData[idx] - baseData[idx]);
            const dg = Math.abs(frameData[idx + 1] - baseData[idx + 1]);
            const db = Math.abs(frameData[idx + 2] - baseData[idx + 2]);
            diffSum += (dr + dg + db) / 3;
            count += 1;
          }
        }

        const avgDiff = count ? diffSum / count : 0;
        if (avgDiff > EDGE_DIFF_THRESHOLD) {
          driftLockedRef.current = true;
          if (!edgeDrift) {
            setEdgeDrift(true);
          }
          video.pause();
        } else if (edgeDrift) {
          setEdgeDrift(false);
          if (isPlaying) {
            video.play().catch(() => {});
          }
        }
      }

      rafRef.current = requestAnimationFrame(checkEdges);
    };

    rafRef.current = requestAnimationFrame(checkEdges);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [edgeDrift, isPlaying, visible]);

  return (
    <div className={`video-overlay ${visible && ready && !edgeDrift ? 'visible' : ''}`}>
      <video
        ref={videoRef}
        src={videoUrl}
        loop
        muted
        playsInline
        preload="auto"
      />
      <canvas ref={baseCanvasRef} style={{ display: 'none' }} />
      <canvas ref={frameCanvasRef} style={{ display: 'none' }} />
    </div>
  );
}
