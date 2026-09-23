import { BrandLogo } from './BrandLogo'
import { Icon } from '../lib/ui/Icon'
import { useLocation } from 'react-router-dom'
import { useLayoutEffect, useState, type ReactNode } from 'react'

import { ThemeContext, usePreviewTheme, type PreviewTheme } from './theme-context'

// Preserve the preference saved by the initial directory preview.
const THEME_KEY = 'passive-bci.preview.directory-theme'

function loadTheme(): PreviewTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function PreviewThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<PreviewTheme>(loadTheme)
  useLayoutEffect(() => {
    document.documentElement.dataset.previewTheme = theme
    return () => { delete document.documentElement.dataset.previewTheme }
  }, [theme])
  function selectTheme(next: PreviewTheme) {
    setTheme(next)
    try { localStorage.setItem(THEME_KEY, next) } catch { /* Switching still works without storage. */ }
  }
  return <ThemeContext.Provider value={{ theme, selectTheme }}>{children}</ThemeContext.Provider>
}

export function ThemeSwitch() {
  const { theme, selectTheme } = usePreviewTheme()
  return (
    <div className="preview-theme-switch" role="group" aria-label="配色模式">
      <button type="button" aria-pressed={theme === 'light'} onClick={() => selectTheme('light')}><Icon name="sun" size={13} />亮色</button>
      <button type="button" aria-pressed={theme === 'dark'} onClick={() => selectTheme('dark')}><Icon name="moon" size={13} />深色</button>
    </div>
  )
}

export function ExperimentThemeBar() {
  const { pathname } = useLocation()
  if (pathname === '/') return null
  return (
    <div className="preview-theme-bar" aria-label="实验页面配色">
      <a href="#/" className="preview-brand-home" aria-label="全域智能：返回实验目录"><BrandLogo /><span className="preview-brand-label"><Icon name="left" size={15} />实验目录</span></a>
      <ThemeSwitch />
    </div>
  )
}
