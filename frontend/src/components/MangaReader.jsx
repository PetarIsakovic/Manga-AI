import React, { useState, useCallback, useRef, useEffect } from 'react';
import JSZip from 'jszip';
import PageCard from './PageCard.jsx';
import { useVideoCache } from '../hooks/useVideoCache.js';
import { generateVideo } from '../utils/api.js';

const PREFETCH_ENABLED = false;

export default function MangaReader({
  pages,
  pdfHash,
  displayZoom = 100,
  showZoomControl = false,
  onZoomChange,
  onToggleZoom,
  theme = 'dark',
  onToggleTheme,
  onGoHome
}) {
  const [pageStates, setPageStates] = useState(() =>
    pages.map(() => ({ status: 'idle', videoUrl: null, error: null }))
  );
  const [showVideos, setShowVideos] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [activeQuickAction, setActiveQuickAction] = useState(null);
  const [zipBusy, setZipBusy] = useState(false);
  const promptInputRef = useRef(null);
  const currentIndexRef = useRef(0);
  const generatingRef = useRef(false);
  const abortRef = useRef(null);
  const queueRef = useRef([]);
  const ratiosRef = useRef(new Map());
  const pageStatesRef = useRef(pageStates);
  const clearedCacheRef = useRef(false);
  const { setVideo, getAllVideos, clearCache } = useVideoCache();

  useEffect(() => {
    if (!clearedCacheRef.current) {
      clearedCacheRef.current = true;
      clearCache();
    }
    setPageStates(pages.map(() => ({ status: 'idle', videoUrl: null, error: null })));
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    queueRef.current = [];
    ratiosRef.current.clear();
    generatingRef.current = false;
    setShowVideos(true);
    setPromptOpen(false);
    setPromptBusy(false);
    setPromptText('');
  }, [pages, clearCache]);

  useEffect(() => {
    pageStatesRef.current = pageStates;
  }, [pageStates]);

  useEffect(() => {
    if (promptOpen) {
      requestAnimationFrame(() => {
        promptInputRef.current?.focus();
      });
    }
  }, [promptOpen]);

  const currentStatus = pageStates[currentIndex]?.status || 'idle';
  const isCurrentProcessing = currentStatus === 'generating' || currentStatus === 'queued';
  const hasActiveGeneration = pageStates.some(state => state.status === 'generating' || state.status === 'queued');

  const handleVisibilityChange = useCallback((pageIndex, ratio) => {
    ratiosRef.current.set(pageIndex, ratio);
    let bestIndex = currentIndexRef.current;
    let bestRatio = 0;
    for (const [idx, value] of ratiosRef.current.entries()) {
      if (value > bestRatio) {
        bestRatio = value;
        bestIndex = idx;
      }
    }
    if (bestRatio > 0 && bestIndex !== currentIndexRef.current) {
      currentIndexRef.current = bestIndex;
      setCurrentIndex(bestIndex);
    }
  }, []);

  const updatePageState = useCallback((index, update) => {
    setPageStates(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...update };
      return next;
    });
  }, []);

  const generateForPage = useCallback(async (pageIndex, options = {}) => {
    const page = pages[pageIndex];
    const cacheKey = `${pdfHash}-${pageIndex}-${Date.now()}`;
    const { userPrompt } = options;
    
    // NEVER use cache - always generate fresh
    updatePageState(pageIndex, { status: 'generating', error: null });
    
    try {
      const controller = new AbortController();
      abortRef.current = { pageIndex, controller };
      console.log('🎬 Requesting NEW video generation for page', pageIndex);
      const result = await generateVideo(page.imageBase64, page.mimeType, page.aspectRatio, {
        userPrompt,
        signal: controller.signal
      });
      
      console.log('✅ Got result:', result);
      
      let videoUrl = result.downloadUrl || result.videoUrl;
      
      if (result.videoData) {
        const blob = new Blob(
          [Uint8Array.from(atob(result.videoData), c => c.charCodeAt(0))],
          { type: result.mimeType || 'video/mp4' }
        );
        videoUrl = URL.createObjectURL(blob);
      }
      
      await setVideo(cacheKey, videoUrl);
      updatePageState(pageIndex, { status: 'ready', videoUrl });
      if (abortRef.current?.pageIndex === pageIndex) {
        abortRef.current = null;
      }
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
        updatePageState(pageIndex, { status: 'idle', error: null });
        if (abortRef.current?.pageIndex === pageIndex) {
          abortRef.current = null;
        }
        return false;
      }
      console.error('❌ Generation failed:', error);
      updatePageState(pageIndex, { status: 'failed', error: error.message });
      if (abortRef.current?.pageIndex === pageIndex) {
        abortRef.current = null;
      }
      return false;
    }
  }, [pages, pdfHash, setVideo, updatePageState]);

  const buildZipName = useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `manga-veo-${pdfHash || 'pages'}-${ts}.zip`;
  }, [pdfHash]);

  const parseCacheKey = useCallback((key) => {
    if (!key) return { pageIndex: null, suffix: 'video' };
    const firstDash = key.indexOf('-');
    const secondDash = key.indexOf('-', firstDash + 1);
    if (firstDash === -1 || secondDash === -1) {
      return { pageIndex: null, suffix: 'video' };
    }
    const pageIndex = parseInt(key.slice(firstDash + 1, secondDash), 10);
    const suffix = key.slice(secondDash + 1) || 'video';
    return { pageIndex: Number.isFinite(pageIndex) ? pageIndex : null, suffix };
  }, []);

  const handleZipDownload = useCallback(async () => {
    if (zipBusy) return;
    setZipBusy(true);
    try {
      const all = await getAllVideos();
      const filtered = pdfHash ? all.filter(entry => entry.key.startsWith(`${pdfHash}-`)) : all;
      if (!filtered.length) {
        setZipBusy(false);
        return;
      }
      const zip = new JSZip();
      for (const entry of filtered) {
        const { pageIndex, suffix } = parseCacheKey(entry.key);
        const pageLabel = Number.isFinite(pageIndex) ? `page-${pageIndex + 1}` : 'page';
        const safeSuffix = suffix.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 24);
        const fileName = `${pageLabel}-${safeSuffix}.mp4`;
        zip.file(fileName, entry.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = buildZipName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to build zip:', error);
    } finally {
      setZipBusy(false);
    }
  }, [buildZipName, getAllVideos, parseCacheKey, pdfHash, zipBusy]);

  const pumpQueue = useCallback(() => {
    if (generatingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;

    generatingRef.current = true;
    if (next.source === 'prompt') {
      setPromptBusy(true);
    }
    generateForPage(next.pageIndex, { userPrompt: next.userPrompt }).finally(() => {
      generatingRef.current = false;
      if (next.source === 'prompt') {
        setPromptBusy(false);
        setPromptOpen(false);
        setPromptText('');
      }
      pumpQueue();
    });
  }, [generateForPage]);

  const enqueuePage = useCallback((pageIndex, options = {}) => {
    if (pageIndex < 0 || pageIndex >= pages.length) return;
    const { userPrompt, force = false, source } = options;
    const state = pageStatesRef.current[pageIndex] || { status: 'idle' };
    const alreadyQueued = queueRef.current.some(item => item.pageIndex === pageIndex);

    if (!force) {
      if (state.status === 'generating' || state.status === 'queued') return;
      if (state.status === 'ready' && !userPrompt) return;
    }

    if (force && alreadyQueued) {
      queueRef.current = queueRef.current.filter(item => item.pageIndex !== pageIndex);
    }

    updatePageState(pageIndex, { status: 'queued', error: null });
    queueRef.current.push({ pageIndex, userPrompt, source });
    pumpQueue();
  }, [pages.length, pumpQueue, updatePageState]);

  const cancelGeneration = useCallback((pageIndex) => {
    queueRef.current = queueRef.current.filter(item => item.pageIndex !== pageIndex);
    if (abortRef.current?.pageIndex === pageIndex) {
      abortRef.current.controller.abort();
      return;
    }
    updatePageState(pageIndex, { status: 'idle', error: null });
  }, [updatePageState]);

  const handlePromptSubmit = useCallback((event) => {
    event.preventDefault();
    const text = promptText.trim();
    if (!text) {
      setPromptOpen(false);
      return;
    }
    enqueuePage(currentIndexRef.current, { userPrompt: text, force: true, source: 'prompt' });
    setPromptBusy(true);
  }, [enqueuePage, promptText]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        if (isCurrentProcessing) {
          cancelGeneration(currentIndexRef.current);
        } else {
          enqueuePage(currentIndexRef.current, { force: true });
        }
      } else if (key === 'j') {
        event.preventDefault();
        setShowVideos(prev => !prev);
      } else if (key === 'h') {
        event.preventDefault();
        if (!promptBusy && !hasActiveGeneration) {
          setPromptOpen(prev => !prev);
        }
      } else if (key === 'g') {
        if (onToggleZoom) {
          event.preventDefault();
          onToggleZoom();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelGeneration, enqueuePage, hasActiveGeneration, isCurrentProcessing, onToggleZoom, promptBusy]);

  useEffect(() => {
    if (!showZoomControl) return;
    const onPointerDown = (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('.zoom-flyout')) {
        return;
      }
      if (onToggleZoom) {
        onToggleZoom();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('touchstart', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('touchstart', onPointerDown);
    };
  }, [onToggleZoom, showZoomControl]);

  return (
    <div className={`manga-reader${promptOpen ? ' prompt-open' : ''}`}>
      {promptOpen && (
        <form className={`prompt-overlay${promptBusy ? ' busy' : ''}`} onSubmit={handlePromptSubmit}>
          <div className="prompt-shell">
            <input
              ref={promptInputRef}
              type="text"
              className="prompt-input"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !promptBusy) {
                  e.preventDefault();
                  setPromptOpen(false);
                }
              }}
              placeholder="Type a prompt for the current page and press Enter…"
              readOnly={promptBusy}
              aria-busy={promptBusy}
            />
          </div>
        </form>
      )}
      {showZoomControl && (
        <div className="zoom-flyout">
          <label htmlFor="zoom-slider">
            Size: {displayZoom}%
          </label>
          <input
            id="zoom-slider"
            type="range"
            min="30"
            max="150"
            step="5"
            value={displayZoom}
            onChange={(e) => onZoomChange && onZoomChange(Number(e.target.value))}
          />
        </div>
      )}
      <div
        className="pages-container"
        style={{ '--page-scale': displayZoom / 100 }}
      >
        {pages.map((page, index) => (
          <PageCard
            key={index}
            page={page}
            pageIndex={index}
            state={pageStates[index] || { status: 'idle', videoUrl: null, error: null }}
            showVideo={showVideos}
            prefetchFn={PREFETCH_ENABLED ? generateForPage : null}
            isCurrent={index === currentIndex}
            needsVideo={(pageStates[index]?.status || 'idle') !== 'ready'}
            onVisibilityChange={handleVisibilityChange}
          />
        ))}
      </div>

      <div className="quickbar" aria-hidden={pages.length === 0}>
        <div
          className={`quickbar-panel${isCurrentProcessing ? ' processing' : ''}`}
          role="toolbar"
          aria-label="Quick actions"
          onMouseLeave={() => setActiveQuickAction(null)}
        >
          <div className="quickbar-actions">
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'home' ? ' active' : ''}`}
              onClick={() => onGoHome && onGoHome()}
              onMouseEnter={() => setActiveQuickAction('home')}
              onFocus={() => setActiveQuickAction('home')}
              aria-label="Go home"
              title="Home"
              data-label="Home"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10" />
              </svg>
            </button>
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'size' ? ' active' : ''}`}
              onClick={() => onToggleZoom && onToggleZoom()}
              onMouseEnter={() => setActiveQuickAction('size')}
              onFocus={() => setActiveQuickAction('size')}
              aria-label="Toggle size control (G)"
              title="Size (G)"
              data-label="Size"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3H3v4M17 3h4v4M3 17v4h4M17 21h4v-4M8 8h8v8H8z" />
              </svg>
            </button>
            <div className="quickbar-divider" />
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'prompt' ? ' active' : ''}`}
              onClick={() => !promptBusy && !hasActiveGeneration && setPromptOpen(true)}
              onMouseEnter={() => setActiveQuickAction('prompt')}
              onFocus={() => setActiveQuickAction('prompt')}
              aria-label="Open prompt (H)"
              title="Prompt (H)"
              data-label="Prompt"
              disabled={promptBusy || hasActiveGeneration}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5h16v10H8l-4 4z" />
              </svg>
            </button>
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'video' ? ' active' : ''}`}
              onClick={() => setShowVideos(prev => !prev)}
              onMouseEnter={() => setActiveQuickAction('video')}
              onFocus={() => setActiveQuickAction('video')}
              aria-label="Toggle video (J)"
              title="Toggle video (J)"
              data-label={showVideos ? 'Video' : 'Image'}
            >
              {showVideos ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 4h4v16H5zM15 4l8 8-8 8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 6h16v12H4zM8 14l3-3 3 4 2-2 2 3" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`quickbar-button generate${activeQuickAction === 'generate' ? ' active' : ''}${isCurrentProcessing ? ' processing' : ''}`}
              onClick={() => {
                if (isCurrentProcessing) {
                  cancelGeneration(currentIndexRef.current);
                } else {
                  enqueuePage(currentIndexRef.current, { force: true });
                }
              }}
              onMouseEnter={() => setActiveQuickAction('generate')}
              onFocus={() => setActiveQuickAction('generate')}
              aria-label="Generate current page (K)"
              title="Generate (K)"
              data-label={isCurrentProcessing ? 'Cancel' : 'Gen'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
              </svg>
            </button>
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'save' ? ' active' : ''}`}
              onClick={handleZipDownload}
              onMouseEnter={() => setActiveQuickAction('save')}
              onFocus={() => setActiveQuickAction('save')}
              aria-label="Save videos as zip"
              title="Save"
              data-label={zipBusy ? 'Saving' : 'Save'}
              disabled={zipBusy}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v10M8 9l4 4 4-4M4 19h16" />
              </svg>
            </button>
            <button
              type="button"
              className={`quickbar-button${activeQuickAction === 'theme' ? ' active' : ''}`}
              onClick={() => onToggleTheme && onToggleTheme()}
              onMouseEnter={() => setActiveQuickAction('theme')}
              onFocus={() => setActiveQuickAction('theme')}
              aria-label="Toggle theme"
              title="Theme"
              data-label={theme === 'dark' ? 'Light' : 'Dark'}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5l-1.4-1.4M20.4 20.4L19 19M5 19l-1.4 1.4M20.4 3.6L19 5" />
                  <circle cx="12" cy="12" r="4.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className="quickbar-handle" />
      </div>
    </div>
  );
}
