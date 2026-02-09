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
    pages.map(() => ({ status: 'idle', videoUrl: null, error: null, stage: 0, progress: 0, generationId: 0 }))
  );
  const [showVideos, setShowVideos] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [promptOverlays, setPromptOverlays] = useState({});
  const promptStageTimersRef = useRef([]);
  const pageStageTimersRef = useRef(new Map());
  const progressTimersRef = useRef(new Map());
  const [activeQuickAction, setActiveQuickAction] = useState(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [autoDone, setAutoDone] = useState(false);
  const [autoSkipped, setAutoSkipped] = useState(false);
  const promptInputRef = useRef(null);
  const currentIndexRef = useRef(0);
  const generatingRef = useRef(false);
  const abortRef = useRef(null);
  const queueRef = useRef([]);
  const ratiosRef = useRef(new Map());
  const pageStatesRef = useRef(pageStates);
  const generationCountersRef = useRef(new Map());
  const clearedCacheRef = useRef(false);
  const didAutoEnqueueRef = useRef(false);
  const { setVideo, getAllVideos, clearCache } = useVideoCache();

  const makeCacheKey = useCallback((pageIndex) => {
    const prefix = pdfHash || 'pages';
    return `${prefix}::${pageIndex}`;
  }, [pdfHash]);

  useEffect(() => {
    if (!clearedCacheRef.current) {
      clearedCacheRef.current = true;
      clearCache();
    }
    setPageStates(pages.map(() => ({ status: 'idle', videoUrl: null, error: null, stage: 0, progress: 0, generationId: 0 })));
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    queueRef.current = [];
    ratiosRef.current.clear();
    generationCountersRef.current.clear();
    generatingRef.current = false;
    setShowVideos(false);
    setPromptOpen(false);
    setPromptBusy(false);
    setPromptText('');
    setPromptOverlays({});
    setAutoMode(pages.length > 0);
    setAutoDone(false);
    setAutoSkipped(false);
    didAutoEnqueueRef.current = false;
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

  const currentPromptLocked = Boolean(promptOverlays[currentIndex]);
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

  const clearPromptStageTimers = useCallback(() => {
    promptStageTimersRef.current.forEach(timerId => clearTimeout(timerId));
    promptStageTimersRef.current = [];
  }, []);

  const clearPageStageTimers = useCallback((pageIndex) => {
    const timers = pageStageTimersRef.current.get(pageIndex);
    if (timers) {
      timers.forEach(timerId => clearTimeout(timerId));
      pageStageTimersRef.current.delete(pageIndex);
    }
  }, []);

  const clearPageProgressTimer = useCallback((pageIndex) => {
    const timer = progressTimersRef.current.get(pageIndex);
    if (timer) {
      clearInterval(timer);
      progressTimersRef.current.delete(pageIndex);
    }
  }, []);

  const startPageProgress = useCallback((pageIndex) => {
    clearPageProgressTimer(pageIndex);
    const startedAt = Date.now();
    const pollEstimateMs = 15 * 5000;
    const startDelayMs = 2500;
    updatePageState(pageIndex, { progress: 0 });
    const id = setInterval(() => {
      const elapsed = Math.max(0, Date.now() - startedAt - startDelayMs);
      const progress = Math.min(elapsed / pollEstimateMs, 0.95);
      updatePageState(pageIndex, { progress });
    }, 1000);
    progressTimersRef.current.set(pageIndex, id);
  }, [clearPageProgressTimer, updatePageState]);

  const updatePageStage = useCallback((pageIndex, stage) => {
    updatePageState(pageIndex, { stage });
  }, [updatePageState]);

  const schedulePageStages = useCallback((pageIndex) => {
    clearPageStageTimers(pageIndex);
    const timers = [
      setTimeout(() => updatePageStage(pageIndex, 2), 900),
      setTimeout(() => updatePageStage(pageIndex, 3), 1900),
      setTimeout(() => updatePageStage(pageIndex, 4), 2900)
    ];
    pageStageTimersRef.current.set(pageIndex, timers);
  }, [clearPageStageTimers, updatePageStage]);

  const updatePromptStage = useCallback((pageIndex, stage) => {
    setPromptOverlays((current) => {
      const existing = current[pageIndex];
      if (!existing) return current;
      return { ...current, [pageIndex]: { ...existing, stage } };
    });
  }, []);

  const setPromptOverlayForPage = useCallback((pageIndex, overlay) => {
    setPromptOverlays((current) => ({ ...current, [pageIndex]: overlay }));
  }, []);

  const clearPromptOverlayForPage = useCallback((pageIndex) => {
    setPromptOverlays((current) => {
      if (!current[pageIndex]) return current;
      const next = { ...current };
      delete next[pageIndex];
      return next;
    });
  }, []);

  const schedulePromptStages = useCallback((pageIndex) => {
    clearPromptStageTimers();
    promptStageTimersRef.current.push(
      setTimeout(() => updatePromptStage(pageIndex, 2), 1200),
      setTimeout(() => updatePromptStage(pageIndex, 3), 2200),
      setTimeout(() => updatePromptStage(pageIndex, 4), 3200)
    );
  }, [clearPromptStageTimers, updatePromptStage]);

  const stopAllGeneration = useCallback(() => {
    queueRef.current = [];
    if (abortRef.current) {
      abortRef.current.controller.abort();
    }
    generatingRef.current = false;
    abortRef.current = null;
    pageStageTimersRef.current.forEach((timers) => {
      timers.forEach(timerId => clearTimeout(timerId));
    });
    pageStageTimersRef.current.clear();
    progressTimersRef.current.forEach((timerId) => clearInterval(timerId));
    progressTimersRef.current.clear();
    clearPromptStageTimers();
    setPromptBusy(false);
    setPromptOpen(false);
    setPromptOverlays({});
    setPageStates(prev =>
      prev.map(state =>
        state.status === 'queued' || state.status === 'generating'
          ? { ...state, status: 'idle', error: null, stage: 0, progress: 0 }
          : state
      )
    );
  }, [clearPromptStageTimers]);

  const generateForPage = useCallback(async (pageIndex, options = {}) => {
    const page = pages[pageIndex];
    const cacheKey = makeCacheKey(pageIndex);
    const { userPrompt, source } = options;
    const generationId = options.generationId ?? generationCountersRef.current.get(pageIndex) ?? 0;
    
    // NEVER use cache - always generate fresh
    updatePageState(pageIndex, { status: 'generating', error: null, stage: 1 });
    
    try {
      const controller = new AbortController();
      abortRef.current = { pageIndex, controller };
      if (source === 'prompt') {
        updatePromptStage(pageIndex, 1);
      }
      schedulePageStages(pageIndex);
      startPageProgress(pageIndex);
      console.log('🎬 Requesting NEW video generation for page', pageIndex);
      const result = await generateVideo(page.imageBase64, page.mimeType, page.aspectRatio, {
        userPrompt,
        signal: controller.signal,
        pageIndex,
        pageNumber: pageIndex + 1,
        source
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
      
      if (generationCountersRef.current.get(pageIndex) !== generationId) {
        clearPageProgressTimer(pageIndex);
        clearPageStageTimers(pageIndex);
        if (source === 'prompt') {
          clearPromptStageTimers();
        }
        return false;
      }
      await setVideo(cacheKey, videoUrl);
      clearPageProgressTimer(pageIndex);
      updatePageState(pageIndex, { status: 'ready', videoUrl, stage: 5, progress: 1, generationId });
      if (abortRef.current?.pageIndex === pageIndex) {
        abortRef.current = null;
      }
      clearPageStageTimers(pageIndex);
      if (source === 'prompt') {
        clearPromptStageTimers();
      }
      return true;
    } catch (error) {
      if (generationCountersRef.current.get(pageIndex) !== generationId) {
        clearPageProgressTimer(pageIndex);
        clearPageStageTimers(pageIndex);
        if (source === 'prompt') {
          clearPromptStageTimers();
        }
        return false;
      }
      if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
        clearPageProgressTimer(pageIndex);
        updatePageState(pageIndex, { status: 'idle', error: null, stage: 0, progress: 0, generationId });
        if (abortRef.current?.pageIndex === pageIndex) {
          abortRef.current = null;
        }
        clearPageStageTimers(pageIndex);
        if (source === 'prompt') {
          clearPromptStageTimers();
        }
        return false;
      }
      console.error('❌ Generation failed:', error);
      clearPageProgressTimer(pageIndex);
      updatePageState(pageIndex, { status: 'failed', error: error.message, stage: -1, progress: 0, generationId });
      if (abortRef.current?.pageIndex === pageIndex) {
        abortRef.current = null;
      }
      clearPageStageTimers(pageIndex);
      if (source === 'prompt') {
        clearPromptStageTimers();
      }
      return false;
    }
  }, [pages, makeCacheKey, setVideo, updatePageState, updatePromptStage, clearPromptStageTimers, schedulePageStages, clearPageStageTimers, startPageProgress, clearPageProgressTimer]);

  const buildZipName = useCallback(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `manga-veo-${pdfHash || 'pages'}-${ts}.zip`;
  }, [pdfHash]);

  const parseCacheKey = useCallback((key) => {
    if (!key) return { pageIndex: null, suffix: 'video' };
    if (key.includes('::')) {
      const [_, indexPart] = key.split('::');
      const pageIndex = parseInt(indexPart, 10);
      return { pageIndex: Number.isFinite(pageIndex) ? pageIndex : null, suffix: 'video' };
    }
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
      const filtered = pdfHash
        ? all.filter(entry => entry.key.startsWith(`${pdfHash}::`) || entry.key.startsWith(`${pdfHash}-`))
        : all;
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
      updatePromptStage(next.pageIndex, 1);
      schedulePromptStages(next.pageIndex);
    }
    generateForPage(next.pageIndex, { userPrompt: next.userPrompt, source: next.source, generationId: next.generationId }).finally(() => {
      generatingRef.current = false;
      if (next.source === 'prompt') {
        setPromptBusy(false);
        setPromptOpen(false);
        setPromptText('');
        clearPromptOverlayForPage(next.pageIndex);
        clearPromptStageTimers();
      }
      pumpQueue();
    });
  }, [generateForPage, clearPromptStageTimers, schedulePromptStages, updatePromptStage, clearPromptOverlayForPage]);

  const cancelGeneration = useCallback((pageIndex) => {
    queueRef.current = queueRef.current.filter(item => item.pageIndex !== pageIndex);
    if (abortRef.current?.pageIndex === pageIndex) {
      abortRef.current.controller.abort();
      return;
    }
    clearPageProgressTimer(pageIndex);
    updatePageState(pageIndex, { status: 'idle', error: null, progress: 0 });
    updatePageStage(pageIndex, 0);
    clearPromptOverlayForPage(pageIndex);
    clearPromptStageTimers();
    clearPageStageTimers(pageIndex);
  }, [updatePageState, clearPromptStageTimers, clearPromptOverlayForPage, clearPageStageTimers, updatePageStage, clearPageProgressTimer]);

  const enqueuePage = useCallback((pageIndex, options = {}) => {
    if (pageIndex < 0 || pageIndex >= pages.length) return;
    const { userPrompt, force = false, source } = options;
    if (autoSkipped && source === 'auto') {
      return;
    }
    if (source === 'auto' && (promptBusy || promptOpen || promptOverlays[pageIndex])) {
      return;
    }
    const state = pageStatesRef.current[pageIndex] || { status: 'idle' };
    const alreadyQueued = queueRef.current.some(item => item.pageIndex === pageIndex);
    const shouldOverride = force || Boolean(userPrompt);

    if (!force) {
      if (state.status === 'generating' || state.status === 'queued') return;
      if (state.status === 'ready' && !userPrompt) return;
    }

    if (force && alreadyQueued) {
      queueRef.current = queueRef.current.filter(item => item.pageIndex !== pageIndex);
    }

    if (shouldOverride && (state.status === 'generating' || state.status === 'queued')) {
      cancelGeneration(pageIndex);
    }
    const nextGenerationId = (generationCountersRef.current.get(pageIndex) || 0) + 1;
    generationCountersRef.current.set(pageIndex, nextGenerationId);
    updatePageState(pageIndex, {
      status: 'queued',
      error: null,
      stage: 0,
      progress: 0,
      generationId: nextGenerationId,
      ...(shouldOverride ? { videoUrl: null } : {})
    });
    queueRef.current.push({ pageIndex, userPrompt, source, generationId: nextGenerationId });
    pumpQueue();
  }, [pages.length, pumpQueue, updatePageState, cancelGeneration, autoSkipped, promptBusy, promptOpen, promptOverlays]);

  const handlePromptSubmit = useCallback((event) => {
    event.preventDefault();
    const text = promptText.trim();
    if (!text) {
      setPromptOpen(false);
      return;
    }
    if (promptOverlays[currentIndexRef.current]) {
      return;
    }
    stopAllGeneration();
    setAutoMode(false);
    setAutoSkipped(true);
    enqueuePage(currentIndexRef.current, { userPrompt: text, force: true, source: 'prompt' });
    setPromptBusy(true);
    setPromptOpen(false);
    setPromptOverlayForPage(currentIndexRef.current, { text, stage: 0 });
  }, [enqueuePage, promptText, setPromptOverlayForPage, promptOverlays, stopAllGeneration]);

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
        if (!promptOverlays[currentIndexRef.current]) {
          setPromptOpen(prev => {
            const next = !prev;
            if (next) {
              setPromptText('');
            }
            return next;
          });
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
  }, [cancelGeneration, enqueuePage, hasActiveGeneration, isCurrentProcessing, onToggleZoom, promptBusy, promptOverlays]);

  useEffect(() => {
    if (!pages.length) return;
    if (!autoMode) return;
    if (didAutoEnqueueRef.current) return;
    didAutoEnqueueRef.current = true;
    queueRef.current = [];
    pages.forEach((_, idx) => enqueuePage(idx, { source: 'auto' }));
  }, [pages, enqueuePage, autoMode]);

  useEffect(() => {
    if (!autoMode || !pages.length) return;
    const allDone = pageStates.every(state => state.status === 'ready' || state.status === 'failed');
    if (allDone) {
      setAutoMode(false);
      setAutoDone(true);
      setShowVideos(true);
    }
  }, [autoMode, pageStates, pages.length]);

  const handleSkipAuto = useCallback(() => {
    stopAllGeneration();
    setAutoMode(false);
    setAutoSkipped(true);
    setShowVideos(true);
  }, [stopAllGeneration]);

  const handleCancelAuto = useCallback(() => {
    stopAllGeneration();
    setAutoMode(false);
    setAutoSkipped(true);
  }, [stopAllGeneration]);

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
              placeholder={
                currentPromptLocked
                  ? 'Prompt already queued for this page. Scroll to another page.'
                  : 'Type a prompt for the current page and press Enter…'
              }
              readOnly={currentPromptLocked}
              aria-busy={promptBusy || currentPromptLocked}
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
        style={{ '--page-scale': displayZoom / 100, display: autoMode ? 'none' : undefined }}
      >
        {pages.map((page, index) => (
          <PageCard
            key={index}
            page={page}
            pageIndex={index}
            state={pageStates[index] || { status: 'idle', videoUrl: null, error: null }}
            showVideo={showVideos}
            prefetchFn={PREFETCH_ENABLED && !autoSkipped ? generateForPage : null}
            isCurrent={index === currentIndex}
            needsVideo={(pageStates[index]?.status || 'idle') !== 'ready'}
            onVisibilityChange={handleVisibilityChange}
            promptOverlay={promptOverlays[index] || null}
            onCancelPrompt={cancelGeneration}
          />
        ))}
      </div>

      {autoMode && (
        <div className="auto-progress">
          <div className="auto-progress-card">
            <div className="auto-progress-title">Generating Video Versions</div>
            <div className="auto-progress-summary">
              Processed {pageStates.filter(state => state.status === 'ready' || state.status === 'failed').length}
              /{pages.length} pages
            </div>
            <div className="auto-progress-list">
              {pageStates.map((state, index) => {
                const stage = state.stage ?? 0;
                const progressValue = (() => {
                  if (state.status === 'ready') return 1;
                  if (state.status === 'generating') return state.progress ?? 0;
                  return 0;
                })();
                const stageLabel = (() => {
                  if (state.status === 'failed') return 'Failed';
                  if (state.status === 'ready') return 'Done';
                  if (stage <= 0) return 'Queue';
                  if (stage === 1) return 'Upload';
                  if (stage === 2) return 'Analyze';
                  if (stage === 3) return 'Prompt';
                  if (stage === 4) return 'Generate';
                  return 'Queue';
                })();
                return (
                  <div
                    className="auto-progress-row"
                    key={index}
                    style={{ '--progress': `${Math.round(progressValue * 100)}%` }}
                  >
                    <span>Page {index + 1}</span>
                    <span className={`auto-progress-stage stage-${stage}`}>{stageLabel}</span>
                  </div>
                );
              })}
            </div>
            <button type="button" className="auto-progress-skip" onClick={handleSkipAuto}>
              Skip to Pages
            </button>
            <button type="button" className="auto-progress-cancel" onClick={handleCancelAuto}>
              Cancel Generation
            </button>
          </div>
        </div>
      )}

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
              onClick={() => {
                if (currentPromptLocked) return;
                setPromptText('');
                setPromptOpen(true);
              }}
              onMouseEnter={() => setActiveQuickAction('prompt')}
              onFocus={() => setActiveQuickAction('prompt')}
              aria-label="Open prompt (H)"
              title="Prompt (H)"
              data-label="Prompt"
              disabled={currentPromptLocked}
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
