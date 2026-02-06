import { openDB } from 'idb';
import { useCallback, useRef } from 'react';

const DB_NAME = 'manga-veo-cache';
const STORE_NAME = 'videos';

async function getDb() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });
}

export function useVideoCache() {
  const dbRef = useRef(null);

  const ensureDb = useCallback(async () => {
    if (!dbRef.current) {
      dbRef.current = await getDb();
    }
    return dbRef.current;
  }, []);

  const getVideo = useCallback(async (key) => {
    try {
      const db = await ensureDb();
      const data = await db.get(STORE_NAME, key);
      if (data?.blob) {
        return URL.createObjectURL(data.blob);
      }
      return null;
    } catch {
      return null;
    }
  }, [ensureDb]);

  const setVideo = useCallback(async (key, videoUrl) => {
    try {
      const db = await ensureDb();
      
      // If it's already a blob URL, fetch and store the blob
      if (videoUrl.startsWith('blob:')) {
        const response = await fetch(videoUrl);
        const blob = await response.blob();
        await db.put(STORE_NAME, { blob, timestamp: Date.now() }, key);
      } else {
        // If it's a remote URL, fetch and store
        const response = await fetch(videoUrl);
        const blob = await response.blob();
        await db.put(STORE_NAME, { blob, timestamp: Date.now() }, key);
      }
    } catch (error) {
      console.error('Failed to cache video:', error);
    }
  }, [ensureDb]);

  const clearCache = useCallback(async () => {
    try {
      const db = await ensureDb();
      await db.clear(STORE_NAME);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }, [ensureDb]);

  return { getVideo, setVideo, clearCache };
}
