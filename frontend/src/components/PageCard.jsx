import React, { useRef, useEffect } from 'react';
import VideoOverlay from './VideoOverlay.jsx';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver.js';

export default function PageCard({
  page,
  pageIndex,
  state = { status: 'idle', videoUrl: null, error: null },
  showVideo,
  prefetchFn,
  isCurrent,
  needsVideo,
  onVisibilityChange,
  promptOverlay,
  onCancelPrompt
}) {
  const containerRef = useRef(null);
  
  const { isIntersecting, isNearViewport, intersectionRatio } = useIntersectionObserver(containerRef, {
    threshold: 0.3,
    rootMargin: '100% 0px'
  });

  // Prefetch when near viewport
  useEffect(() => {
    if (isNearViewport && state.status === 'idle' && prefetchFn) {
      prefetchFn(pageIndex);
    }
  }, [isNearViewport, state.status, pageIndex, prefetchFn]);

  useEffect(() => {
    if (onVisibilityChange) {
      onVisibilityChange(pageIndex, intersectionRatio);
    }
  }, [intersectionRatio, onVisibilityChange, pageIndex]);

  const isReady = state.status === 'ready';
  const shouldShowVideo = showVideo && isReady;
  const isPlaying = shouldShowVideo && isIntersecting;
  const showStatus = state.status === 'queued' || state.status === 'generating' || state.status === 'failed';
  const promptStage = promptOverlay?.stage ?? 0;
  const progressStep = Math.max(0, Math.min(4, promptStage));
  const promptProgress = Math.min(100, Math.max(0, (progressStep / 4) * 100));
  const hideImage = shouldShowVideo;
  const isProcessing = state.status === 'queued' || state.status === 'generating';
  const cardClasses = [
    'page-card',
    isProcessing ? 'processing' : '',
    isCurrent ? 'current' : '',
    needsVideo ? 'needs-video' : ''
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClasses} ref={containerRef} data-stage={state.status}>
      <div className="page-image-container">
        <img
          src={page.dataUrl}
          alt={`Page ${pageIndex + 1}`}
          className={`page-image${hideImage ? ' hidden' : ''}`}
        />
        
        {isReady && (
          <VideoOverlay
            videoUrl={state.videoUrl}
            isPlaying={isPlaying}
            visible={shouldShowVideo}
          />
        )}

        <img
          src={page.dataUrl}
          alt=""
          aria-hidden="true"
          className={`page-border-overlay${hideImage ? ' hidden' : ''}`}
        />

        {showStatus && (
          <div className={`page-status ${state.status}`}>
            {state.status === 'queued' && 'Queued'}
            {state.status === 'generating' && 'Generating…'}
            {state.status === 'failed' && (state.error ? `Failed: ${state.error}` : 'Failed')}
          </div>
        )}

        {promptOverlay && (
          <div
            className="page-prompt-overlay"
            style={{ '--prompt-progress': `${promptProgress}%` }}
          >
            <div className="page-prompt-text">{promptOverlay.text}</div>
            <div className="page-prompt-steps">
              <div className="page-prompt-line" />
              <div className={`page-prompt-step ${promptStage >= 0 ? 'done' : ''} ${promptStage === 0 ? 'active' : ''}`}>
                <span className="page-prompt-dot" />
                <span>Queue</span>
              </div>
              <div className={`page-prompt-step ${promptStage >= 1 ? 'done' : ''} ${promptStage === 1 ? 'active' : ''}`}>
                <span className="page-prompt-dot" />
                <span>Upload</span>
              </div>
              <div className={`page-prompt-step ${promptStage >= 2 ? 'done' : ''} ${promptStage === 2 ? 'active' : ''}`}>
                <span className="page-prompt-dot" />
                <span>Analyze</span>
              </div>
              <div className={`page-prompt-step ${promptStage >= 3 ? 'done' : ''} ${promptStage === 3 ? 'active' : ''}`}>
                <span className="page-prompt-dot" />
                <span>Prompt</span>
              </div>
              <div className={`page-prompt-step ${promptStage >= 4 ? 'done' : ''} ${promptStage === 4 ? 'active' : ''}`}>
                <span className="page-prompt-dot" />
                <span>Generate</span>
              </div>
            </div>
            <button
              type="button"
              className="page-prompt-cancel"
              onClick={(event) => {
                event.stopPropagation();
                onCancelPrompt && onCancelPrompt(pageIndex);
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
