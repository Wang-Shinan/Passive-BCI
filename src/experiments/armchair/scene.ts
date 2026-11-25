import * as T from 'three'
import { furnish } from './studio'
import { seatedFigure } from './seatedFigure'
import { mouthStudy } from './mouthStudy'
import { previewMouth } from './previewMouth'
import { depthFocus } from './depthFocus'
import type { PreviewTask } from './tasks'

export function mountStudio(canvas: HTMLCanvasElement, hands: { left: T.Group; right: T.Group }, mouthModel?: T.Group) {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = T.PCFSoftShadowMap
  renderer.toneMapping = T.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.02
  const scene = new T.Scene()
  scene.background = new T.Color('#e1d8c2')
  const camera = new T.PerspectiveCamera(65, 1, 0.025, 18)
  camera.position.set(0, 1.235, 0.445)
  camera.lookAt(0, 0.73, -0.61)
  scene.add(camera)
  const inset = new T.Group()
  inset.matrixAutoUpdate = false
  camera.add(inset)
  const mouth = mouthModel ? previewMouth(inset, mouthModel) : mouthStudy(inset)
  scene.add(new T.HemisphereLight('#ffefd7', '#bfa58c', 1.55))
  const sun = new T.DirectionalLight('#fff0d2', 2.35)
  sun.position.set(-2.6, 3.6, -3.8)
  sun.target.position.set(0.24, 0.23, -0.28)
  sun.castShadow = true
  Object.assign(sun.shadow.camera, { left: -3.2, right: 3.2, top: 3.0, bottom: -3.0, near: 0.5, far: 11 })
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.normalBias = 0.009
  sun.shadow.bias = -0.00022
  scene.add(sun, sun.target)
  const fill = new T.DirectionalLight('#dde8e5', 0.58)
  fill.position.set(1, 2, 1)
  scene.add(fill)
  furnish(scene)
  const pose = seatedFigure(scene, hands)
  pose('left', 0, 0)
  const focus = depthFocus(renderer, scene, camera)
  // x is the look-at height, y the camera's fore/aft position, z the zoom.
  const view = new T.Vector3(0.73, 0.445, 1), desired = view.clone()
  let farFocus = 0, reveal = 0
  let mouthView: PreviewTask = 'jaw'
  function paint() {
    camera.position.z = view.y
    camera.zoom = view.z
    camera.lookAt(0, view.x, -0.61)
    camera.updateProjectionMatrix()
    // Shift the inset in projected space so portrait framing still presents
    // the front of the teeth, even high above the main camera's optical axis.
    const insetScale = T.MathUtils.clamp(1 / camera.aspect, 1, 1.5)
    const shift = Math.tan(T.MathUtils.degToRad(camera.getEffectiveFOV() / 2)) * T.MathUtils.lerp(2.2, 0.50, reveal)
    inset.matrix.set(insetScale, 0, 0, 0, 0, insetScale, -shift, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    inset.matrixWorldNeedsUpdate = true
    inset.visible = reveal > 0
    focus.render(farFocus)
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = T.MathUtils.radToDeg(2 * Math.atan(Math.max(Math.tan(T.MathUtils.degToRad(65 / 2)), 0.78 / camera.aspect)))
    focus.resize(w, h)
    paint()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()
  let lastTask: PreviewTask = 'left', lastMotion = 0, lastGlow = 0
  return {
    draw(task: PreviewTask, motion: number, glow: number, relaxing: boolean, dt: number) {
      if (relaxing) desired.set(1.06, 0.445, 1)
      else if (task === 'feet') desired.set(0.03, 0.10, 1.3)
      else desired.set(0.73, 0.445, 1)
      const wantMouth = !relaxing && (task === 'jaw' || task === 'tongue')
      if (reveal === 0 && wantMouth) mouthView = task
      const toReveal = Number(wantMouth && task === mouthView)
      const toFar = Number(relaxing)
      if (task === lastTask && motion === lastMotion && glow === lastGlow &&
          view.equals(desired) && farFocus === toFar && reveal === toReveal) return
      const blend = 1 - Math.exp(-4.5 * dt)
      view.lerp(desired, blend)
      if (view.distanceToSquared(desired) < 0.000001) view.copy(desired)
      farFocus = T.MathUtils.lerp(farFocus, toFar, blend)
      if (Math.abs(toFar - farFocus) < 0.001) farFocus = toFar
      reveal = T.MathUtils.lerp(reveal, toReveal, 1 - Math.exp(-7 * dt))
      if (Math.abs(toReveal - reveal) < 0.003) reveal = toReveal
      lastTask = task
      lastMotion = motion
      lastGlow = glow
      pose(task, motion, glow)
      mouth(mouthView, task === mouthView ? motion : 0, task === mouthView ? glow : 0)
      paint()
    },
    dispose() {
      observer.disconnect()
      const mats = new Set<T.Material>(), textures = new Set<T.Texture>()
      scene.traverse(object => {
        if (!(object instanceof T.Mesh)) return
        if (object instanceof T.SkinnedMesh) object.skeleton.dispose()
        object.geometry.dispose()
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) mats.add(mat)
      })
      for (const mat of mats) {
        for (const value of Object.values(mat)) if (value instanceof T.Texture) textures.add(value)
        mat.dispose()
      }
      for (const map of textures) map.dispose()
      sun.shadow.dispose()
      focus.dispose()
      renderer.dispose()
    },
  }
}
