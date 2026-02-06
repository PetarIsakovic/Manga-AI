import { useState, useEffect } from 'react';

export function useIntersectionObserver(ref, options = {}) {
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const visibleObserver = new IntersectionObserver(
      ([entry]) => setIsIntersecting(entry.isIntersecting),
      { threshold: options.threshold || 0.3 }
    );

    const prefetchObserver = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry.isIntersecting),
      { rootMargin: options.rootMargin || '100% 0px' }
    );

    visibleObserver.observe(element);
    prefetchObserver.observe(element);

    return () => {
      visibleObserver.disconnect();
      prefetchObserver.disconnect();
    };
  }, [ref, options.threshold, options.rootMargin]);

  return { isIntersecting, isNearViewport };
}
