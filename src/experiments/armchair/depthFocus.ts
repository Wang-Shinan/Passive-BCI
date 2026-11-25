import * as T from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

const kernelRadius = 9
const fullscreenVertex = `varying vec2 coord;
  void main() { coord = uv; gl_Position = vec4(position.xy, 0., 1.); }`

export function depthFocus(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.PerspectiveCamera) {
  const target = new T.WebGLRenderTarget(1, 1, {
    type: T.HalfFloatType, depthTexture: new T.DepthTexture(1, 1), samples: 2,
  })
  const horizontal = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, depthBuffer: false })
  const gaussian = horizontal.clone()
  const blurUniforms = {
    source: { value: target.texture },
    stepUV: { value: new T.Vector2() },
    weights: { value: new Float32Array(kernelRadius + 1) },
  }
  // Convolve in linear color, with a horizontal and vertical pass at half
  // resolution. The first pass also downsamples via bilinear sampling.
  const blurPass = new T.ShaderMaterial({
    defines: { KERNEL_RADIUS: kernelRadius },
    uniforms: blurUniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: fullscreenVertex,
    fragmentShader: `
      varying vec2 coord;
      uniform sampler2D source;
      uniform vec2 stepUV;
      uniform float weights[KERNEL_RADIUS + 1];
      void main() {
        vec4 color = texture2D(source, coord) * weights[0];
        for (int i = 1; i <= KERNEL_RADIUS; i++) {
          vec2 offset = float(i) * stepUV;
          color += (texture2D(source, coord + offset) + texture2D(source, coord - offset)) * weights[i];
        }
        gl_FragColor = color;
      }`,
  })
  const uniforms = {
    colorMap: { value: target.texture }, softMap: { value: gaussian.texture }, depthMap: { value: target.depthTexture },
    clip: { value: new T.Vector2(camera.near, camera.far) },
    farFocus: { value: 0 },
  }
  const material = new T.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false,
    vertexShader: fullscreenVertex,
    fragmentShader: `
      #include <packing>
      varying vec2 coord;
      uniform sampler2D colorMap, softMap, depthMap;
      uniform vec2 clip;
      uniform float farFocus;
      void main() {
        float depth = texture2D(depthMap, coord).x;
        float distanceM = -perspectiveDepthToViewZ(depth, clip.x, clip.y);
        float distant = smoothstep(1.45, 2.4, distanceM);
        float blur = mix(distant, 1.0 - distant, farFocus);
        gl_FragColor = mix(texture2D(colorMap, coord), texture2D(softMap, coord), blur);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const quad = new FullScreenQuad(material)
  return {
    resize(width: number, height: number) {
      const ratio = renderer.getPixelRatio()
      target.setSize(Math.round(width * ratio), Math.round(height * ratio))
      const halfWidth = Math.ceil(target.width / 2), halfHeight = Math.ceil(target.height / 2)
      horizontal.setSize(halfWidth, halfHeight)
      gaussian.setSize(halfWidth, halfHeight)
      const sigma = T.MathUtils.clamp(Math.min(width, height) * 0.0039 * ratio, 1.5, 3.3)
      const weights = blurUniforms.weights.value
      let total = 1
      weights[0] = 1
      for (let i = 1; i <= kernelRadius; i++) {
        weights[i] = Math.exp(-0.5 * (i / sigma) ** 2)
        total += 2 * weights[i]
      }
      for (let i = 0; i <= kernelRadius; i++) weights[i] /= total
    },
    render(farFocus: number) {
      uniforms.farFocus.value = farFocus
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      quad.material = blurPass
      blurUniforms.source.value = target.texture
      blurUniforms.stepUV.value.set(1 / horizontal.width, 0)
      renderer.setRenderTarget(horizontal)
      quad.render(renderer)
      blurUniforms.source.value = horizontal.texture
      blurUniforms.stepUV.value.set(0, 1 / horizontal.height)
      renderer.setRenderTarget(gaussian)
      quad.render(renderer)
      renderer.setRenderTarget(null)
      quad.material = material
      quad.render(renderer)
    },
    dispose() {
      target.dispose()
      horizontal.dispose()
      gaussian.dispose()
      quad.dispose()
      blurPass.dispose()
      material.dispose()
    },
  }
}
