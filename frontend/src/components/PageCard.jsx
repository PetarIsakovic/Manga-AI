import React, { useRef, useState, useEffect, useCallback } from 'react';
import VideoOverlay from './VideoOverlay.jsx';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver.js';

const STATUS_LABELS = {
  idle: 'Not generated',
  generating: 'Generating...',
  ready: 'Ready',
  failed: 'Failed'
};

export default function PageCard({ page, pageIndex, state = { status: 'idle', videoUrl: null, error: null }, onGenerate, onRegenerate, prefetchFn }) {
  const containerRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  
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

  // Auto-play when in view
  useEffect(() => {
    if (state.status === 'ready') {
      if (isIntersecting) {
        setShowVideo(true);
        setIsPlaying(true);
      } else {
        setIsPlaying(false);
      }
    }
  }, [isIntersecting, state.status]);

  const togglePlay = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const handleDownload = useCallback(() => {
    if (state.videoUrl) {
      const a = document.createElement('a');
      a.href = state.videoUrl;
      a.download = `page-${pageIndex + 1}.mp4`;
      a.click();
    }
  }, [state.videoUrl, pageIndex]);

  return (
    <div className="page-card" ref={containerRef}>
      <div className="page-image-container">
        <img
          src={page.dataUrl}
          alt={`Page ${pageIndex + 1}`}
          className="page-image"
        />
        
        {state.status === 'ready' && showVideo && (
          <VideoOverlay
            videoUrl={state.videoUrl}
            isPlaying={isPlaying}
            visible={showVideo}
          />
        )}
      </div>
      
      <div className="page-controls">
        <span className={`status-badge ${state.status}`}>
          {STATUS_LABELS[state.status]}
          {state.isMock && ' (Demo)'}
          {state.error && `: ${state.error}`}
        </span>
        
        <div className="control-buttons">
          {state.status === 'ready' && (
            <>
              <button className="icon-btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button className="icon-btn" onClick={handleDownload} title="Download">
                ⬇
              </button>
              <button className="generate-btn" onClick={onRegenerate}>
                Regenerate
              </button>
            </>
          )}
          
          {(state.status === 'idle' || state.status === 'failed') && (
            <button className="generate-btn" onClick={onGenerate}>
              Generate
            </button>
          )}
          
          {state.status === 'generating' && (
            <div className="spinner" style={{ width: 20, height: 20 }} />
          )}
        </div>
      </div>
    </div>
  );
}
