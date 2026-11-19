import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  NormalBlending,
  PointLight,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
} from 'three'

const NOISE = `
  float fxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fxNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fxFbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 4; octave++) {
      value += amplitude * fxNoise(p);
      p *= 2.03;
      amplitude *= 0.5;
    }
    return value;
  }
`

// Fire on a surface: tongues of flame that rise and lick up its height (v), wrapping round it (u), hot yellow at their roots and
// red at their tips, and nothing above where they reach. Light is added, so it glows. `uTwist` makes them swirl round as they
// rise, for a tornado.
export function fireMaterial(options: { hot?: string; cool?: string; repeat?: number; twist?: number; speed?: number } = {}): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 1 },
      uHot: { value: new Color(options.hot ?? '#ffe08a') },
      uCool: { value: new Color(options.cool ?? '#ff3d0a') },
      uRepeat: { value: options.repeat ?? 3 },
      uTwist: { value: options.twist ?? 0 },
      uSpeed: { value: options.speed ?? 1.6 },
      uReach: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uAlpha;
      uniform vec3 uHot;
      uniform vec3 uCool;
      uniform float uRepeat;
      uniform float uTwist;
      uniform float uSpeed;
      uniform float uReach;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        vec2 p = vec2(vUv.x * uRepeat + vUv.y * uTwist - uTime * uTwist * 0.6, vUv.y * 2.2 - uTime * uSpeed);
        float n = fxFbm(p * 2.0);
        float rise = vUv.y / max(0.01, uReach);
        float flame = clamp(n * 1.7 - rise * 1.15 + 0.3, 0.0, 1.0);
        flame *= smoothstep(0.0, 0.06, vUv.y);
        vec3 colour = mix(uCool, uHot, smoothstep(0.25, 0.85, flame));
        float strength = flame * uAlpha;
        if (strength < 0.01) discard;
        gl_FragColor = vec4(colour * strength * 1.6, 1.0);
        #include <tonemapping_fragment>
            #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  })
}

// Water on a surface: a body of blue that is paler where it faces away from the eye (its edges), streaked with foam that runs
// along it. It is painted over what is behind it, see-through.
export function waterMaterial(options: { deep?: string; light?: string; foamSpeed?: number } = {}): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 1 },
      uDeep: { value: new Color(options.deep ?? '#1462b8') },
      uLight: { value: new Color(options.light ?? '#9fe6ff') },
      uFoamSpeed: { value: options.foamSpeed ?? 1.5 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -view.xyz;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uAlpha;
      uniform vec3 uDeep;
      uniform vec3 uLight;
      uniform float uFoamSpeed;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      ${NOISE}
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 2.0);
        float streak = fxFbm(vec2(vUv.x * 6.0, vUv.y * 3.0 - uTime * uFoamSpeed) * 2.0);
        float foam = smoothstep(0.55, 0.8, streak) * 0.8 + smoothstep(0.8, 1.0, vUv.y) * 0.7;
        vec3 colour = mix(uDeep, uLight, clamp(rim * 0.9 + vUv.y * 0.35, 0.0, 1.0));
        colour = mix(colour, vec3(1.0), clamp(foam, 0.0, 1.0));
        float alpha = clamp(0.55 + rim * 0.35 + foam * 0.3, 0.0, 1.0) * uAlpha;
        gl_FragColor = vec4(colour, alpha);
        #include <tonemapping_fragment>
            #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  })
}

// A soap bubble: clear in the middle, its edge shining in shifting rainbow colours, with a bright spot of light on it.
export function bubbleMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -view.xyz;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uAlpha;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(vView);
        float rim = pow(1.0 - abs(dot(n, v)), 2.2);
        vec3 rainbow = 0.55 + 0.45 * cos(6.2832 * (rim * 1.4 + vec3(0.0, 0.33, 0.67)) + uTime * 2.0);
        vec3 colour = mix(vec3(0.65, 0.9, 1.0), rainbow, 0.55);
        float spot = pow(max(0.0, dot(n, normalize(vec3(-0.4, 0.6, 0.7)))), 40.0);
        float alpha = clamp(rim * 1.1 + 0.16 + spot, 0.0, 1.0) * uAlpha;
        gl_FragColor = vec4(colour * (0.9 + rim * 1.2) + spot, alpha);
        #include <tonemapping_fragment>
            #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  })
}

// A round soft glow on a picture, white in the middle, for decals of light on the ground (embers, a flash's mark).
export function emberTexture(): Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('A canvas cannot be drawn on in this browser.')
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.45)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  // Hot spots, like coals.
  for (let index = 0; index < 90; index += 1) {
    const angle = Math.random() * Math.PI * 2
    const distance = Math.sqrt(Math.random()) * size * 0.42
    const x = size / 2 + Math.cos(angle) * distance
    const y = size / 2 + Math.sin(angle) * distance
    const r = 2 + Math.random() * 7
    const spot = context.createRadialGradient(x, y, 0, x, y, r)
    spot.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
    spot.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = spot
    context.fillRect(x - r, y - r, r * 2, r * 2)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

// A fixed handful of point lights that effects borrow for a frame each (a fireball's glow on the ground round it, the flash of
// a blast). The number of lights in a scene is built into every material's shader, so lights are never added or taken away
// while a game runs: the ones not borrowed this frame are just dark.
export class LightPool {
  readonly group = new Group()
  private readonly lights: PointLight[] = []
  private used = 0

  constructor(count: number) {
    for (let index = 0; index < count; index += 1) {
      const light = new PointLight('#ffffff', 0, 300, 1)
      light.castShadow = false
      this.lights.push(light)
      this.group.add(light)
    }
  }

  begin(): void {
    this.used = 0
  }

  // Lights a point for this frame, if a light is free.
  light(x: number, y: number, z: number, color: string, intensity: number, distance: number): void {
    const light = this.lights[this.used]
    if (!light || intensity <= 0) return
    this.used += 1
    light.position.set(x, y, z)
    light.color.set(color)
    // `intensity` is how bright it is 50 units away, against the sun's 1: light falls off with distance.
    light.intensity = intensity * 50
    light.distance = distance
  }

  end(): void {
    for (let index = this.used; index < this.lights.length; index += 1) this.lights[index].intensity = 0
  }
}
