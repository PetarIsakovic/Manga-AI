import React, { useState, useCallback, useRef } from 'react';
import PageCard from './PageCard.jsx';
import { useVideoCache } from '../hooks/useVideoCache.js';
import { generateVideo } from '../utils/api.js';

const MAX_CONCURRENT = 1;
const PREFETCH_ENABLED = false;

export default function MangaReader({ pages, pdfHash }) {
  const [pageStates, setPageStates] = useState(() =>
    pages.map(() => ({ status: 'idle', videoUrl: null, error: null }))
  );
  const [generatingAll, setGeneratingAll] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const abortRef = useRef(false);
  const { getVideo, setVideo } = useVideoCache();

  const updatePageState = useCallback((index, update) => {
    setPageStates(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...update };
      return next;
    });
  }, []);

  const generateForPage = useCallback(async (pageIndex, force = false) => {
    const page = pages[pageIndex];
    const cacheKey = `${pdfHash}-${pageIndex}-${Date.now()}`;
    
    // NEVER use cache - always generate fresh
    updatePageState(pageIndex, { status: 'generating', error: null });
    
    try {
      console.log('🎬 Requesting NEW video generation for page', pageIndex);
      const result = await generateVideo(page.imageBase64, page.mimeType, page.aspectRatio);
      
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
    } catch (error) {
      console.error('❌ Generation failed:', error);
      updatePageState(pageIndex, { status: 'failed', error: error.message });
    }
  }, [pages, pdfHash, setVideo, updatePageState]);

  const generateAll = useCallback(async () => {
    if (generatingAll) {
      abortRef.current = true;
      return;
    }
    
    abortRef.current = false;
    setGeneratingAll(true);
    
    const pending = pages
      .map((_, i) => i)
      .filter(i => pageStates[i].status !== 'ready');
    
    setProgress({ current: 0, total: pending.length });
    
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT) {
      if (abortRef.current) break;
      
      const batch = pending.slice(i, i + MAX_CONCURRENT);
      await Promise.all(batch.map(idx => generateForPage(idx)));
      setProgress(p => ({ ...p, current: Math.min(p.current + batch.length, p.total) }));
    }
    
    setGeneratingAll(false);
  }, [generatingAll, pages, pageStates, generateForPage]);

  const readyCount = pageStates.filter(s => s.status === 'ready').length;

  return (
    <div className="manga-reader">
      <div className="reader-controls">
        <button
          className="generate-all-btn"
          onClick={generateAll}
          disabled={readyCount === pages.length}
        >
          {generatingAll ? 'Stop' : 'Generate All Pages'}
        </button>
        <span className="progress-info">
          {readyCount} / {pages.length} ready
          {generatingAll && ` (${progress.current}/${progress.total})`}
        </span>
      </div>
      
      <div className="pages-container">
        {pages.map((page, index) => (
          <PageCard
            key={index}
            page={page}
            pageIndex={index}
            state={pageStates[index] || { status: 'idle', videoUrl: null, error: null }}
            onGenerate={() => generateForPage(index)}
            onRegenerate={() => generateForPage(index, true)}
            prefetchFn={PREFETCH_ENABLED ? generateForPage : null}
          />
        ))}
      </div>
    </div>
  );
}
