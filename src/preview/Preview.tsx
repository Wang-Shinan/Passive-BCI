import { BrandLogo } from './BrandLogo'
import { Icon } from '../lib/ui/Icon'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ThemeSwitch } from './Theme'
import { usePreviewTheme } from './theme-context'
import { LiveEegBadge } from '../lib/eeg/LiveEegBadge'
import { experiments, smrExperiments, tools, type DirectoryEntry } from './data'

function Entry({ item }: { item: DirectoryEntry }) {
  return (
    <Link className="ed-entry" to={item.path}>
      <div className="ed-entry-heading">
        <h3><Icon name={item.icon} size={19} />{item.name}</h3>
        <Icon className="ed-open" name="right" size={17} />
      </div>
      <p>{item.description}</p>
      <div className="ed-entry-bottom">
        {item.legacy && <span className="ed-legacy">旧版</span>}
        <span>{item.requirement}</span>
      </div>
    </Link>
  )
}

export default function Preview() {
  const [params, setParams] = useSearchParams()
  const group = params.get('group') === 'smr' ? 'smr' : params.get('group') === 'experiments' ? 'experiments' : 'all'
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const { theme } = usePreviewTheme()
  const matches = (item: DirectoryEntry) => `${item.name} ${item.description} ${item.requirement}`.toLowerCase().includes(query.trim().toLowerCase())
  const visibleExperiments = experiments.filter(matches)
  const visibleSmr = smrExperiments.filter(matches)
  const visibleTools = tools.filter(matches)
  const visibleCount = (group !== 'smr' ? visibleExperiments.length : 0) + (group !== 'experiments' ? visibleSmr.length : 0) + (group === 'all' ? visibleTools.length : 0)
  function selectGroup(next: string) {
    setParams(next === 'all' ? {} : { group: next })
    setQuery('')
    setMenuOpen(false)
  }
  return (
    <div className="experiment-directory" data-theme={theme}>
      <aside className={`ed-sidebar ${menuOpen ? 'is-open' : ''}`} aria-label="导航">
        <Link to="/" className="ed-brand" onClick={() => selectGroup('all')} aria-label="全域智能 Passive BCI 实验目录"><BrandLogo /><span className="ed-brand-project">Passive BCI</span></Link>
        <nav>
          <button className={group === 'all' ? 'active' : ''} onClick={() => selectGroup('all')}><Icon name="grid" size={17} />全部入口</button>
          <button className={group === 'experiments' ? 'active' : ''} onClick={() => selectGroup('experiments')}><Icon name="memory" size={17} />实验范式 <small>{experiments.length}</small></button>
          <button className={group === 'smr' ? 'active' : ''} onClick={() => selectGroup('smr')}><Icon name="target" size={17} />光标控制 <small>{smrExperiments.length}</small></button>
          <div className="ed-nav-divider" />
          {tools.map(item => <Link key={item.path} to={item.path}><Icon name={item.icon} size={17} />{item.name}</Link>)}
        </nav>
        <div className="ed-connection"><LiveEegBadge /></div>
      </aside>
      {menuOpen && <button className="ed-backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
      <main className="ed-main" id="main-content">
        <header className="ed-topbar">
          <button className="ed-menu" aria-label="展开导航" onClick={() => setMenuOpen(!menuOpen)}>菜单</button>
          <span className="ed-breadcrumb"><span className="ed-topbar-project">Passive BCI / </span>实验目录</span>
          <div className="ed-topbar-actions">
            <ThemeSwitch />
          </div>
        </header>
        <div className="ed-content">
          <div className="ed-title-row">
            <h1>{group === 'smr' ? '光标控制' : group === 'experiments' ? '实验范式' : '实验与工具'}</h1>
            <input type="search" aria-label="搜索实验与工具" placeholder="搜索名称或功能" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <div className="ed-page-note">点击入口打开完整页面。页面中的开始、录制和训练操作按原有功能执行。</div>
          {group !== 'smr' && visibleExperiments.length > 0 && (
            <section className="ed-section" aria-label="实验范式">
              {group === 'all' && <h2><Icon name="memory" size={17} />实验范式 <small>{visibleExperiments.length}</small></h2>}
              <div className="ed-grid">{visibleExperiments.map(item => <Entry key={item.path} item={item} />)}</div>
            </section>
          )}
          {group !== 'experiments' && visibleSmr.length > 0 && (
            <section className="ed-section" aria-label="光标控制">
              {group === 'all' && <h2><Icon name="target" size={17} />光标控制 <small>{visibleSmr.length}</small></h2>}
              <div className="ed-grid">{visibleSmr.map(item => <Entry key={item.path} item={item} />)}</div>
            </section>
          )}
          {group === 'all' && visibleTools.length > 0 && (
            <section className="ed-section" aria-label="采集与数据工具">
              <h2>采集与数据工具</h2>
              <div className="ed-grid">{visibleTools.map(item => <Entry key={item.path} item={item} />)}</div>
            </section>
          )}
          {visibleCount === 0 && <div className="ed-empty">没有匹配的入口。<button onClick={() => setQuery('')}>清除搜索</button></div>}
        </div>
      </main>
    </div>
  )
}
