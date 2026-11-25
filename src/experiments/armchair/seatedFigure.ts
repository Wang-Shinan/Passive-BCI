import * as T from 'three'
import { rigHand } from './genericHand'
import type { PreviewTask } from './tasks'
import { material, mesh, oval } from './studio'

// Elliptical cross-sections along -Z. Shared ring vertices keep the wrist,
// knuckles and sleeves smooth even where the widths change considerably.
type Ring = [distance: number, halfWidth: number, halfHeight: number, y?: number]
function shaped(parent: T.Object3D, mat: T.Material, rings: Ring[]) {
  const points: number[] = [], indices: number[] = [], sides = 32
  for (const [distance, width, height, y = 0] of rings) {
    for (let i = 0; i < sides; i++) {
      const angle = 2 * Math.PI * i / sides
      points.push(width * Math.cos(angle), y + height * Math.sin(angle), -distance)
    }
  }
  for (let row = 1; row < rings.length; row++) for (let i = 0; i < sides; i++) {
    const a = (row - 1) * sides + i, b = (row - 1) * sides + (i + 1) % sides
    indices.push(a, a + sides, b, b, a + sides, b + sides)
  }
  const g = new T.BufferGeometry()
  g.setAttribute('position', new T.Float32BufferAttribute(points, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return mesh(parent, g, mat, 0, 0, 0)
}

function joint(parent: T.Object3D, x: number, y: number, z: number) {
  const group = new T.Group()
  group.position.set(x, y, z)
  parent.add(group)
  return group
}

export function seatedFigure(scene: T.Scene, hands: { left: T.Group; right: T.Group }) {
  const twill = material('#465766'), seam = material('#556574'), shoes = material('#75583f')
  shoes.emissive.set('#ff3344')
  const shirt = material('#476c69'), rib = material('#365856'), piping = material('#547674')
  function limb(side: number) {
    const sideGroup = joint(scene, 0, 0, 0)
    sideGroup.scale.x = side
    const thigh = joint(sideGroup, 0.115, 0.48, 0.38)
    thigh.rotation.y = -0.115
    shaped(thigh, twill, [[-0.13, 0.13, 0.115], [0, 0.136, 0.121], [0.28, 0.106, 0.106], [0.46, 0.087, 0.083], [0.50, 0.077, 0.073], [0.53, 0.025, 0.031]])
    const stitch = new T.CatmullRomCurve3([new T.Vector3(0.13, 0.015, 0.10), new T.Vector3(0.119, 0.022, -0.19), new T.Vector3(0.097, 0.016, -0.35), new T.Vector3(0.079, 0.006, -0.477)])
    mesh(thigh, new T.TubeGeometry(stitch, 20, 0.0018, 6, false), seam, 0, 0, 0)
    const shin = joint(sideGroup, 0.17, 0.486, -0.084)
    shin.rotation.x = -0.94
    shaped(shin, twill, [[-0.03, 0.079, 0.079], [0.035, 0.087, 0.081], [0.14, 0.081, 0.085], [0.34, 0.058, 0.055], [0.48, 0.055, 0.05]])
    // Feet pivot about the planted heels; the knee and shin stay still.
    const heel = joint(sideGroup, 0.18, 0.024, -0.36)
    oval(heel, shoes, 0, 0.061, -0.105, 0.064, 0.063, 0.147)
    const arm = joint(scene, side * 0.36, 0.734, 0.21)
    shaped(arm, shirt, [[-0.28, 0.075, 0.074], [0, 0.076, 0.064], [0.07, 0.07, 0.059], [0.16, 0.054, 0.049], [0.203, 0.053, 0.042], [0.215, 0.044, 0.041]])
    shaped(arm, rib, [[0.198, 0.054, 0.043], [0.208, 0.052, 0.043], [0.237, 0.044, 0.037], [0.242, 0.041, 0.034], [0.242, 0.027, 0.016]])
    for (const d of [0.213, 0.219, 0.225, 0.231]) {
      const w = 0.051 - (d - 0.212) * 0.23
      shaped(arm, piping, [[d, w, w * 0.83], [d + 0.0018, w, w * 0.83]])
    }
    const handedness = side < 0 ? 'left' : 'right'
    const hand = rigHand(arm, hands[handedness], handedness)
    return (amt: number, glow: number, legs: boolean, extension: number) => {
      heel.rotation.x = legs ? 0.52 * extension : 0
      arm.rotation.order = 'YXZ'
      arm.rotation.y = side * (0.10 + 0.22 * amt)
      arm.rotation.x = 0.012 + 0.36 * Math.sin(amt * Math.PI / 2)
      hand(amt, glow)
    }
  }
  const left = limb(-1), right = limb(1)
  return (task: PreviewTask, motion: number, glow: number) => {
    const legs = task === 'feet'
    shoes.emissiveIntensity = legs ? glow * 0.86 : 0
    left(task === 'left' ? motion : 0, task === 'left' ? glow : 0, legs, motion)
    right(task === 'right' ? motion : 0, task === 'right' ? glow : 0, legs, motion)
  }
}
