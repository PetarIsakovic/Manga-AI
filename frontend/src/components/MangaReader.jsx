import React, { useState, useCallback, useRef, useEffect } from 'react';
import PageCard from './PageCard.jsx';
import { useVideoCache } from '../hooks/useVideoCache.js';
import { generateVideo } from '../utils/api.js';

const PREFETCH_ENABLED = false;

export default function MangaReader({ pages, pdfHash }) {
  const [pageStates, setPageStates] = useState(() =>
    pages.map(() => ({ status: 'idle', videoUrl: null, error: null }))
  );
  const [showVideos, setShowVideos] = useState(true);
  const nextIndexRef = useRef(0);
  const generatingRef = useRef(false);
  const { setVideo } = useVideoCache();

  useEffect(() => {
    setPageStates(pages.map(() => ({ status: 'idle', videoUrl: null, error: null })));
    nextIndexRef.current = 0;
    setShowVideos(true);
  }, [pages]);

  const updatePageState = useCallback((index, update) => {
    setPageStates(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...update };
      return next;
    });
  }, []);

  const generateForPage = useCallback(async (pageIndex) => {
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
      return true;
    } catch (error) {
      console.error('❌ Generation failed:', error);
      updatePageState(pageIndex, { status: 'failed', error: error.message });
      return false;
    }
  }, [pages, pdfHash, setVideo, updatePageState]);

  const generateNextPage = useCallback(() => {
    if (generatingRef.current) return;
    const idx = nextIndexRef.current;
    if (idx >= pages.length) return;

    generatingRef.current = true;
    generateForPage(idx).then(ok => {
      if (ok) {
        nextIndexRef.current = Math.min(idx + 1, pages.length);
      }
      generatingRef.current = false;
    });
  }, [generateForPage, pages.length]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        generateNextPage();
      } else if (key === 'j') {
        event.preventDefault();
        setShowVideos(prev => !prev);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [generateNextPage]);

  return (
    <div className="manga-reader">
      <div className="pages-container">
        {pages.map((page, index) => (
          <PageCard
            key={index}
            page={page}
            pageIndex={index}
            state={pageStates[index] || { status: 'idle', videoUrl: null, error: null }}
            showVideo={showVideos}
            prefetchFn={PREFETCH_ENABLED ? generateForPage : null}
          />
        ))}
      </div>
    </div>
  );
}
