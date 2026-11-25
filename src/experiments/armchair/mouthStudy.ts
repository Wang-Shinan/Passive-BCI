import * as T from 'three'
import { material, mesh, oval } from './studio'
import type { PreviewTask } from './tasks'

// Show the fixed upper palate and the tongue in profile, with the incisors on the right.
function palateStudy(parent: T.Group) {
  const section = new T.Group()
  parent.add(section)
  const roof = (x: number) => 0.43 - 0.28 * ((x + 0.07) / 0.77) ** 2
  const palate = new T.Shape()
  palate.moveTo(-0.73, roof(-0.73))
  for (let i = 1; i <= 48; i++) {
    const x = -0.73 + 1.41 * i / 48
    palate.lineTo(x, roof(x))
  }
  palate.quadraticCurveTo(0.77, 0.46, 0.46, 0.59)
  palate.bezierCurveTo(0.1, 0.75, -0.61, 0.69, -0.73, roof(-0.73))
  mesh(section, new T.ShapeGeometry(palate), material('#d89582'), 0, 0, 0.07)
  const enamel = material('#f8ead4')
  oval(section, enamel, 0.68, 0.13, 0.085, 0.066, 0.15, 0.038)
  oval(section, enamel, 0.65, -0.28, 0.085, 0.057, 0.12, 0.038)
  const gum = material('#b66d64')
  oval(section, gum, 0.47, -0.44, 0.045, 0.255, 0.122, 0.05)

  const rest: number[] = [], contact: number[] = [], triangles: number[] = []
  const columns = 60, rows = 12
  for (let i = 0; i <= columns; i++) {
    const t = i / columns, x = -0.74 + 1.28 * t
    const radius = Math.sin(Math.PI * t) ** 0.58
    const bottom = -0.26 - 0.26 * radius
    const surface = bottom + radius * (0.65 - 0.17 * t)
    const rise = T.MathUtils.smoothstep(x, -0.38, 0.40) * (roof(x) - surface)
    for (let j = 0; j <= rows; j++) {
      const fraction = j / rows
      const y = T.MathUtils.lerp(bottom, surface, fraction)
      const z = 0.12 + 0.065 * radius * Math.sin(Math.PI * fraction)
      rest.push(x, y, z)
      contact.push(x, y + rise * (1 - radius * 0.35 * (1 - fraction)), z)
      if (i && j) {
        const k = i * (rows + 1) + j
        triangles.push(k - rows - 2, k - 1, k, k - rows - 2, k, k - rows - 1)
      }
    }
  }
  const geometry = new T.BufferGeometry()
  geometry.setAttribute('position', new T.Float32BufferAttribute(rest, 3))
  geometry.setIndex(triangles)
  geometry.computeVertexNormals()
  geometry.morphAttributes.position = [new T.Float32BufferAttribute(contact, 3)]
  const tissue = material('#cf7381')
  tissue.emissive.set('#ff3046')
  const tongue = mesh(section, geometry, tissue, 0, 0, 0)
  return (visible: boolean, lift: number, glow: number) => {
    section.visible = visible
    tongue.morphTargetInfluences![0] = lift
    tissue.emissiveIntensity = glow
  }
}

export function mouthStudy(parent: T.Group) {
  const study = new T.Group()
  parent.add(study)
  study.position.set(0, 0.05, -0.8)
  study.scale.setScalar(0.18)
  const disc = (radius: number, z: number, color: string) =>
    mesh(study, new T.CircleGeometry(radius, 96), new T.MeshBasicMaterial({ color }), 0, 0, z)
  disc(1.015, -0.04, '#e3d2ab')
  disc(1, -0.036, '#35473f')
  const profile = palateStudy(study)
  const front = new T.Group()
  study.add(front)
  const cavity = material('#4b232a'), tooth = material('#eee0ca')
  const opening = oval(front, cavity, 0, 0.04, 0.015, 0.76, 0.43, 0.07)
  const mandible = new T.Group()
  const lowerTeeth = new T.Group()
  front.add(mandible)
  mandible.add(lowerTeeth)
  function lip(upper: boolean) {
    const vertices: number[] = [], indices: number[] = []
    const slices = 64, rows = 9
    for (let i = 0; i <= slices; i++) {
      const x = 2 * i / slices - 1
      const arch = Math.sqrt(Math.max(0, 1 - x * x))
      const inside = upper ? 0.25 : -0.27
      const outside = upper ? 0.46 - 0.07 * Math.exp(-50 * x * x) : -0.46
      for (let j = 0; j <= rows; j++) {
        const u = j / rows
        vertices.push(x * 0.81, 0.04 + arch * T.MathUtils.lerp(inside, outside, u),
          0.09 + arch * (0.04 + 0.12 * Math.sin(Math.PI * u)))
        if (i && j) {
          const k = i * (rows + 1) + j
          indices.push(k, k - 1, k - rows - 1, k - 1, k - rows - 2, k - rows - 1)
        }
      }
    }
    const g = new T.BufferGeometry()
    g.setAttribute('position', new T.Float32BufferAttribute(vertices, 3))
    g.setIndex(upper ? indices : indices.reverse())
    g.computeVertexNormals()
    const m = material(upper ? '#ac6058' : '#cb8072')
    m.side = T.DoubleSide
    mesh(upper ? front : mandible, g, m, 0, 0, 0)
  }
  for (let i = -3; i <= 3; i++) {
    const x = i * 0.153
    oval(front, tooth, x, 0.299 - 0.14 * x * x, 0.091, 0.086, 0.119, 0.032)
    oval(lowerTeeth, tooth, x * 0.95, -0.176 + 0.035 * x * x, 0.094, 0.077, 0.104, 0.030)
  }
  lip(true); lip(false)
  const muscle = material('#b57a68')
  muscle.emissive.set('#ff3046')
  const cheeks = new T.Group()
  front.add(cheeks)
  for (const side of [-1, 1]) {
    const cheek = oval(cheeks, muscle, side * 0.80, -0.19, 0.04, 0.10, 0.22, 0.066)
    cheek.rotation.z = -side * 0.2
  }
  study.traverse(node => { node.castShadow = node.receiveShadow = false })
  study.visible = false
  return (task: PreviewTask, extension: number, glow: number) => {
    const jaw = task === 'jaw'
    study.visible = jaw || task === 'tongue'
    if (!study.visible) return
    profile(!jaw, extension, glow)
    front.visible = jaw
    if (!jaw) return
    const lift = jaw ? 0.25 * extension : 0
    mandible.position.y = lift
    opening.position.y = 0.04 + lift / 2
    opening.scale.y = 0.43 - lift / 2
    muscle.emissiveIntensity = jaw ? glow : 0
  }
}
