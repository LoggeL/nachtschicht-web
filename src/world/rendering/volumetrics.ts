import * as THREE from 'three';
import type { RenderQuality, ResolvedEnvironmentTheme } from './environmentLighting';

// ============================================================================
// NACHTSCHICHT — Volumetric Night Atmosphere, Light Cones, Coastal Mist & Rain
// Soft Fresnel-faded additive volumetric light cones (streetlamps, headlights,
// guard flashlights, Dresden baroque sconces), drifting ground-level mist,
// and single-draw-call GPU toroidal night rain streaks + puddle ripple rings.
// ============================================================================

export type VolumetricConePreset =
  | 'streetlamp'
  | 'headlight'
  | 'flashlight'
  | 'sconce'
  | 'beacon';

export interface VolumetricConeOptions {
  preset?: VolumetricConePreset;
  color?: THREE.ColorRepresentation;
  /** Beam length in meters. */
  length?: number;
  /** Radius at emitter end in meters. */
  topRadius?: number;
  /** Radius at far end of cone in meters. */
  bottomRadius?: number;
  /** Overall opacity / atmospheric density (0..1). */
  opacity?: number;
  /** Fresnel edge-softness exponent (higher = softer, more feathered edges). */
  fresnelPower?: number;
  /** Longitudinal attenuation exponent along the cone. */
  attenuation?: number;
  /** Orientation axis: '-y' (downward streetlamp/sconce), '+z' (headlight/flashlight), '+y' (upward beacon). */
  axis?: '-y' | '+z' | '+y';
}

export interface VolumetricConeHandle {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  setIntensity(intensity: number): void;
  setColor(color: THREE.ColorRepresentation): void;
  setVisible(visible: boolean): void;
  update(timeSec: number): void;
  dispose(): void;
}

interface ConePresetSpec {
  color: number;
  length: number;
  topRadius: number;
  bottomRadius: number;
  opacity: number;
  fresnelPower: number;
  attenuation: number;
  axis: '-y' | '+z' | '+y';
}

const CONE_PRESETS: Record<VolumetricConePreset, ConePresetSpec> = {
  streetlamp: {
    color: 0xffa64d,
    length: 4.5,
    topRadius: 0.14,
    bottomRadius: 2.85,
    opacity: 0.16,
    fresnelPower: 2.35,
    attenuation: 1.85,
    axis: '-y',
  },
  headlight: {
    color: 0xeef5ff,
    length: 13.5,
    topRadius: 0.16,
    bottomRadius: 2.35,
    opacity: 0.19,
    fresnelPower: 2.6,
    attenuation: 2.1,
    axis: '+z',
  },
  flashlight: {
    color: 0xe6f0ff,
    length: 8.8,
    topRadius: 0.06,
    bottomRadius: 1.45,
    opacity: 0.22,
    fresnelPower: 2.4,
    attenuation: 1.75,
    axis: '+z',
  },
  sconce: {
    color: 0xffc675,
    length: 2.9,
    topRadius: 0.1,
    bottomRadius: 1.35,
    opacity: 0.18,
    fresnelPower: 2.2,
    attenuation: 1.9,
    axis: '-y',
  },
  beacon: {
    color: 0x38bdf8,
    length: 38.0,
    topRadius: 0.85,
    bottomRadius: 4.4,
    opacity: 0.11,
    fresnelPower: 2.5,
    attenuation: 1.4,
    axis: '+y',
  },
};

const VOLUMETRIC_CONE_VERTEX = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying float vAlong;

void main() {
  // Cylinder uv.y runs 1.0 at emitter tip -> 0.0 at far mouth
  vAlong = 1.0 - uv.y;

  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;

  vec4 mvPos = viewMatrix * worldPos;
  vViewDir = normalize(-mvPos.xyz);
  vNormalView = normalize(normalMatrix * normal);

  gl_Position = projectionMatrix * mvPos;
}
`;

const VOLUMETRIC_CONE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uIntensity;
uniform float uFresnelPower;
uniform float uAttenuation;
uniform float uTime;

varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying float vAlong;

float vHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(vHash(i), vHash(i + vec2(1.0, 0.0)), u.x),
    mix(vHash(i + vec2(0.0, 1.0)), vHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  // Soft grazing-angle Fresnel fade removes all hard geometric cone edges
  float ndotv = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float edgeFade = pow(clamp(ndotv, 0.0, 1.0), uFresnelPower);

  // Smooth entry near emitter & natural inverse-square-like dissipation along cone
  float entryFade = smoothstep(0.0, 0.11, vAlong);
  float lengthFade = pow(clamp(1.0 - vAlong, 0.0, 1.0), uAttenuation);

  // Subtle drifting humid night air haze inside light cone
  vec2 hazeCoord = vWorldPos.xz * 0.24 + vec2(uTime * 0.14, vWorldPos.y * 0.35 - uTime * 0.08);
  float haze = 0.78 + 0.28 * vNoise(hazeCoord);

  // Gentle camera-proximity fade so camera never gets blinded clipping through a cone
  float camDist = distance(cameraPosition, vWorldPos);
  float nearFade = smoothstep(0.55, 2.4, camDist);

  float alpha = uOpacity * uIntensity * edgeFade * entryFade * lengthFade * haze * nearFade;
  if (alpha <= 0.001) discard;

  gl_FragColor = vec4(uColor * alpha, alpha);
}
`;

/**
 * Builds a soft Fresnel-faded additive volumetric light cone mesh whose local origin (0,0,0)
 * sits directly at the emitter (lamp bulb, headlight housing, flashlight lens, or wall sconce).
 */
export function createVolumetricLightCone(
  options: VolumetricConeOptions = {}
): VolumetricConeHandle {
  const spec = CONE_PRESETS[options.preset ?? 'streetlamp'];
  const length = options.length ?? spec.length;
  const topRadius = options.topRadius ?? spec.topRadius;
  const bottomRadius = options.bottomRadius ?? spec.bottomRadius;
  const axis = options.axis ?? spec.axis;

  const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, length, 24, 1, true);

  // Shift pivot to emitter origin (0, 0, 0) and orient along chosen axis
  if (axis === '-y') {
    geometry.translate(0, -length / 2, 0);
  } else if (axis === '+y') {
    // Flip so uv.y = 1 is at base emitter (y = 0) and widens upward
    geometry.rotateX(Math.PI);
    geometry.translate(0, length / 2, 0);
  } else if (axis === '+z') {
    // Rotate emitter from +Y to 0 and mouth toward +Z
    geometry.translate(0, -length / 2, 0);
    geometry.rotateX(-Math.PI / 2);
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: VOLUMETRIC_CONE_VERTEX,
    fragmentShader: VOLUMETRIC_CONE_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(options.color ?? spec.color) },
      uOpacity: { value: options.opacity ?? spec.opacity },
      uIntensity: { value: 1.0 },
      uFresnelPower: { value: options.fresnelPower ?? spec.fresnelPower },
      uAttenuation: { value: options.attenuation ?? spec.attenuation },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `VolumetricCone_${options.preset ?? 'streetlamp'}`;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 12;
  mesh.userData.excludeFromAO = true;

  return {
    mesh,
    material,
    setIntensity(intensity: number) {
      material.uniforms.uIntensity.value = Math.max(0, intensity);
      mesh.visible = intensity > 0.002;
    },
    setColor(color: THREE.ColorRepresentation) {
      (material.uniforms.uColor.value as THREE.Color).set(color);
    },
    setVisible(visible: boolean) {
      mesh.visible = visible;
    },
    update(timeSec: number) {
      material.uniforms.uTime.value = timeSec;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ----------------------------------------------------------------------------
// GPU Toroidal Night Rain Streaks (1 draw call) + Ground Puddle Ripple Rings
// ----------------------------------------------------------------------------

interface RainSystemInternal {
  group: THREE.Group;
  update(timeSec: number, focusPos: THREE.Vector3): void;
  setIntensity(intensity: number): void;
  setTheme(theme: ResolvedEnvironmentTheme): void;
  setQuality(quality: RenderQuality): void;
  dispose(): void;
}

const RAIN_COUNTS: Record<RenderQuality, { drops: number; ripples: number }> = {
  ultra: { drops: 1200, ripples: 84 },
  high: { drops: 760, ripples: 52 },
  medium: { drops: 340, ripples: 24 },
};

function createNightRainSystem(
  initialQuality: RenderQuality,
  initialTheme: ResolvedEnvironmentTheme
): RainSystemInternal {
  const group = new THREE.Group();
  group.name = 'Nachtschicht_NightRain';
  group.userData.excludeFromAO = true;

  let currentQuality = initialQuality;
  let currentTheme = initialTheme;
  let rainIntensity = initialTheme === 'salou' ? 0.56 : 0.34;
  let rainMesh: THREE.Mesh | null = null;
  let rainMat: THREE.ShaderMaterial | null = null;
  let rippleMesh: THREE.Mesh | null = null;
  let rippleMat: THREE.ShaderMaterial | null = null;

  const boxSize = new THREE.Vector3(44, 22, 44);
  const rippleBoxXZ = 32;

  const disposeMeshes = () => {
    if (rainMesh) {
      group.remove(rainMesh);
      rainMesh.geometry.dispose();
      rainMesh = null;
    }
    if (rainMat) {
      rainMat.dispose();
      rainMat = null;
    }
    if (rippleMesh) {
      group.remove(rippleMesh);
      rippleMesh.geometry.dispose();
      rippleMesh = null;
    }
    if (rippleMat) {
      rippleMat.dispose();
      rippleMat = null;
    }
  };

  const build = () => {
    disposeMeshes();
    const { drops, ripples } = RAIN_COUNTS[currentQuality];

    // 1) Camera-facing GPU-wrapped raindrop streaks (InstancedBufferGeometry, 1 draw call!)
    const baseQuad = new THREE.PlaneGeometry(0.022, 0.58);
    const rainGeo = new THREE.InstancedBufferGeometry();
    rainGeo.index = baseQuad.index;
    rainGeo.attributes.position = baseQuad.attributes.position;
    rainGeo.attributes.uv = baseQuad.attributes.uv;
    rainGeo.instanceCount = drops;

    const seeds = new Float32Array(drops * 4);
    for (let i = 0; i < drops; i++) {
      // Deterministic pseudo-random distribution
      const s1 = Math.sin((i + 1) * 12.9898) * 43758.5453;
      const s2 = Math.sin((i + 1) * 78.233) * 24634.6345;
      const s3 = Math.sin((i + 1) * 39.425) * 65123.1123;
      const s4 = Math.sin((i + 1) * 93.117) * 19283.7741;
      seeds[i * 4 + 0] = (s1 - Math.floor(s1)) * boxSize.x;
      seeds[i * 4 + 1] = (s2 - Math.floor(s2)) * boxSize.y;
      seeds[i * 4 + 2] = (s3 - Math.floor(s3)) * boxSize.z;
      seeds[i * 4 + 3] = 0.75 + (s4 - Math.floor(s4)) * 0.55; // speed & length variance
    }
    rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    baseQuad.dispose();

    const rainColor = currentTheme === 'dresden' ? 0xbdd0eb : 0xa9c8e8;

    rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uFocus: { value: new THREE.Vector3() },
        uBoxSize: { value: boxSize.clone() },
        uIntensity: { value: rainIntensity },
        uColor: { value: new THREE.Color(rainColor) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform vec3 uFocus;
        uniform vec3 uBoxSize;
        varying vec2 vUv;
        varying float vAlpha;

        void main() {
          vUv = uv;
          float speed = 15.5 * aSeed.w;
          float windX = 1.65;
          float windZ = 0.85;

          // Toroidal wrap around camera/player focus so rain covers entire Salou/Dresden seamlessly
          vec3 offset = vec3(
            aSeed.x + uTime * windX,
            aSeed.y - uTime * speed,
            aSeed.z + uTime * windZ
          );
          vec3 rel = mod(offset - uFocus + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
          vec3 worldCenter = vec3(uFocus.x + rel.x, max(0.35, rel.y + uBoxSize.y * 0.5), uFocus.z + rel.z);

          // Cylindrical billboard around vertical rain slant vector
          vec3 rainDir = normalize(vec3(windX, -speed, windZ));
          vec3 toCam = normalize(cameraPosition - worldCenter);
          vec3 right = normalize(cross(toCam, rainDir));

          vec3 worldPos = worldCenter
            + right * (position.x * (0.9 + 0.35 * aSeed.w))
            - rainDir * (position.y * aSeed.w);

          // Fade gracefully near edges of the rain box & very close to camera lens
          float edgeXZ = 1.0 - smoothstep(uBoxSize.x * 0.34, uBoxSize.x * 0.49, length(rel.xz));
          float nearCam = smoothstep(1.2, 4.2, distance(cameraPosition, worldCenter));
          float groundCut = smoothstep(0.15, 0.9, worldCenter.y);
          vAlpha = edgeXZ * nearCam * groundCut;

          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        varying float vAlpha;

        void main() {
          // Soft tapered raindrop filament
          float horiz = 1.0 - abs(vUv.x * 2.0 - 1.0);
          float vert = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.2, vUv.y);
          float a = horiz * vert * vAlpha * uIntensity * 0.28;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });

    rainMesh = new THREE.Mesh(rainGeo, rainMat);
    rainMesh.name = 'NightRain_Streaks';
    rainMesh.frustumCulled = false;
    rainMesh.renderOrder = 14;
    rainMesh.userData.excludeFromAO = true;
    group.add(rainMesh);

    // 2) Ground Puddle Ripple Rings (1 draw call, GPU-wrapped XZ around focus)
    const ringQuad = new THREE.PlaneGeometry(0.46, 0.46);
    ringQuad.rotateX(-Math.PI / 2);
    const rippleGeo = new THREE.InstancedBufferGeometry();
    rippleGeo.index = ringQuad.index;
    rippleGeo.attributes.position = ringQuad.attributes.position;
    rippleGeo.attributes.uv = ringQuad.attributes.uv;
    rippleGeo.instanceCount = ripples;

    const rSeeds = new Float32Array(ripples * 4);
    for (let i = 0; i < ripples; i++) {
      const a = Math.sin((i + 7) * 53.17) * 43758.5453;
      const b = Math.sin((i + 7) * 91.31) * 31415.9265;
      const c = Math.sin((i + 7) * 19.73) * 27182.8182;
      const d = Math.sin((i + 7) * 67.41) * 16180.3398;
      rSeeds[i * 4 + 0] = (a - Math.floor(a)) * rippleBoxXZ;
      rSeeds[i * 4 + 1] = (b - Math.floor(b)) * rippleBoxXZ;
      rSeeds[i * 4 + 2] = c - Math.floor(c); // phase offset
      rSeeds[i * 4 + 3] = 0.7 + (d - Math.floor(d)) * 0.8; // speed
    }
    rippleGeo.setAttribute('aRipple', new THREE.InstancedBufferAttribute(rSeeds, 4));
    ringQuad.dispose();

    rippleMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uFocus: { value: new THREE.Vector3() },
        uBoxXZ: { value: rippleBoxXZ },
        uIntensity: { value: rainIntensity },
        uColor: { value: new THREE.Color(currentTheme === 'dresden' ? 0xd9c7a8 : 0xb4d0ee) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aRipple;
        uniform float uTime;
        uniform vec3 uFocus;
        uniform float uBoxXZ;
        varying vec2 vUv;
        varying float vCycle;
        varying float vDistFade;

        void main() {
          vUv = uv;
          float cycle = fract(uTime * (0.72 * aRipple.w) + aRipple.z);
          vCycle = cycle;

          vec2 relXZ = mod(aRipple.xy - uFocus.xz + uBoxXZ * 0.5, uBoxXZ) - uBoxXZ * 0.5;
          float scale = 0.25 + cycle * 1.15;
          vec3 worldPos = vec3(
            uFocus.x + relXZ.x + position.x * scale,
            0.028,
            uFocus.z + relXZ.y + position.z * scale
          );

          vDistFade = 1.0 - smoothstep(uBoxXZ * 0.3, uBoxXZ * 0.48, length(relXZ));
          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        varying float vCycle;
        varying float vDistFade;

        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.56, 0.78, r) * smoothstep(0.98, 0.80, r);
          float fade = (1.0 - vCycle) * (1.0 - vCycle) * smoothstep(0.0, 0.12, vCycle);
          float a = ring * fade * vDistFade * uIntensity * 0.24;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });

    rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    rippleMesh.name = 'NightRain_PuddleRipples';
    rippleMesh.frustumCulled = false;
    rippleMesh.renderOrder = 11;
    rippleMesh.userData.excludeFromAO = true;
    group.add(rippleMesh);
  };

  build();

  return {
    group,
    update(timeSec: number, focusPos: THREE.Vector3) {
      const visible = rainIntensity > 0.01;
      group.visible = visible;
      if (!visible) return;
      if (rainMat) {
        rainMat.uniforms.uTime.value = timeSec;
        rainMat.uniforms.uFocus.value.copy(focusPos);
        rainMat.uniforms.uIntensity.value = rainIntensity;
      }
      if (rippleMat) {
        rippleMat.uniforms.uTime.value = timeSec;
        rippleMat.uniforms.uFocus.value.copy(focusPos);
        rippleMat.uniforms.uIntensity.value = rainIntensity;
      }
    },
    setIntensity(intensity: number) {
      rainIntensity = Math.max(0, Math.min(1, intensity));
      group.visible = rainIntensity > 0.01;
    },
    setTheme(theme: ResolvedEnvironmentTheme) {
      currentTheme = theme;
      if (rainMat) {
        (rainMat.uniforms.uColor.value as THREE.Color).setHex(
          theme === 'dresden' ? 0xbdd0eb : 0xa9c8e8
        );
      }
      if (rippleMat) {
        (rippleMat.uniforms.uColor.value as THREE.Color).setHex(
          theme === 'dresden' ? 0xd9c7a8 : 0xb4d0ee
        );
      }
    },
    setQuality(quality: RenderQuality) {
      if (quality === currentQuality) return;
      currentQuality = quality;
      build();
    },
    dispose() {
      disposeMeshes();
    },
  };
}

// ----------------------------------------------------------------------------
// Drifting Ground-Hugging Coastal Mist / Riverside Night Haze
// ----------------------------------------------------------------------------

interface CoastalMistInternal {
  group: THREE.Group;
  update(timeSec: number, focusPos: THREE.Vector3): void;
  setTheme(theme: ResolvedEnvironmentTheme): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

function createCoastalMistLayer(initialTheme: ResolvedEnvironmentTheme): CoastalMistInternal {
  const group = new THREE.Group();
  group.name = 'Nachtschicht_CoastalMist';
  group.userData.excludeFromAO = true;

  const geo = new THREE.PlaneGeometry(140, 140);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(initialTheme === 'dresden' ? 0x2a3245 : 0x18304d) },
      uWarmColor: { value: new THREE.Color(initialTheme === 'dresden' ? 0x5c4228 : 0x4d311d) },
      uOpacity: { value: 0.14 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uWarmColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vWorldPos;

      float mHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float mNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x),
          mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float mFbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
          v += a * mNoise(p);
          p = p * 2.04 + vec2(11.3, 5.7);
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 centered = (vUv - 0.5) * 2.0;
        float radial = smoothstep(1.0, 0.2, length(centered));

        vec2 p1 = vWorldPos.xz * 0.032 + vec2(uTime * 0.028, uTime * 0.011);
        vec2 p2 = vWorldPos.xz * 0.068 - vec2(uTime * 0.018, -uTime * 0.022);
        float cloud = mFbm(p1) * 0.65 + mFbm(p2) * 0.35;
        float wisps = smoothstep(0.36, 0.82, cloud);

        // Keep immediate center around player crisp so gameplay readability is never obscured
        float camDist = distance(cameraPosition, vWorldPos);
        float nearClear = smoothstep(4.0, 18.0, camDist);

        float alpha = radial * wisps * nearClear * uOpacity;
        if (alpha <= 0.002) discard;

        vec3 tint = mix(uColor, uWarmColor, smoothstep(0.55, 0.85, cloud) * 0.35);
        gl_FragColor = vec4(tint, alpha);
      }
    `,
  });

  // Two gentle staggered mist decks (low street drift + upper promenade haze)
  const lowDeck = new THREE.Mesh(geo, mat);
  lowDeck.position.y = 0.45;
  lowDeck.renderOrder = 10;
  lowDeck.userData.excludeFromAO = true;
  group.add(lowDeck);

  const upperDeck = new THREE.Mesh(geo, mat);
  upperDeck.position.set(12, 2.1, -8);
  upperDeck.rotation.y = 0.7;
  upperDeck.renderOrder = 10;
  upperDeck.userData.excludeFromAO = true;
  group.add(upperDeck);

  return {
    group,
    update(timeSec: number, focusPos: THREE.Vector3) {
      mat.uniforms.uTime.value = timeSec;
      group.position.set(focusPos.x, 0, focusPos.z);
    },
    setTheme(theme: ResolvedEnvironmentTheme) {
      if (theme === 'dresden') {
        (mat.uniforms.uColor.value as THREE.Color).setHex(0x2a3245);
        (mat.uniforms.uWarmColor.value as THREE.Color).setHex(0x5c4228);
      } else {
        (mat.uniforms.uColor.value as THREE.Color).setHex(0x18304d);
        (mat.uniforms.uWarmColor.value as THREE.Color).setHex(0x4d311d);
      }
    },
    setOpacity(opacity: number) {
      mat.uniforms.uOpacity.value = Math.max(0, Math.min(0.4, opacity));
      group.visible = opacity > 0.002;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ----------------------------------------------------------------------------
// Unified VolumetricAtmosphere Manager
// ----------------------------------------------------------------------------

export interface VolumetricAtmosphereOptions {
  quality?: RenderQuality;
  theme?: ResolvedEnvironmentTheme;
  enableRain?: boolean;
  enableMist?: boolean;
  rainIntensity?: number;
  mistOpacity?: number;
}

export interface VolumetricAtmosphere {
  readonly root: THREE.Group;
  /** Registers an external volumetric cone so atmosphere.update() animates its air haze. */
  registerCone(cone: VolumetricConeHandle): void;
  unregisterCone(cone: VolumetricConeHandle): void;
  /** Spawns and attaches a volumetric cone to the atmosphere root (auto-disposed on clearCones/dispose). */
  spawnCone(
    position: THREE.Vector3 | [number, number, number],
    options?: VolumetricConeOptions
  ): VolumetricConeHandle;
  clearOwnedCones(): void;
  update(dt: number, focusPos: THREE.Vector3): void;
  setQuality(quality: RenderQuality): void;
  setTheme(theme: ResolvedEnvironmentTheme): void;
  setRainIntensity(intensity: number): void;
  setMistOpacity(opacity: number): void;
  /** Suppresses outdoor rain/mist cleanly when viewing basement/cellar cutaways. */
  setIndoorCutaway(indoor: boolean): void;
  dispose(): void;
}

export function createVolumetricAtmosphere(
  scene: THREE.Scene,
  options: VolumetricAtmosphereOptions = {}
): VolumetricAtmosphere {
  const root = new THREE.Group();
  root.name = 'Nachtschicht_VolumetricAtmosphere';
  root.userData.excludeFromAO = true;
  scene.add(root);

  let currentQuality: RenderQuality = options.quality ?? 'high';
  let currentTheme: ResolvedEnvironmentTheme = options.theme ?? 'salou';
  let elapsedSec = 0;
  let disposed = false;

  const trackedCones = new Set<VolumetricConeHandle>();
  const ownedCones: VolumetricConeHandle[] = [];

  const rain = createNightRainSystem(currentQuality, currentTheme);
  if (options.enableRain === false) {
    rain.setIntensity(0);
  } else if (options.rainIntensity !== undefined) {
    rain.setIntensity(options.rainIntensity);
  }
  root.add(rain.group);

  const mist = createCoastalMistLayer(currentTheme);
  if (options.enableMist === false) {
    mist.setOpacity(0);
  } else if (options.mistOpacity !== undefined) {
    mist.setOpacity(options.mistOpacity);
  }
  root.add(mist.group);

  let savedRainIntensity =
    options.enableRain === false
      ? 0
      : options.rainIntensity ?? (currentTheme === 'salou' ? 0.56 : 0.34);
  let savedMistOpacity =
    options.enableMist === false ? 0 : options.mistOpacity ?? 0.14;
  let indoorCutaway = false;

  const clearOwnedCones = () => {
    for (const cone of ownedCones) {
      trackedCones.delete(cone);
      root.remove(cone.mesh);
      cone.dispose();
    }
    ownedCones.length = 0;
  };

  return {
    root,

    registerCone(cone: VolumetricConeHandle) {
      trackedCones.add(cone);
    },

    unregisterCone(cone: VolumetricConeHandle) {
      trackedCones.delete(cone);
    },

    spawnCone(
      position: THREE.Vector3 | [number, number, number],
      coneOptions?: VolumetricConeOptions
    ): VolumetricConeHandle {
      const cone = createVolumetricLightCone(coneOptions);
      if (Array.isArray(position)) {
        cone.mesh.position.set(position[0], position[1], position[2]);
      } else {
        cone.mesh.position.copy(position);
      }
      root.add(cone.mesh);
      ownedCones.push(cone);
      trackedCones.add(cone);
      return cone;
    },

    clearOwnedCones,

    update(dt: number, focusPos: THREE.Vector3) {
      if (disposed) return;
      elapsedSec += Math.max(0, Math.min(0.1, dt || 0.016));

      rain.update(elapsedSec, focusPos);
      mist.update(elapsedSec, focusPos);
      for (const cone of trackedCones) {
        cone.update(elapsedSec);
      }
    },

    setQuality(quality: RenderQuality) {
      if (disposed) return;
      currentQuality = quality;
      rain.setQuality(quality);
    },

    setTheme(theme: ResolvedEnvironmentTheme) {
      if (disposed) return;
      currentTheme = theme;
      rain.setTheme(theme);
      mist.setTheme(theme);
      savedRainIntensity = theme === 'salou' ? 0.56 : 0.34;
      if (!indoorCutaway && options.enableRain !== false) {
        rain.setIntensity(savedRainIntensity);
      }
    },

    setRainIntensity(intensity: number) {
      savedRainIntensity = Math.max(0, Math.min(1, intensity));
      if (!indoorCutaway) {
        rain.setIntensity(savedRainIntensity);
      }
    },

    setMistOpacity(opacity: number) {
      savedMistOpacity = Math.max(0, Math.min(0.4, opacity));
      if (!indoorCutaway) {
        mist.setOpacity(savedMistOpacity);
      }
    },

    setIndoorCutaway(indoor: boolean) {
      indoorCutaway = indoor;
      rain.setIntensity(indoor ? 0 : savedRainIntensity);
      mist.setOpacity(indoor ? 0 : savedMistOpacity);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearOwnedCones();
      trackedCones.clear();
      rain.dispose();
      mist.dispose();
      scene.remove(root);
    },
  };
}
