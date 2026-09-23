import { createContext, useContext } from 'react'

export type PreviewTheme = 'light' | 'dark'
export const ThemeContext = createContext<{ theme: PreviewTheme; selectTheme: (theme: PreviewTheme) => void } | null>(null)

export function usePreviewTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('Preview theme requires PreviewThemeProvider')
  return value
}
