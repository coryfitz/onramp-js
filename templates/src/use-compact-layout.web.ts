import { useEffect, useState } from 'react';

function isViewportCompact(breakpoint: number) {
  return window.innerWidth < breakpoint;
}

export function useCompactLayout(breakpoint = 760) {
  const [isCompact, setIsCompact] = useState(() => isViewportCompact(breakpoint));

  useEffect(() => {
    function updateLayout() {
      setIsCompact(isViewportCompact(breakpoint));
    }

    window.addEventListener('resize', updateLayout);
    return () => window.removeEventListener('resize', updateLayout);
  }, [breakpoint]);

  return isCompact;
}
