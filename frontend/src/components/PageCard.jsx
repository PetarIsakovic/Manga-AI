import React, { useRef, useEffect } from 'react';
import VideoOverlay from './VideoOverlay.jsx';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver.js';

export default function PageCard({ page, pageIndex, state = { status: 'idle', videoUrl: null, error: null }, showVideo, prefetchFn }) {
  const containerRef = useRef(null);
  
  const { isIntersecting, isNearViewport } = useIntersectionObserver(containerRef, {
    threshold: 0.3,
    rootMargin: '100% 0px'
  });

  // Prefetch when near viewport
  useEffect(() => {
    if (isNearViewport && state.status === 'idle' && prefetchFn) {
      prefetchFn(pageIndex);
    }
  }, [isNearViewport, state.status, pageIndex, prefetchFn]);

  const isReady = state.status === 'ready';
  const shouldShowVideo = showVideo && isReady;
  const isPlaying = shouldShowVideo && isIntersecting;
  const showStatus = state.status === 'generating' || state.status === 'failed';

  return (
    <div className="page-card" ref={containerRef}>
      <div className="page-image-container">
        <img
          src={page.dataUrl}
          alt={`Page ${pageIndex + 1}`}
          className="page-image"
        />
        
        {isReady && (
          <VideoOverlay
            videoUrl={state.videoUrl}
            baseImageUrl={page.dataUrl}
            isPlaying={isPlaying}
            visible={shouldShowVideo}
          />
        )}

        <img
          src={page.dataUrl}
          alt=""
          aria-hidden="true"
          className="page-border-overlay"
        />

        {showStatus && (
          <div className={`page-status ${state.status}`}>
            {state.status === 'generating' && 'Generating...'}
            {state.status === 'failed' && (state.error ? `Failed: ${state.error}` : 'Failed')}
          </div>
        )}
      </div>
    </div>
  );
}
