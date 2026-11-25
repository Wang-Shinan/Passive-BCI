import * as T from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

type Side = 'left' | 'right'
export async function loadHands(signal: AbortSignal) {
  const loader = new GLTFLoader()
  async function load(side: Side) {
    const url = import.meta.env.BASE_URL + 'armchair/generic-hand/' + side + '.glb'
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Could not load ' + url)
    return (await loader.parseAsync(await response.arrayBuffer(), '')).scene
  }
  const [left, right] = await Promise.all([load('left'), load('right')])
  return { left, right }
}

export function rigHand(parent: T.Object3D, model: T.Group, side: Side) {
  const sign = side === 'right' ? 1 : -1
  const skin = model.getObjectByProperty('type', 'SkinnedMesh') as T.SkinnedMesh<T.BufferGeometry, T.MeshStandardMaterial>
  skin.material.color.set('#ce9476')
  const restingColor = skin.material.color.clone(), litColor = new T.Color('#ed5761')
  skin.material.emissive.set('#ff253d')
  skin.material.emissiveIntensity = 0
  skin.material.roughness = 0.78
  skin.castShadow = skin.receiveShadow = true
  skin.frustumCulled = false
  function bone(name: string) {
    const found = skin.skeleton.getBoneByName(name)
    if (!found) throw new Error('Missing generic-hand joint: ' + name)
    return found
  }
  const wrist = bone('wrist')
  const origin = wrist.position.clone()
  // Author the two poses in anatomical coordinates: toward the little finger,
  // toward the back of the hand, and toward the wrist, respectively.
  const nativeDirection = (x: number, y: number, z: number) => new T.Vector3(sign * y, z, x).normalize()
  const movers: ((curl: number) => void)[] = []
  function finger(names: string[], closed: T.Vector3[], restFlex: number[], delay: number) {
    const chain = names.map(bone)
    const bindPoints = chain.map(b => b.position.clone())
    const bindFrames = chain.map(b => b.quaternion.clone())
    // The upstream asset is made for tracked absolute joints. Attach the flat
    // bones into chains before posing to keep finger lengths and skin weights.
    chain.forEach((b, i) => (i === 0 ? wrist : chain[i - 1]).attach(b))
    let parentDelta = new T.Quaternion()
    for (let i = 0; i < closed.length; i++) {
      const joint = chain[i]
      const bind = joint.quaternion.clone()
      const from = bindPoints[i + 1].clone().sub(bindPoints[i]).normalize().applyQuaternion(parentDelta)
      const swing = new T.Quaternion().setFromUnitVectors(from, closed[i])
      const delta = swing.multiply(parentDelta)
      const parentFrame = (i ? bindFrames[i - 1] : wrist.quaternion).clone().premultiply(parentDelta)
      const target = parentFrame.invert().multiply(delta).multiply(bindFrames[i])
      const relaxed = bind.clone().slerp(target, restFlex[i])
      const start = delay + i * 0.025
      movers.push(curl => {
        const progress = T.MathUtils.smoothstep(curl, start, 1)
        joint.quaternion.slerpQuaternions(relaxed, target, progress)
      })
      parentDelta = delta
    }
  }
  const phalanges = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip']
  for (const [i, name] of ['index', 'middle', 'ring', 'pinky'].entries()) {
    const names = phalanges.map(segment => name + '-finger-' + segment)
    const metacarpal = bone(names[1]).position.clone().sub(bone(names[0]).position).normalize()
    const closed = [metacarpal]
    for (const angle of [77 + 3 * i, 164 + 3 * i, 218 + 2 * i]) {
      const rad = T.MathUtils.degToRad(angle)
      closed.push(nativeDirection(0.09 - i * 0.05, -Math.sin(rad), -Math.cos(rad)))
    }
    finger(names, closed, [0, 0.08, 0.13, 0.10], 0.13 - i * 0.035)
  }
  finger(['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
    [nativeDirection(-0.14, -0.38, -0.91), nativeDirection(0.20, -0.40, -0.90), nativeDirection(0.82, -0.21, -0.54)],
    [0.30, 0.22, 0.15], 0.32)

  const pivot = new T.Group()
  pivot.position.set(0, 0, -0.245)
  parent.add(pivot)
  // The GLB already includes a short wrist cuff. Seat it inside the sleeve.
  const orientation = new T.Group()
  orientation.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(
    new T.Vector3(0, sign, 0), new T.Vector3(0, 0, 1), new T.Vector3(sign, 0, 0)))
  pivot.add(orientation)
  model.position.copy(origin).multiplyScalar(-1)
  orientation.add(model)
  const haloMaterial = new T.ShaderMaterial({
    uniforms: { intensity: { value: 0 }, tint: { value: new T.Color('#ff3852') } },
    vertexShader: `
      varying vec2 haloUv;
      void main() {
        haloUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 haloUv;
      uniform float intensity;
      uniform vec3 tint;
      void main() {
        float falloff = 1.0 - smoothstep(0.12, 1.0, length(haloUv));
        gl_FragColor = vec4(tint, intensity * falloff * falloff * 0.55);
        #include <colorspace_fragment>
      }
    `,
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
  })
  const halo = new T.Mesh(new T.PlaneGeometry(0.25, 0.31), haloMaterial)
  halo.position.set(0, 0.022, -0.068)
  halo.rotation.x = -Math.PI / 2
  pivot.add(halo)
  return (curl: number, glow: number) => {
    skin.material.color.lerpColors(restingColor, litColor, glow)
    skin.material.emissiveIntensity = glow * 0.8
    halo.visible = glow > 0
    halo.scale.setScalar(0.72 + 0.58 * glow)
    haloMaterial.uniforms.intensity.value = glow * glow
    pivot.rotation.set(0.03 + 0.12 * curl, 0, sign * (0.13 - 0.78 * curl), 'ZXY')
    for (const move of movers) move(curl)
  }
}
