import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType, Vector2 as ThreeVector2, Vector3, type Material } from 'three'
import type { VisionMask } from '../../../../packages/shared/src/index.ts'
import { FOG_ALPHA, FogPicture } from '../render/fog.ts'
import { GRAPHICS_PRESETS, type GraphicsOptions } from '../render/graphics-quality.ts'

// How what the team cannot see looks in 3D: the same mask as the 2D darkness (`FogPicture`, which rounds off the steps of its
// edge), but instead of a sheet laid over the world, every material looks it up where it is drawn, so a wall, a tree and the
// ground under it are all darkened alike, whatever their height. What is in the dark is drained of most of its colour and
// tinted the blue-black of the 2D fog, so the edge of sight is plain and the map can still be read. Outside the arena is dark.
//
// A material is given it with `shade` (before it is first drawn). The uniforms are shared, so one update reaches them all.
export class VisionShading {
  private readonly uniforms = {
    uVisionMap: { value: blankTexture() },
    uVisionSize: { value: new ThreeVector2(1, 1) },
    uVisionOn: { value: 0 },
    uVisionTint: { value: new Vector3(0.012, 0.02, 0.05) },
  }
  private picture: { fog: FogPicture; texture: DataTexture; cell: number; revision: number } | undefined

  // `graphics` is how much the world draws (see graphics-quality.ts), which everything that is shaded is told with this: how finely a model
  // is cut, how it is lit, how the ground and the scenery are made. As High if not given.
  constructor(readonly graphics: Readonly<GraphicsOptions> = GRAPHICS_PRESETS.high) {}

  update(mask: VisionMask | undefined): void {
    this.uniforms.uVisionOn.value = mask ? 1 : 0
    if (!mask) return
    const current = this.picture
    if (current && current.fog.cols === mask.cols && current.fog.rows === mask.rows && current.cell === mask.cell) {
      if (current.revision === mask.revision) return
      current.fog.paint(mask)
      current.revision = mask.revision
      current.texture.needsUpdate = true
      return
    }
    current?.texture.dispose()
    const fog = new FogPicture(mask.cols, mask.rows)
    fog.paint(mask)
    const texture = new DataTexture(fog.pixels, fog.width, fog.height, RGBAFormat, UnsignedByteType)
    texture.magFilter = LinearFilter
    texture.minFilter = LinearFilter
    texture.needsUpdate = true
    this.picture = { fog, texture, cell: mask.cell, revision: mask.revision }
    this.uniforms.uVisionMap.value = texture
    this.uniforms.uVisionSize.value.set(mask.cols * mask.cell, mask.rows * mask.cell)
  }

  // Makes `material` darken where the team cannot see. `blend` says how: an ordinary surface is drained and darkened toward the
  // fog's colour; one that is added to what is behind it (a glow) only fades, since a dark colour added is no colour at all.
  shade<M extends Material>(material: M, blend: 'surface' | 'glow' = 'surface'): M {
    const previous = material.onBeforeCompile
    const uniforms = this.uniforms
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = 'varying vec3 vVisionWorld;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 visionWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          visionWorld = instanceMatrix * visionWorld;
        #endif
        vVisionWorld = (modelMatrix * visionWorld).xyz;`,
      )
      shader.fragmentShader = `varying vec3 vVisionWorld;
        uniform sampler2D uVisionMap;
        uniform vec2 uVisionSize;
        uniform float uVisionOn;
        uniform vec3 uVisionTint;
        float visionDark() {
          if (uVisionOn < 0.5) return 0.0;
          vec2 uv = vVisionWorld.xz / uVisionSize;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
          return clamp(texture2D(uVisionMap, uv).a / ${FOG_ALPHA.toFixed(4)}, 0.0, 1.0);
        }
        ` + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        blend === 'glow'
          ? `{ float dark = visionDark(); gl_FragColor.rgb *= 1.0 - 0.75 * dark; gl_FragColor.a *= 1.0 - 0.5 * dark; }
          #include <dithering_fragment>`
          : `{ float dark = visionDark();
            float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
            vec3 dim = mix(gl_FragColor.rgb, vec3(lum), 0.65) * 0.33 + uVisionTint;
            gl_FragColor.rgb = mix(gl_FragColor.rgb, dim, dark); }
          #include <dithering_fragment>`,
      )
    }
    // Every material shaded this way compiles the same extra code, but a glow's differs from a surface's.
    const previousKey = material.customProgramCacheKey.bind(material)
    material.customProgramCacheKey = () => `${previousKey()}|vision-${blend}`
    material.needsUpdate = true
    return material
  }

  dispose(): void {
    this.picture?.texture.dispose()
    this.uniforms.uVisionMap.value.dispose()
  }
}

function blankTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat, UnsignedByteType)
  texture.needsUpdate = true
  return texture
}
