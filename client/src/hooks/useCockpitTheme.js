import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'cockpit-theme';

export default function useCockpitTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'light'; }
    catch { return 'light'; } // localStorage unavailable (private browsing)
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); }
    catch {} // localStorage unavailable (private browsing)
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  }, []);

  return { theme, toggle, isDark: theme === 'dark' };
}
