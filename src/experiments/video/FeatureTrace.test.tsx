import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FeatureTrace } from './FeatureTrace'

describe('feature trace display', () => {
  it('shows an honest empty state without inventing a signal', () => {
    const html = renderToStaticMarkup(<FeatureTrace history={[]} live={false} />)
    expect(html).toContain('连接 EEG 后显示真实曲线')
    expect(html).not.toContain('stroke-linecap')
  })
  it('renders constant and missing samples without invalid SVG coordinates', () => {
    const history = [4, 4, NaN, 4].map((v, i) => ({ t: i * 200, windowSec: 1, nChannels: 8, values: { focus_score: v } }))
    const html = renderToStaticMarkup(<FeatureTrace history={history} live />)
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(html).toContain('实时窗口')
    expect(html).toContain('4.000')
  })
})
