import * as T from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

export const material = (color: string) => new T.MeshStandardMaterial({ color, roughness: 0.88 })
export type Surface = T.Material

export function mesh(parent: T.Object3D, geometry: T.BufferGeometry, surface: Surface, x: number, y: number, z: number) {
  const m = new T.Mesh(geometry, surface)
  m.position.set(x, y, z)
  m.castShadow = m.receiveShadow = true
  parent.add(m)
  return m
}

function box(parent: T.Object3D, w: number, h: number, d: number, mat: Surface, x: number, y: number, z: number, radius = 0) {
  return mesh(parent, radius ? new RoundedBoxGeometry(w, h, d, 3, radius) : new T.BoxGeometry(w, h, d), mat, x, y, z)
}

export function oval(parent: T.Object3D, mat: Surface, x: number, y: number, z: number, w: number, h: number, d: number) {
  const m = mesh(parent, new T.SphereGeometry(1, 28, 18), mat, x, y, z)
  m.scale.set(w, h, d)
  return m
}

function texture(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  paint(canvas.getContext('2d')!)
  const map = new T.CanvasTexture(canvas)
  map.colorSpace = T.SRGBColorSpace
  return map
}

function randomSeed(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
}

function weave(color: string, x: number, y: number) {
  const map = texture(96, 96, ctx => {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 96, 96)
    const rand = randomSeed(45)
    for (let i = 0; i < 96; i += 2) {
      ctx.fillStyle = 'rgba(255,250,225,' + (0.05 + rand() * 0.12) + ')'
      ctx.fillRect(i, 0, 1, 96)
      ctx.fillStyle = 'rgba(25,24,20,0.13)'
      ctx.fillRect(0, i, 96, 1)
    }
  })
  map.wrapS = map.wrapT = T.RepeatWrapping
  map.repeat.set(x, y)
  map.anisotropy = 4
  return new T.MeshStandardMaterial({ map, roughness: 1 })
}

// A painted landscape beyond the window keeps the horizon still during a cue.
function landscape() {
  const w = 1600, h = 640
  const map = texture(w, h, ctx => {
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#94bbbc')
    sky.addColorStop(0.52, '#f7e9c7')
    sky.addColorStop(0.65, '#acccbb')
    sky.addColorStop(1, '#668f8e')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#fff3c3'
    ctx.beginPath()
    ctx.arc(1020, 205, 37, 0, 2 * Math.PI)
    ctx.fill()
    const rand = randomSeed(18)
    function ridge(base: number, amplitude: number, shift: number, color: string) {
      ctx.beginPath()
      ctx.moveTo(0, h)
      for (let x = 0; x <= w; x += 4) {
        const y = base + amplitude * (0.56 * Math.sin(x / 116 + shift) + 0.31 * Math.sin(x / 58 + shift) + 0.13 * Math.sin(x / 22)) + rand() * 2
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w, h)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    ridge(284, 72, 1, '#c3c9b5')
    ridge(325, 54, 3.6, '#97b3a6')
    ridge(352, 37, 1.8, '#749b90')
    const lake = ctx.createLinearGradient(0, 366, 0, h)
    lake.addColorStop(0, '#c3d1ba')
    lake.addColorStop(1, '#739d97')
    ctx.fillStyle = lake
    ctx.fillRect(0, 368, w, h)
    ctx.fillStyle = 'rgba(248,241,198,.32)'
    for (let i = 0; i < 650; i++) ctx.fillRect(rand() * w, 368 + rand() * 265, 2 + rand() * 32, 1)
    const shore = (x: number) => 518 + 64 * Math.sin(x / 390) + 22 * Math.sin(x / 113)
    ctx.fillStyle = '#627e6c'
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, shore(x))
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill()
    for (let x = 0; x < w; x += 2 + rand() * 5) {
      const y = shore(x) + 4, size = 4 + rand() * 17
      ctx.fillStyle = rand() < 0.32 ? '#738b75' : '#627e6c'
      ctx.beginPath()
      ctx.moveTo(x, y - size)
      ctx.lineTo(x + size * 0.28, y + 2)
      ctx.lineTo(x - size * 0.28, y + 2)
      ctx.fill()
    }
  })
  return new T.MeshBasicMaterial({ map, toneMapped: false })
}

function plant(parent: T.Object3D, x: number, z: number) {
  const clay = material('#ae7353'), soil = material('#413429'), stem = material('#606343')
  const greens = ['#4d7056', '#637e59', '#819367'].map(material)
  mesh(parent, new T.CylinderGeometry(0.22, 0.14, 0.38, 48), clay, x, 0.20, z)
  mesh(parent, new T.CylinderGeometry(0.205, 0.205, 0.013, 40), soil, x, 0.392, z)
  const rand = randomSeed(23)
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4, height = 0.60 + rand() * 0.55
    const tip = new T.Vector3(x + 0.23 * Math.cos(a), 0.39 + height, z + 0.23 * Math.sin(a))
    const curve = new T.QuadraticBezierCurve3(new T.Vector3(x, 0.38, z), new T.Vector3(x, 0.38 + height * 0.70, z), tip)
    mesh(parent, new T.TubeGeometry(curve, 10, 0.006, 6, false), stem, 0, 0, 0)
    for (let j = 0; j < 5; j++) {
      const p = curve.getPoint(0.35 + j * 0.15)
      const yaw = a + j * 2.5
      const leaf = oval(parent, greens[(i + j) % 3], p.x + 0.09 * Math.sin(yaw), p.y + 0.044, p.z + 0.09 * Math.cos(yaw), 0.053, 0.012, 0.122)
      leaf.rotation.order = 'YXZ'
      leaf.rotation.set(-0.40, yaw, 0.16)
    }
  }
}

export function furnish(scene: T.Scene) {
  const wall = material('#e5d9c0'), oak = material('#b7875d'), walnut = material('#805b40'), trim = material('#ded0b5')
  const rand = randomSeed(77)
  const woodgrain = texture(256, 128, ctx => {
    ctx.fillStyle = '#c8a580'
    ctx.fillRect(0, 0, 256, 128)
    for (let i = 0; i < 420; i++) {
      ctx.strokeStyle = 'rgba(103,69,40,' + (0.03 + rand() * 0.11) + ')'
      const x = rand() * 256, y = rand() * 128
      ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + 14, y + 1, x + 34, y - 1, x + 54, y); ctx.stroke()
    }
  })
  const planks = [0xffffff, 0xf5eddf, 0xf8f3eb].map(color => new T.MeshStandardMaterial({ color, map: woodgrain, roughness: 0.8 }))
  box(scene, 8, 0.08, 8, walnut, 0, -0.055, 0)
  for (let row = 0; row < 32; row++) {
    for (let col = -2; col <= 2; col++) {
      box(scene, 1.996, 0.025, 0.247, planks[Math.floor(rand() * 3)], col * 2 + row % 3 * 0.51, -0.014, -3.9 + row * 0.25)
    }
  }
  const back = -2.85
  box(scene, 8, 0.63, 0.14, wall, 0, 0.315, back)
  box(scene, 8, 0.9, 0.14, wall, 0, 2.99, back)
  box(scene, 3.1, 3, 0.15, wall, 2.52, 1.5, back)
  box(scene, 0.9, 3, 0.15, wall, -3.4, 1.5, back)
  box(scene, 0.1, 3.2, 7, wall, 3.02, 1.6, 0)
  box(scene, 8, 0.09, 0.08, trim, 0, 0.05, back + 0.1)
  const view = mesh(scene, new T.PlaneGeometry(5.8, 2.55), landscape(), -0.92, 1.52, back - 0.4)
  view.castShadow = view.receiveShadow = false
  for (const x of [-2.95, -1.63, -0.33, 0.97]) box(scene, 0.052, 1.97, 0.13, oak, x, 1.59, back + 0.05)
  box(scene, 4.03, 0.07, 0.30, oak, -0.99, 0.63, back + 0.10, 0.018)
  box(scene, 3.96, 0.05, 0.10, oak, -0.99, 2.54, back)

  const rug = weave('#a99b7c', 13, 10), stripe = material('#726e57')
  box(scene, 2.55, 0.02, 2.65, rug, 0, 0.008, -0.68, 0.008)
  for (const x of [-1.22, -1.19, 1.19, 1.22]) box(scene, 0.008, 0.002, 2.59, stripe, x, 0.020, -0.68)
  for (const z of [-1.95, -1.915, 0.55, 0.585]) box(scene, 2.43, 0.002, 0.009, stripe, 0, 0.020, z)
  const shade = texture(96, 96, ctx => {
    const fade = ctx.createRadialGradient(48, 48, 0, 48, 48, 47)
    fade.addColorStop(0, 'rgba(45,35,25,.40)')
    fade.addColorStop(0.47, 'rgba(45,35,25,.20)')
    fade.addColorStop(1, 'rgba(45,35,25,0)')
    ctx.fillStyle = fade; ctx.fillRect(0, 0, 96, 96)
  })
  const shadow = new T.MeshBasicMaterial({ map: shade, transparent: true, depthWrite: false })
  for (const [x, z, w, d] of [[-1.21, -1.82, 0.59, 0.47], [1.47, -2.33, 1.99, 0.68], [0, 0.17, 1.09, 1.45]]) {
    const contact = mesh(scene, new T.PlaneGeometry(w, d), shadow, x, 0.022, z)
    contact.rotation.x = -Math.PI / 2
    contact.castShadow = contact.receiveShadow = false
  }
  plant(scene, -1.21, -1.82)

  // A slatted credenza, books and a mushroom lamp give scale to the seated view.
  box(scene, 1.56, 0.41, 0.43, walnut, 1.47, 0.42, -2.33, 0.025)
  for (let i = 0; i < 37; i++) box(scene, 0.026, 0.36, 0.036, oak, 0.744 + i * 0.0404, 0.42, -2.108, 0.008)
  for (const x of [0.83, 2.11]) for (const z of [-2.48, -2.20]) box(scene, 0.048, 0.23, 0.048, walnut, x, 0.115, z)
  box(scene, 1.59, 0.043, 0.46, oak, 1.47, 0.646, -2.33, 0.014)
  const books = ['#385954', '#cbbf99', '#ab6446'].map(material)
  books.forEach((mat, i) => { box(scene, 0.34 - i * 0.023, 0.037, 0.21, mat, 0.99, 0.686 + i * 0.040, -2.28).rotation.y = 0.04 * i })
  mesh(scene, new T.CylinderGeometry(0.048, 0.082, 0.23, 40), material('#8b7052'), 1.74, 0.79, -2.33)
  mesh(scene, new T.SphereGeometry(0.215, 40, 20, 0, 2 * Math.PI, 0, Math.PI / 2), material('#eed4a5'), 1.74, 0.89, -2.33)

  const cushion = weave('#667a6a', 4, 7)
  box(scene, 0.82, 0.18, 0.92, cushion, 0, 0.36, 0.25, 0.075)
  box(scene, 0.84, 0.78, 0.15, cushion, 0, 0.75, 0.64, 0.065)
  for (const side of [-1, 1]) {
    const x = side * 0.36
    for (const z of [-0.25, 0.52]) box(scene, 0.058, 0.57, 0.065, walnut, x, 0.31, z, 0.018)
    box(scene, 0.154, 0.058, 0.90, oak, x, 0.605, 0.13, 0.026)
    box(scene, 0.144, 0.065, 0.79, cushion, x, 0.654, 0.15, 0.03)
  }
}
