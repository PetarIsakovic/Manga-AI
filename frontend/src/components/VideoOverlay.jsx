import React, { useRef, useEffect, useState } from 'react';

export default function VideoOverlay({ videoUrl, isPlaying, visible }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);

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
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isPlaying]);

  return (
    <div className={`video-overlay ${visible && ready ? 'visible' : ''}`}>
      <video
        ref={videoRef}
        src={videoUrl}
        loop
        muted
        playsInline
        preload="auto"
      />
    </div>
  );
}
