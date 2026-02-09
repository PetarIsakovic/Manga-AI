import React, { useState, useCallback, useEffect } from 'react';
import PdfUploader from './components/PdfUploader.jsx';
import MangaReader from './components/MangaReader.jsx';
import { renderPdfToImages, computePdfHash } from './utils/pdfRenderer.js';
import { checkModels } from './utils/api.js';

export default function App() {
  const [pages, setPages] = useState([]);
  const [pdfHash, setPdfHash] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [modelAccess, setModelAccess] = useState(null);
  const [currentFile, setCurrentFile] = useState(null);
  const [displayZoom, setDisplayZoom] = useState(85); // Display zoom percentage (50-150)
  const [showZoomControl, setShowZoomControl] = useState(false);
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    // Check model access on mount
    checkModels()
      .then(data => {
        console.log('Model access check:', data);
        setModelAccess(data);
        if (!data.hasVeoAccess) {
          setError('⚠️ Your API key does not have Veo access yet. Available models: ' + data.totalModels);
        }
      })
      .catch(err => console.error('Failed to check models:', err));
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        setShowZoomControl(prev => !prev);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handlePdfLoad = useCallback(async (file) => {
    setLoading(true);
    setError(null);
    setCurrentFile(file);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const hash = await computePdfHash(arrayBuffer);
      setPdfHash(hash);
      
      // Always render at high resolution (scale 2) for quality
      const renderedPages = await renderPdfToImages(arrayBuffer, { scale: 2 });
      setPages(renderedPages);
    } catch (err) {
      setPages([]);
      setPdfHash(null);
      setCurrentFile(null);
      setError('Completed.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleGoHome = useCallback(() => {
    setPages([]);
    setPdfHash(null);
    setCurrentFile(null);
    setShowZoomControl(false);
    setError(null);
    setLoading(false);
  }, []);

  const showHeader = (modelAccess && !modelAccess.hasVeoAccess) || pages.length > 0;

  return (
    <div className="app">
      {showHeader && (
        <header className="app-header minimal">
          {modelAccess && !modelAccess.hasVeoAccess && (
            <div style={{ 
              background: '#ff4444', 
              color: 'white', 
              padding: '0.4rem 0.75rem', 
              borderRadius: '999px',
              fontSize: '0.75rem'
            }}>
              ⚠️ No Veo Access
            </div>
          )}
          {pages.length > 0 && showZoomControl && null}
        </header>
      )}
      
      {error && <div className="error-banner">{error}</div>}
      
      {loading && (
        <div className="loading-overlay">
          <div className="spinner" />
          <p>Loading PDF...</p>
        </div>
      )}
      
      {pages.length === 0 && !loading ? (
        <PdfUploader onPdfLoad={handlePdfLoad} />
      ) : (
        <MangaReader
          pages={pages}
          pdfHash={pdfHash}
          displayZoom={displayZoom}
          showZoomControl={showZoomControl}
          onZoomChange={(value) => setDisplayZoom(value)}
          onToggleZoom={() => setShowZoomControl(prev => !prev)}
          theme={theme}
          onToggleTheme={() => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))}
          onGoHome={handleGoHome}
        />
      )}
    </div>
  );
}
