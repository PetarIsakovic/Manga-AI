import React, { useRef, useEffect } from 'react';

export default function VideoOverlay({ videoUrl, isPlaying, visible }) {
  const videoRef = useRef(null);

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
    <div className={`video-overlay ${visible ? 'visible' : ''}`}>
      <video
        ref={videoRef}
        src={videoUrl}
        loop
        muted
        playsInline
      />
    </div>
  );
}
