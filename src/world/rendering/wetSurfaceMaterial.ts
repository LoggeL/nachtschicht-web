import * as THREE from 'three';

// ============================================================================
// NACHTSCHICHT — Photorealistic Wet Night Surface Shader & PBR Material Builder
// MeshPhysicalMaterial + onBeforeCompile multi-scale world-space puddle shader:
// blends mirror-smooth rain puddles (low roughness, clearcoat = 1.0, gravity-
// flattened normals + subtle animated raindrop ripples, physical wet-albedo
// darkening) with damp textured coastal asphalt & stone PBR maps.
// ============================================================================

export type WetSurfacePreset =
  | 'wet_asphalt'
  | 'stone_plaza'
  | 'dresden_cobble'
  | 'interior_marble';

export interface PbrTextureSet {
  /** Base color texture (compatible with both Three.js `map` and `albedo` naming). */
  map?: THREE.Texture | null;
  albedo?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
  aoMap?: THREE.Texture | null;
}

export interface WetSurfaceShaderParams {
  /** Overall moisture film 0..1 (darkens porous mineral albedo & lowers damp roughness). */
  wetness?: number;
  /** Fraction of surface covered by standing glossy rain puddles (0..1). */
  puddleCoverage?: number;
  /** World-space frequency in 1/meters for organic puddle patch size (default 0.11). */
  puddleScale?: number;
  /** Roughness inside standing water puddles (0.035..0.12 for crisp lamp/neon mirror sheen). */
  puddleRoughness?: number;
  /** Base roughness of damp aggregate outside puddles (0.55..0.9). */
  dryRoughness?: number;
  /** Subtle concentric raindrop ripple perturbation inside puddles (0..1). */
  rippleStrength?: number;
  /** Subtle cool-dark absorption tint applied to standing puddles. */
  puddleTint?: THREE.ColorRepresentation;
}

export interface WetSurfaceOptions extends WetSurfaceShaderParams {
  preset?: WetSurfacePreset;
  color?: THREE.ColorRepresentation;
  maps?: PbrTextureSet;
  normalScale?: number;
  aoMapIntensity?: number;
  envMapIntensity?: number;
  metalness?: number;
}

export interface WetSurfaceMaterialHandle {
  readonly material: THREE.MeshPhysicalMaterial;
  /** Advances animated raindrop puddle ripples (in seconds). */
  update(dt: number): void;
  setTime(timeSec: number): void;
  setWetness(wetness: number): void;
  setPuddleCoverage(coverage: number): void;
  setRippleStrength(strength: number): void;
  dispose(): void;
}

interface WetShaderUniformBag {
  uWetTime: { value: number };
  uWetness: { value: number };
  uPuddleCoverage: { value: number };
  uPuddleScale: { value: number };
  uPuddleRoughness: { value: number };
  uDryRoughness: { value: number };
  uRippleStrength: { value: number };
  uPuddleTint: { value: THREE.Color };
}

const PRESET_DEFAULTS: Record<
  WetSurfacePreset,
  Required<Omit<WetSurfaceShaderParams, 'puddleTint'>> & {
    puddleTint: number;
    color: number;
    metalness: number;
    normalScale: number;
    envMapIntensity: number;
    clearcoat: number;
  }
> = {
  wet_asphalt: {
    wetness: 0.88,
    puddleCoverage: 0.44,
    puddleScale: 0.105,
    puddleRoughness: 0.095,
    dryRoughness: 0.78,
    rippleStrength: 0.72,
    puddleTint: 0x0d1522,
    color: 0xa2b0c2,
    metalness: 0.06,
    normalScale: 1.15,
    envMapIntensity: 1.4,
    clearcoat: 0.85,
  },
  stone_plaza: {
    wetness: 0.68,
    puddleCoverage: 0.28,
    puddleScale: 0.145,
    puddleRoughness: 0.11,
    dryRoughness: 0.76,
    rippleStrength: 0.5,
    puddleTint: 0x111824,
    color: 0xbcb1a2,
    metalness: 0.04,
    normalScale: 1.0,
    envMapIntensity: 1.22,
    clearcoat: 0.65,
  },
  dresden_cobble: {
    wetness: 0.74,
    puddleCoverage: 0.34,
    puddleScale: 0.13,
    puddleRoughness: 0.105,
    dryRoughness: 0.74,
    rippleStrength: 0.45,
    puddleTint: 0x15141c,
    color: 0xaca090,
    metalness: 0.06,
    normalScale: 1.2,
    envMapIntensity: 1.28,
    clearcoat: 0.72,
  },
  interior_marble: {
    wetness: 0.22,
    puddleCoverage: 0.0,
    puddleScale: 0.25,
    puddleRoughness: 0.18,
    dryRoughness: 0.3,
    rippleStrength: 0.0,
    puddleTint: 0x161b26,
    color: 0xcbd5e1,
    metalness: 0.08,
    normalScale: 0.45,
    envMapIntensity: 1.1,
    clearcoat: 0.45,
  },
};

const WET_FRAGMENT_HELPERS = /* glsl */ `
varying vec3 vNsWorldPos;
uniform float uWetTime;
uniform float uWetness;
uniform float uPuddleCoverage;
uniform float uPuddleScale;
uniform float uPuddleRoughness;
uniform float uDryRoughness;
uniform float uRippleStrength;
uniform vec3 uPuddleTint;

float nsHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 nsHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float nsValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = nsHash21(i);
  float b = nsHash21(i + vec2(1.0, 0.0));
  float c = nsHash21(i + vec2(0.0, 1.0));
  float d = nsHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float nsPuddleFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.54;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += amp * nsValueNoise(p);
    p = rot * p * 2.07 + vec2(17.3, 9.2);
    amp *= 0.5;
  }
  return v;
}

// Concentric expanding raindrop ripples in world XZ space
vec2 nsRainRipples(vec2 xz, float t) {
  vec2 accum = vec2(0.0);
  // 2 staggered spatial scales for natural unrepetitive rain drops
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 1.65 : 2.85;
    vec2 uv = xz * scale + vec2(float(layer) * 19.7, float(layer) * 7.3);
    vec2 cell = floor(uv);
    vec2 local = fract(uv);

    vec2 rnd = nsHash22(cell + float(layer) * 41.0);
    float cycle = fract(t * (0.58 + rnd.x * 0.45) + rnd.y);
    vec2 center = 0.22 + 0.56 * rnd;
    vec2 diff = local - center;
    float d = length(diff) + 0.0001;

    float radius = cycle * 0.46;
    float ringDelta = d - radius;
    float wave = sin(ringDelta * 56.0) * exp(-abs(ringDelta) * 26.0);
    float env = (1.0 - cycle) * (1.0 - cycle) * smoothstep(0.0, 0.08, cycle);
    float radialCut = smoothstep(0.48, 0.14, d);

    accum += (diff / d) * wave * env * radialCut;
  }
  return accum;
}
`;

/**
 * Enhances an existing MeshPhysicalMaterial in-place with photorealistic world-space
 * rain puddles, physical moisture darkening, flattened water-mirror clearcoat, and
 * subtle animated raindrop ripples. Compatible with Three.js r174 WebGL2 shaders.
 */
export function enhanceWithWetPuddles(
  material: THREE.MeshPhysicalMaterial,
  params: WetSurfaceShaderParams = {}
): WetSurfaceMaterialHandle {
  const uniforms: WetShaderUniformBag = {
    uWetTime: { value: 0 },
    uWetness: { value: params.wetness ?? 0.85 },
    uPuddleCoverage: { value: params.puddleCoverage ?? 0.42 },
    uPuddleScale: { value: params.puddleScale ?? 0.11 },
    uPuddleRoughness: { value: params.puddleRoughness ?? 0.095 },
    uDryRoughness: { value: params.dryRoughness ?? 0.78 },
    uRippleStrength: { value: params.rippleStrength ?? 0.65 },
    uPuddleTint: { value: new THREE.Color(params.puddleTint ?? 0x0d1522) },
  };

  // Ensure clearcoat shader branch is compiled into MeshPhysicalMaterial
  if (material.clearcoat <= 0) {
    material.clearcoat = 0.75;
  }
  material.clearcoatRoughness = Math.min(material.clearcoatRoughness || 0.25, 0.35);

  const prevOnBeforeCompile = material.onBeforeCompile;
  material.customProgramCacheKey = () => 'nachtschicht-wet-surface-v1';

  material.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) {
      prevOnBeforeCompile.call(material, shader, renderer);
    }

    Object.assign(shader.uniforms, uniforms);

    // 1. Vertex shader: pass reliable world position (works even without USE_ENVMAP/USE_SHADOWMAP)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vNsWorldPos;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 nsWorldPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  nsWorldPosition = batchingMatrix * nsWorldPosition;
#endif
#ifdef USE_INSTANCING
  nsWorldPosition = instanceMatrix * nsWorldPosition;
#endif
nsWorldPosition = modelMatrix * nsWorldPosition;
vNsWorldPos = nsWorldPosition.xyz;`
      );

    // 2. Fragment shader: puddle mask, wet porous darkening, roughness & water-mirror normals
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${WET_FRAGMENT_HELPERS}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
// Multi-scale world-space puddle distribution modulated by PBR roughness depressions
float nsNoiseMacro = nsPuddleFbm( vNsWorldPos.xz * uPuddleScale );
float nsNoiseMicro = nsValueNoise( vNsWorldPos.xz * ( uPuddleScale * 6.5 ) );
float nsPuddleField = nsNoiseMacro * 0.84 + nsNoiseMicro * 0.16;

// Bias puddles slightly into smoother/recessed regions of the artist's roughnessMap
float nsCavityBias = ( 0.65 - clamp( roughnessFactor, 0.0, 1.0 ) ) * 0.18;
float nsThreshold = 1.0 - clamp( uPuddleCoverage, 0.0, 0.96 );
float nsPuddleMask = smoothstep( nsThreshold - 0.065, nsThreshold + 0.055, nsPuddleField + nsCavityBias );
nsPuddleMask *= step( 0.005, uPuddleCoverage ) * clamp( uWetness * 1.25, 0.0, 1.0 );

// Physical wet-surface darkening: water film traps light in porous asphalt/stone
float nsDampDarken = mix( 1.0, 0.68, clamp( uWetness, 0.0, 1.0 ) );
float nsPuddleDarken = mix( 1.0, 0.62, nsPuddleMask );
diffuseColor.rgb *= nsDampDarken * nsPuddleDarken;
diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * ( vec3( 0.72 ) + uPuddleTint * 0.85 ), nsPuddleMask * 0.35 );

// Blend damp textured aggregate roughness -> glossy standing water roughness (clamped >= uPuddleRoughness to avoid GGX firefly spikes)
float nsDampRough = mix( roughnessFactor, min( roughnessFactor * 0.82, uDryRoughness ), clamp( uWetness, 0.0, 1.0 ) * 0.65 );
roughnessFactor = max( mix( nsDampRough, uPuddleRoughness, nsPuddleMask ), max( uPuddleRoughness, 0.09 ) );`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
// Gravity flattens standing puddle water + adds subtle distance-faded raindrop ripples
if ( nsPuddleMask > 0.005 ) {
  vec3 nsFlatNormal = normalize( nonPerturbedNormal );
  normal = normalize( mix( normal, nsFlatNormal, nsPuddleMask * 0.92 ) );

  if ( uRippleStrength > 0.005 ) {
    float nsCamDist = length( vViewPosition );
    float nsRippleFade = smoothstep( 52.0, 6.0, nsCamDist ) * nsPuddleMask * uRippleStrength;
    if ( nsRippleFade > 0.004 ) {
      vec2 nsRip = nsRainRipples( vNsWorldPos.xz, uWetTime ) * 0.16 * nsRippleFade;
      vec3 nsRipWorld = normalize( vec3( nsRip.x, 1.0, nsRip.y ) );
      vec3 nsRipView = normalize( ( viewMatrix * vec4( nsRipWorld, 0.0 ) ).xyz );
      normal = normalize( mix( normal, nsRipView, clamp( nsRippleFade * 0.7, 0.0, 0.65 ) ) );
    }
  }
}`
      )
      .replace(
        '#include <clearcoat_normal_fragment_maps>',
        `#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
if ( nsPuddleMask > 0.005 ) {
  clearcoatNormal = normalize( mix( clearcoatNormal, normal, nsPuddleMask * 0.96 ) );
}
#endif`
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat = saturate( mix( material.clearcoat * uWetness * 0.32, 0.92, nsPuddleMask ) );
  material.clearcoatRoughness = max( mix( 0.32, uPuddleRoughness, nsPuddleMask ), 0.095 );
#endif`
      );
  };

  material.needsUpdate = true;

  return {
    material,
    update(dt: number) {
      uniforms.uWetTime.value += Math.max(0, Math.min(0.1, dt));
    },
    setTime(timeSec: number) {
      uniforms.uWetTime.value = timeSec;
    },
    setWetness(wetness: number) {
      uniforms.uWetness.value = Math.max(0, Math.min(1, wetness));
    },
    setPuddleCoverage(coverage: number) {
      uniforms.uPuddleCoverage.value = Math.max(0, Math.min(1, coverage));
    },
    setRippleStrength(strength: number) {
      uniforms.uRippleStrength.value = Math.max(0, Math.min(1, strength));
    },
    dispose() {
      material.dispose();
    },
  };
}

/**
 * Creates a calibrated photorealistic MeshPhysicalMaterial enhanced with multi-scale
 * wet night puddles & full PBR map binding (albedo, normal, roughness, AO).
 */
export function createWetSurfaceMaterial(
  options: WetSurfaceOptions = {}
): WetSurfaceMaterialHandle {
  const preset = PRESET_DEFAULTS[options.preset ?? 'wet_asphalt'];
  const maps = options.maps ?? {};

  // Ensure AO map samples UV0 cleanly when meshes don't define a second uv1 channel
  if (maps.aoMap) {
    maps.aoMap.channel = 0;
  }

  const mat = new THREE.MeshPhysicalMaterial({
    color: options.color ?? preset.color,
    map: maps.map ?? maps.albedo ?? null,
    normalMap: maps.normalMap ?? null,
    normalScale: new THREE.Vector2(
      options.normalScale ?? preset.normalScale,
      options.normalScale ?? preset.normalScale
    ),
    roughnessMap: maps.roughnessMap ?? null,
    aoMap: maps.aoMap ?? null,
    aoMapIntensity: options.aoMapIntensity ?? 0.85,
    roughness: options.dryRoughness ?? preset.dryRoughness,
    metalness: options.metalness ?? preset.metalness,
    clearcoat: preset.clearcoat,
    clearcoatRoughness: options.puddleRoughness ?? preset.puddleRoughness,
    reflectivity: 0.92,
    ior: 1.333, // Water-film index of refraction
    envMapIntensity: options.envMapIntensity ?? preset.envMapIntensity,
  });

  return enhanceWithWetPuddles(mat, {
    wetness: options.wetness ?? preset.wetness,
    puddleCoverage: options.puddleCoverage ?? preset.puddleCoverage,
    puddleScale: options.puddleScale ?? preset.puddleScale,
    puddleRoughness: options.puddleRoughness ?? preset.puddleRoughness,
    dryRoughness: options.dryRoughness ?? preset.dryRoughness,
    rippleStrength: options.rippleStrength ?? preset.rippleStrength,
    puddleTint: options.puddleTint ?? preset.puddleTint,
  });
}

/**
 * Utility loader for @artist's 4-map PBR material sets in `/assets/textures/`:
 * `${baseName}_albedo.webp`, `_normal.webp`, `_roughness.webp`, `_ao.webp`
 * with automatic fallback to legacy `/assets/textures/${baseName}.webp` albedo.
 */
export async function loadPbrTextureSet(
  baseName: string,
  repeatX = 1,
  repeatY = 1,
  anisotropy = 8
): Promise<PbrTextureSet> {
  const loader = new THREE.TextureLoader();

  const loadOptional = (
    url: string,
    isColor: boolean
  ): Promise<THREE.Texture | null> =>
    new Promise((resolve) => {
      loader.load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(repeatX, repeatY);
          tex.anisotropy = anisotropy;
          tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });

  const [albedoPbr, normalMap, roughnessMap, aoMap] = await Promise.all([
    loadOptional(`/assets/textures/${baseName}_albedo.webp`, true),
    loadOptional(`/assets/textures/${baseName}_normal.webp`, false),
    loadOptional(`/assets/textures/${baseName}_roughness.webp`, false),
    loadOptional(`/assets/textures/${baseName}_ao.webp`, false),
  ]);

  let albedo = albedoPbr;
  if (!albedo) {
    albedo = await loadOptional(`/assets/textures/${baseName}.webp`, true);
  }
  if (aoMap) {
    aoMap.channel = 0;
  }

  return { map: albedo, albedo, normalMap, roughnessMap, aoMap };
}
