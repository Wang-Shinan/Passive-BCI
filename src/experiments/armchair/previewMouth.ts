import * as T from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { PreviewTask } from './tasks'

export async function loadPreviewMouth(signal: AbortSignal) {
  const response = await fetch(import.meta.env.BASE_URL + 'armchair/makehuman-mouth/mouth.glb', { signal })
  if (!response.ok) throw new Error('口腔模型加载失败')
  return (await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')).scene
}

export function previewMouth(parent: T.Group, source: T.Group) {
  const inset = new T.Group()
  parent.add(inset)
  inset.position.set(0, 0.048, -0.85)
  const disc = new T.Mesh(new T.CircleGeometry(0.245, 96), new T.MeshBasicMaterial({ color: '#31443e' }))
  disc.position.z = -0.20
  inset.add(disc)
  const anatomy = new T.Group(), jaw = new T.Group()
  inset.add(anatomy)
  anatomy.add(jaw)
  anatomy.scale.setScalar(0.49)
  const gums = new T.MeshStandardMaterial({ color: '#bc726d', side: T.DoubleSide })
  const enamel = new T.MeshStandardMaterial({ color: '#fff0d7', side: T.DoubleSide, roughness: 0.4 })
  const tissue = new T.MeshStandardMaterial({ color: '#d77e85', side: T.DoubleSide, emissive: '#ff323e' })
  function take(name: string, parent: T.Group, material: T.Material) {
    const mesh = source.getObjectByName(name) as T.Mesh<T.BufferGeometry>
    const oldMaterial = mesh.material
    if (!Array.isArray(oldMaterial)) oldMaterial.dispose()
    mesh.material = material
    mesh.geometry.computeVertexNormals()
    parent.add(mesh)
    return mesh
  }
  const full: T.Mesh[] = [], section: T.Mesh[] = []
  for (const part of ['upperTeeth', 'lowerTeeth', 'palate', 'floor']) {
    const group = part === 'floor' || part === 'lowerTeeth' ? jaw : anatomy
    const material = part.endsWith('Teeth') ? enamel : gums
    full.push(take(part, group, material))
    section.push(take(part + 'Section', group, material))
  }
  const tongue = take('tongue', jaw, tissue)
  const palate = full[2]
  const openAngle = 0.30
  // Fit the contact pose against the actual palatal surface, in hinge-local coordinates.
  // The jaw stays open throughout tongue imagery. Only the anterior tongue deforms.
  const positions = tongue.geometry.getAttribute('position')
  const contact = new Float32Array(positions.count * 3)
  const axis = new T.Vector3(1, 0, 0), up = new T.Vector3(0, 1, 0)
  const ray = new T.Raycaster(), point = new T.Vector3()
  palate.matrixWorld.identity()
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i).applyAxisAngle(axis, openAngle)
    const x = point.x, z = point.z
    const weight = T.MathUtils.smoothstep(z, 0.18, 0.46)
    if (weight > 0) {
      ray.set(new T.Vector3(x, -0.25, z), up)
      const hit = ray.intersectObject(palate, false)[0]
      if (hit) {
        let surface = point.y
        for (let j = 0; j < positions.count; j++) {
          const neighbor = new T.Vector3().fromBufferAttribute(positions, j).applyAxisAngle(axis, openAngle)
          if (Math.abs(neighbor.x - x) < 0.03 && Math.abs(neighbor.z - z) < 0.033) surface = Math.max(surface, neighbor.y)
        }
        point.y += weight * Math.max(0, hit.point.y - surface)
      }
    }
    point.applyAxisAngle(axis, -openAngle).toArray(contact, i * 3)
  }
  tongue.geometry.morphAttributes.position = [new T.BufferAttribute(contact, 3)]
  tongue.updateMorphTargets()
  inset.visible = false
  return (task: PreviewTask, motion: number, glow: number) => {
    const profile = task === 'tongue'
    inset.visible = profile || task === 'jaw'
    if (!inset.visible) return
    full.forEach(mesh => { mesh.visible = !profile })
    section.forEach(mesh => { mesh.visible = profile })
    const yaw = profile ? -1.47 : -0.36
    anatomy.rotation.set(profile ? 0.01 : 0.12, yaw, 0, 'YXZ')
    anatomy.position.set(-Math.sin(yaw) * 0.135, 0.012, -Math.cos(yaw) * 0.135)
    jaw.rotation.x = openAngle * (profile ? 1 : 1 - motion)
    tongue.morphTargetInfluences![0] = profile ? motion : 0
    tissue.emissiveIntensity = profile ? glow * 0.78 : 0
    gums.emissive.setRGB(profile ? 0 : glow * 0.54, 0.008 * glow, 0.01 * glow)
  }
}
