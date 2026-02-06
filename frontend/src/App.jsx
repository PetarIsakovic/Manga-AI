import React, { useState, useCallback, useEffect } from 'react';
import PdfUploader from './components/PdfUploader.jsx';
import MangaReader from './components/MangaReader.jsx';
import { renderPdfToImages, computePdfHash } from './utils/pdfRenderer.js';
import { checkHealth } from './utils/api.js';

export default function App() {
  const [pages, setPages] = useState([]);
  const [pdfHash, setPdfHash] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [modelAccess, setModelAccess] = useState(null);

  useEffect(() => {
    // Check model access on mount
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        console.log('Model access check:', data);
        setModelAccess(data);
        if (!data.hasVeoAccess) {
          setError('⚠️ Your API key does not have Veo access yet. Available models: ' + data.totalModels);
        }
      })
      .catch(err => console.error('Failed to check models:', err));
  }, []);

  const handlePdfLoad = useCallback(async (file) => {
    setLoading(true);
    setError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const hash = await computePdfHash(arrayBuffer);
      setPdfHash(hash);
      
      const renderedPages = await renderPdfToImages(arrayBuffer);
      setPages(renderedPages);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleReset = useCallback(() => {
    setPages([]);
    setPdfHash(null);
    setError(null);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Manga Veo Reader</h1>
        {modelAccess && !modelAccess.hasVeoAccess && (
          <div style={{ 
            background: '#ff4444', 
            color: 'white', 
            padding: '0.5rem 1rem', 
            borderRadius: '6px',
            fontSize: '0.875rem',
            marginLeft: '1rem'
          }}>
            ⚠️ No Veo Access - Request at aistudio.google.com
          </div>
        )}
        {pages.length > 0 && (
          <button onClick={handleReset} className="reset-btn">
            Load New PDF
          </button>
        )}
      </header>
      
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
        <MangaReader pages={pages} pdfHash={pdfHash} />
      )}
    </div>
  );
}
