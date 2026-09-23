import type { CSSProperties } from 'react'

// Small monochrome UI symbols; labels carry the meaning for assistive technology.
const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  memory: 'M4 5h11v14H4zM8 2h11v14M7 15l3-7 3 7M8 12h4',
  blocks: 'M9 3h6v6H9zM3 9h6v6H3zM9 9h6v6H9zM15 9h6v6h-6z',
  graph: 'M6 6l12 1M6 6l5 12M18 7l-7 11M3 3h6v6H3zM15 4h6v6h-6zM8 15h6v6H8z',
  cards: 'M6 6h13v15H6zM3 16V3h13M12.5 10l3 3.5-3 3.5-3-3.5z',
  jump: 'M3 20h7M14 12h7M6 16V9a5 5 0 0 1 10 0M13 6l3 3 3-3',
  pen: 'M4 16l-1 5 5-1L20 8l-4-4zM13 7l4 4',
  run: 'M14 3h3v3h-3zM6 10l5-3 5 4h4M11 7l-2 7 5 3 1 5M9 14l-4 6H2',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16',
  vertical: 'M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5',
  cursor: 'M4 3l6 18 3-7 7-3z',
  calibrate: 'M4 4v16M12 4v16M20 4v16M1 8h6M9 16h6M17 10h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  signal: 'M2 12h4l3-8 5 16 3-8h5',
  database: 'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',
  training: 'M4 20V4M4 20h17M7 16l4-5 4 2 5-8',
  learn: 'M4 9V4h5M4 4l5 5M20 15v5h-5M20 20l-5-5M8 3a9 9 0 0 1 13 9M16 21A9 9 0 0 1 3 12',
  external: 'M14 3h7v7M21 3l-10 10M10 4H4v16h16v-6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11',
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  pause: 'M7 4v16M17 4v16',
  play: 'M7 4l13 8-13 8z',
  reset: 'M4 10a8 8 0 1 1 1 8M4 4v6h6',
  focus: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
  panelLeft: 'M3 4h18v16H3zM9 4v16',
  panelRight: 'M3 4h18v16H3zM15 4v16',
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} style={{ flexShrink: 0, ...style }}><path d={paths[name]} /></svg>
}
