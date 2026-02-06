import React, { useState, useCallback, useRef } from 'react';

export default function PdfUploader({ onPdfLoad }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      onPdfLoad(file);
    }
  }, [onPdfLoad]);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback((e) => {
    const file = e.target.files[0];
    if (file) {
      onPdfLoad(file);
    }
  }, [onPdfLoad]);

  return (
    <div className="pdf-uploader">
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <h2>Drop your manga PDF here</h2>
        <p>or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={handleChange}
        />
      </div>
    </div>
  );
}
