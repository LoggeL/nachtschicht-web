import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { RenderQuality, ResolvedEnvironmentTheme } from './environmentLighting';

// ============================================================================
// NACHTSCHICHT — Photorealistic WebGL2 EffectComposer Post-Processing Stack
// Linear HDR RenderPass -> (Ultra HW) Filtered GTAOPass -> Selective HDR
// UnrealBloomPass -> OutputPass (ACES Filmic + sRGB) -> 35mm Cinematic Night
// Film ShaderPass, with automatic WebGL/SwiftShader capability probing & zero-
// black-screen safe fallback.
// ============================================================================

export interface RendererCapabilities {
  isWebGL2: boolean;
  isSoftwareRenderer: boolean;
  rendererName: string;
  supportsHalfFloatRT: boolean;
  supportsDepthTexture: boolean;
  maxMsaaSamples: number;
}

export interface PostProcessingDiagnostics {
  quality: RenderQuality;
  effectiveMode: 'composer' | 'direct';
  isSoftwareRenderer: boolean;
  rendererName: string;
  supportsHalfFloatRT: boolean;
  gtaoActive: boolean;
  bloomActive: boolean;
  filmPassActive: boolean;
  msaaSamples: number;
  fallbackReason: string | null;
}

export interface CinematicFilmOptions {
  contrast?: number;
  saturation?: number;
  shadowLift?: number;
  vignetteStrength?: number;
  vignetteSoftness?: number;
  grainIntensity?: number;
  chromaticAberration?: number;
  shadowTint?: THREE.ColorRepresentation;
  highlightTint?: THREE.ColorRepresentation;
}

export interface PostProcessingController {
  readonly quality: RenderQuality;
  readonly capabilities: RendererCapabilities;
  readonly composer: EffectComposer | null;
  readonly bloomPass: UnrealBloomPass | null;
  readonly gtaoPass: GTAOPass | null;
  readonly filmPass: ShaderPass | null;

  render(dt: number): void;
  resize(width: number, height: number): void;
  setQuality(quality: RenderQuality): void;
  setThemeMood(theme: ResolvedEnvironmentTheme): void;
  setAlarmIntensity(intensity: number): void;
  setBinocularsActive(active: boolean): void;
  setFilmOptions(options: CinematicFilmOptions): void;
  getDiagnostics(): PostProcessingDiagnostics;
  dispose(): void;
}

/**
 * Probes live WebGL capabilities including actual HalfFloat framebuffer completeness
 * and SwiftShader/Mesa software renderer detection.
 */
export function detectRendererCapabilities(
  renderer: THREE.WebGLRenderer
): RendererCapabilities {
  const gl = renderer.getContext();
  const isWebGL2 = renderer.capabilities.isWebGL2;

  let rendererName = 'unknown';
  try {
    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugExt) {
      const unmasked = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL);
      if (typeof unmasked === 'string' && unmasked.length > 0) {
        rendererName = unmasked;
      }
    }
    if (rendererName === 'unknown') {
      const raw = gl.getParameter(gl.RENDERER);
      if (typeof raw === 'string' && raw.length > 0) {
        rendererName = raw;
      }
    }
  } catch {
    // Ignore restricted context parameter reads
  }

  const isSoftwareRenderer =
    /swiftshader|llvmpipe|softpipe|software|mesa offscreen|angle.*swiftshader/i.test(
      rendererName
    );

  // Verify real HalfFloat color attachment renderability with an isolated 4x4 probe FBO
  let supportsHalfFloatRT = false;
  try {
    const hasExt = isWebGL2
      ? Boolean(
          gl.getExtension('EXT_color_buffer_float') ||
            gl.getExtension('EXT_color_buffer_half_float')
        )
      : Boolean(
          gl.getExtension('OES_texture_half_float') &&
            gl.getExtension('EXT_color_buffer_half_float')
        );

    if (hasExt && isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      const prevFbo = gl2.getParameter(gl2.FRAMEBUFFER_BINDING);
      const prevTex = gl2.getParameter(gl2.TEXTURE_BINDING_2D);

      const fbo = gl2.createFramebuffer();
      const tex = gl2.createTexture();
      if (fbo && tex) {
        gl2.bindTexture(gl2.TEXTURE_2D, tex);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.NEAREST);
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.NEAREST);
        gl2.texImage2D(
          gl2.TEXTURE_2D,
          0,
          gl2.RGBA16F,
          4,
          4,
          0,
          gl2.RGBA,
          gl2.HALF_FLOAT,
          null
        );
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
        gl2.framebufferTexture2D(
          gl2.FRAMEBUFFER,
          gl2.COLOR_ATTACHMENT0,
          gl2.TEXTURE_2D,
          tex,
          0
        );
        const status = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER);
        supportsHalfFloatRT = status === gl2.FRAMEBUFFER_COMPLETE;

        gl2.bindFramebuffer(gl2.FRAMEBUFFER, prevFbo);
        gl2.bindTexture(gl2.TEXTURE_2D, prevTex);
        gl2.deleteFramebuffer(fbo);
        gl2.deleteTexture(tex);
      }
    } else if (hasExt) {
      supportsHalfFloatRT = true;
    }
  } catch {
    supportsHalfFloatRT = false;
  }

  const supportsDepthTexture =
    isWebGL2 || Boolean(gl.getExtension('WEBGL_depth_texture'));

  const maxMsaaSamples =
    isWebGL2 && !isSoftwareRenderer
      ? Math.min(4, renderer.capabilities.maxSamples || 0)
      : 0;

  return {
    isWebGL2,
    isSoftwareRenderer,
    rendererName,
    supportsHalfFloatRT,
    supportsDepthTexture,
    maxMsaaSamples,
  };
}

/**
 * GTAOPass subclass that excludes sprites and non-depth-writing transparent meshes
 * (volumetric light cones, rain streaks, coastal mist, laser beams) from the AO GBuffer
 * so soft atmospheric effects never produce dark ambient-occlusion halos.
 */
class FilteredGTAOPass extends GTAOPass {
  private excludedObjects: THREE.Object3D[] = [];

  override overrideVisibility(): void {
    super.overrideVisibility();
    this.excludedObjects.length = 0;

    this.scene.traverse((obj) => {
      if (!obj.visible) return;
      if (obj.userData?.excludeFromAO === true || (obj as THREE.Sprite).isSprite) {
        obj.visible = false;
        this.excludedObjects.push(obj);
        return;
      }
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const allSoftTransparent =
          mats.length > 0 && mats.every((m) => Boolean(m && m.transparent && !m.depthWrite));
        if (allSoftTransparent) {
          obj.visible = false;
          this.excludedObjects.push(obj);
        }
      }
    });
  }

  override restoreVisibility(): void {
    super.restoreVisibility();
    for (let i = 0; i < this.excludedObjects.length; i++) {
      this.excludedObjects[i].visible = true;
    }
    this.excludedObjects.length = 0;
  }

  override dispose(): void {
    super.dispose();
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
  }
}

/**
 * Custom 35mm European Night-Thriller Cinematic Film Grading Shader (display sRGB space).
 * Runs AFTER OutputPass (ACES Filmic + sRGB transfer) for clean, perceptually uniform
 * S-curve contrast, cool-shadow / warm-highlight split-toning, optical lens vignette,
 * delicate animated 35mm grain, optional ultra-subtle edge chromatic aberration, and
 * alarm/binocular tension hooks.
 */
const CinematicNightFilmShader = {
  name: 'NachtschichtCinematicFilmShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uContrast: { value: 1.055 },
    uSaturation: { value: 1.04 },
    uShadowLift: { value: 0.012 },
    uShadowTint: { value: new THREE.Color(0x0b1a30) },
    uHighlightTint: { value: new THREE.Color(0xfff1dc) },
    uSplitStrength: { value: 0.16 },
    uVignetteStrength: { value: 0.26 },
    uVignetteSoftness: { value: 0.62 },
    uGrainIntensity: { value: 0.022 },
    uChromaticAberration: { value: 0.0 },
    uAlarmIntensity: { value: 0.0 },
    uBinocularsActive: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uShadowLift;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uSplitStrength;
    uniform float uVignetteStrength;
    uniform float uVignetteSoftness;
    uniform float uGrainIntensity;
    uniform float uChromaticAberration;
    uniform float uAlarmIntensity;
    uniform float uBinocularsActive;

    varying vec2 vUv;

    // Fast high-frequency interleaved gradient noise for organic 35mm film grain
    float filmNoise(vec2 pixelCoord, float timeSeed) {
      vec3 p3 = fract(vec3(pixelCoord.xyx) * 0.1031 + vec3(timeSeed * 0.37, timeSeed * 0.71, timeSeed * 0.53));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z) - 0.5;
    }

    void main() {
      vec2 centered = vUv - 0.5;
      float radiusSq = dot(centered, centered);

      // Optional micro optical chromatic aberration only near screen corners (ultra preset)
      vec3 col;
      float ca = uChromaticAberration * (1.0 + uBinocularsActive * 0.8);
      if (ca > 0.00001) {
        vec2 offset = centered * radiusSq * ca * 4.5;
        col.r = texture2D(tDiffuse, clamp(vUv + offset, 0.001, 0.999)).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, clamp(vUv - offset, 0.001, 0.999)).b;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      // Gentle shadow floor lift so noir darks retain 35mm detail instead of clipping to #000
      col = col * (1.0 - uShadowLift) + uShadowLift;

      // Filmic S-curve contrast centered on perceptual mid-gray
      vec3 sCurve = col * col * (3.0 - 2.0 * col);
      col = mix(col, sCurve, clamp((uContrast - 1.0) * 2.2, 0.0, 0.45));
      col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);

      // Subtle cinematic saturation calibration
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // Cool midnight shadow / warm sodium-gold highlight split-toning
      float shadowMask = pow(1.0 - clamp(luma, 0.0, 1.0), 2.1);
      float highlightMask = pow(clamp(luma, 0.0, 1.0), 1.7);
      col = mix(col, col * (vec3(0.84) + uShadowTint * 1.15), shadowMask * uSplitStrength);
      col = mix(col, col * uHighlightTint, highlightMask * uSplitStrength * 0.85);

      // Subtle optical clarity boost when viewing through night binoculars
      if (uBinocularsActive > 0.01) {
        vec3 binoCol = mix(col, col * vec3(0.92, 1.02, 1.06), 0.35 * uBinocularsActive);
        col = binoCol;
      }

      // Delicate optical lens vignette
      float dist = length(centered * vec2(1.18, 1.0));
      float vig = smoothstep(0.92, uVignetteSoftness * 0.55, dist);
      float vigFactor = mix(1.0 - uVignetteStrength, 1.0, vig);
      col *= vigFactor;

      // Subtle warm crimson edge tension when heist alarm is active
      if (uAlarmIntensity > 0.005) {
        float edgeMask = smoothstep(0.32, 0.78, dist) * uAlarmIntensity;
        col = mix(col, col + vec3(0.26, 0.02, 0.02), edgeMask * 0.38);
      }

      // Subtle animated 35mm film grain (stronger in mid-shadows, quieter in blown highlights)
      if (uGrainIntensity > 0.0001) {
        float grainMask = 1.0 - smoothstep(0.65, 1.0, luma) * 0.65;
        float g = filmNoise(vUv * uResolution, mod(uTime * 24.0, 240.0));
        col += vec3(g) * uGrainIntensity * grainMask;
      }

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

interface QualityStackProfile {
  useGtao: boolean;
  useBloom: boolean;
  bloomThreshold: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomMaxRadiance: number;
  msaaSamples: number;
  vignetteStrength: number;
  grainIntensity: number;
  chromaticAberration: number;
  contrast: number;
}

const QUALITY_PROFILES: Record<RenderQuality, QualityStackProfile> = {
  ultra: {
    useGtao: true,
    useBloom: true,
    bloomThreshold: 1.04,
    bloomStrength: 0.4,
    bloomRadius: 0.42,
    bloomMaxRadiance: 2.2,
    msaaSamples: 4,
    vignetteStrength: 0.27,
    grainIntensity: 0.026,
    chromaticAberration: 0.00048,
    contrast: 1.065,
  },
  high: {
    useGtao: false,
    useBloom: true,
    bloomThreshold: 1.08,
    bloomStrength: 0.35,
    bloomRadius: 0.38,
    bloomMaxRadiance: 2.1,
    msaaSamples: 4,
    vignetteStrength: 0.24,
    grainIntensity: 0.02,
    chromaticAberration: 0.0,
    contrast: 1.05,
  },
  medium: {
    useGtao: false,
    useBloom: true,
    bloomThreshold: 1.15,
    bloomStrength: 0.25,
    bloomRadius: 0.32,
    bloomMaxRadiance: 1.9,
    msaaSamples: 0,
    vignetteStrength: 0.18,
    grainIntensity: 0.012,
    chromaticAberration: 0.0,
    contrast: 1.03,
  },
};

const FIREFLY_CLAMP_BLOOM_HIGHPASS_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform float uMaxBloomRadiance;
uniform vec2 uTexelSize;

varying vec2 vUv;

float nsBloomLuma(vec3 c) {
  return dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
}

vec3 nsSampleSoftClamped(vec2 uv) {
  vec3 c = max(texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb, vec3(0.0));
  c = min(c, vec3(32.0));
  float l = nsBloomLuma(c);
  float maxIn = uMaxBloomRadiance * 2.2;
  float compressed = (l * maxIn) / (l + maxIn);
  return c * (compressed / max(l, 0.0001));
}

void main() {
  // 5-tap Karis-weighted cross downsample prevents sharp PointLight/GGX specular spikes
  // from saturating lower separable Gaussian bloom mips into square box artifacts.
  vec3 c0 = nsSampleSoftClamped(vUv);
  vec3 c1 = nsSampleSoftClamped(vUv + vec2( uTexelSize.x,  uTexelSize.y));
  vec3 c2 = nsSampleSoftClamped(vUv + vec2(-uTexelSize.x,  uTexelSize.y));
  vec3 c3 = nsSampleSoftClamped(vUv + vec2( uTexelSize.x, -uTexelSize.y));
  vec3 c4 = nsSampleSoftClamped(vUv + vec2(-uTexelSize.x, -uTexelSize.y));

  float w0 = 2.0 / (1.0 + nsBloomLuma(c0));
  float w1 = 1.0 / (1.0 + nsBloomLuma(c1));
  float w2 = 1.0 / (1.0 + nsBloomLuma(c2));
  float w3 = 1.0 / (1.0 + nsBloomLuma(c3));
  float w4 = 1.0 / (1.0 + nsBloomLuma(c4));

  vec3 color = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4) / max(w0 + w1 + w2 + w3 + w4, 0.0001);
  float luma = nsBloomLuma(color);

  float knee = max(smoothWidth, 0.28);
  float mask = smoothstep(luminosityThreshold, luminosityThreshold + knee, luma);
  float excess = max(0.0, luma - luminosityThreshold * 0.85);
  float capped = (excess * uMaxBloomRadiance) / (excess + uMaxBloomRadiance);

  vec3 bloomRgb = color * (capped / max(luma, 0.0001)) * mask;
  gl_FragColor = vec4(mix(defaultColor, bloomRgb, mask), mix(defaultOpacity, 1.0, mask));
}
`;

function patchBloomPassFireflyClamp(
  bPass: UnrealBloomPass,
  width: number,
  height: number,
  maxRadiance: number
): void {
  const uniforms = bPass.materialHighPassFilter.uniforms as Record<string, THREE.IUniform>;
  uniforms.smoothWidth = { value: 0.28 };
  uniforms.uMaxBloomRadiance = { value: maxRadiance };
  uniforms.uTexelSize = {
    value: new THREE.Vector2(1 / Math.max(1, width), 1 / Math.max(1, height)),
  };
  bPass.materialHighPassFilter.fragmentShader = FIREFLY_CLAMP_BLOOM_HIGHPASS_FRAG;
  bPass.materialHighPassFilter.needsUpdate = true;

  // Replace Three.js UnrealBloomPass's 1-sigma truncated box-like Gaussian weights
  // (which cliff-drop from 0.61 -> 0 at the kernel edge and stamp bright HDR glints
  // into visible squares) with a smooth 2.5-sigma tapered Gaussian for circular halos.
  const kernelSizes = [3, 5, 7, 9, 11];
  for (let m = 0; m < bPass.separableBlurMaterials.length; m++) {
    const mat = bPass.separableBlurMaterials[m];
    const radius = kernelSizes[m] ?? 5;
    const sigma = Math.max(0.85, (radius - 1) / 2.5);
    const coeffs: number[] = [];
    for (let i = 0; i < radius; i++) {
      coeffs.push(Math.exp((-0.5 * i * i) / (sigma * sigma)));
    }
    if (mat.uniforms.gaussianCoefficients) {
      mat.uniforms.gaussianCoefficients.value = coeffs;
    }
  }
}

export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  initialQuality: RenderQuality = 'high',
  initialTheme: ResolvedEnvironmentTheme = 'salou'
): PostProcessingController {
  const capabilities = detectRendererCapabilities(renderer);
  let currentQuality: RenderQuality = initialQuality;
  let currentTheme: ResolvedEnvironmentTheme = initialTheme;
  let elapsedSec = 0;
  let alarmIntensity = 0;
  let binocularsActive = false;
  let disposed = false;

  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let gtaoPass: FilteredGTAOPass | null = null;
  let bloomPass: UnrealBloomPass | null = null;
  let outputPass: OutputPass | null = null;
  let filmPass: ShaderPass | null = null;

  let effectiveMode: 'composer' | 'direct' = 'direct';
  let fallbackReason: string | null = null;
  let activeMsaaSamples = 0;
  let customFilmOverrides: CinematicFilmOptions = {};

  const sizeVec = new THREE.Vector2();
  renderer.getSize(sizeVec);
  let viewportW = Math.max(1, Math.round(sizeVec.x));
  let viewportH = Math.max(1, Math.round(sizeVec.y));

  const disposeComposerStack = () => {
    if (gtaoPass) {
      gtaoPass.dispose();
      gtaoPass = null;
    }
    if (bloomPass) {
      bloomPass.materialHighPassFilter.dispose();
      bloomPass.dispose();
      bloomPass = null;
    }
    if (outputPass) {
      outputPass.dispose();
      outputPass = null;
    }
    if (filmPass) {
      filmPass.dispose();
      filmPass = null;
    }
    if (composer) {
      composer.dispose();
      composer = null;
    }
    renderPass = null;
    activeMsaaSamples = 0;
  };

  const applyThemeGrading = () => {
    if (!filmPass) return;
    const u = filmPass.uniforms;
    if (currentTheme === 'dresden') {
      (u.uShadowTint.value as THREE.Color).setHex(0x10172b);
      (u.uHighlightTint.value as THREE.Color).setHex(0xffe9c8);
      u.uSplitStrength.value = 0.19;
    } else {
      (u.uShadowTint.value as THREE.Color).setHex(0x0a1c33);
      (u.uHighlightTint.value as THREE.Color).setHex(0xfff0d9);
      u.uSplitStrength.value = 0.16;
    }
    applyFilmOverrides();
  };

  const applyFilmOverrides = () => {
    if (!filmPass) return;
    const u = filmPass.uniforms;
    const o = customFilmOverrides;
    if (o.contrast !== undefined) u.uContrast.value = o.contrast;
    if (o.saturation !== undefined) u.uSaturation.value = o.saturation;
    if (o.shadowLift !== undefined) u.uShadowLift.value = o.shadowLift;
    if (o.vignetteStrength !== undefined) u.uVignetteStrength.value = o.vignetteStrength;
    if (o.vignetteSoftness !== undefined) u.uVignetteSoftness.value = o.vignetteSoftness;
    if (o.grainIntensity !== undefined) u.uGrainIntensity.value = o.grainIntensity;
    if (o.chromaticAberration !== undefined) {
      u.uChromaticAberration.value = o.chromaticAberration;
    }
    if (o.shadowTint !== undefined) (u.uShadowTint.value as THREE.Color).set(o.shadowTint);
    if (o.highlightTint !== undefined) {
      (u.uHighlightTint.value as THREE.Color).set(o.highlightTint);
    }
  };

  const rebuildPipeline = () => {
    disposeComposerStack();

    if (!capabilities.supportsHalfFloatRT) {
      effectiveMode = 'direct';
      fallbackReason = 'HalfFloat WebGL render target unsupported; using direct ACES render.';
      return;
    }

    try {
      const profile = QUALITY_PROFILES[currentQuality];
      const dpr = renderer.getPixelRatio();
      const rtW = Math.max(1, Math.floor(viewportW * dpr));
      const rtH = Math.max(1, Math.floor(viewportH * dpr));

      const desiredSamples = capabilities.isSoftwareRenderer
        ? 0
        : Math.min(profile.msaaSamples, capabilities.maxMsaaSamples);

      const renderTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
        type: THREE.HalfFloatType,
        samples: desiredSamples,
      });
      renderTarget.texture.name = 'Nachtschicht_HDR_RT';
      activeMsaaSamples = desiredSamples;

      const comp = new EffectComposer(renderer, renderTarget);
      comp.setPixelRatio(dpr);
      comp.setSize(viewportW, viewportH);

      // 1. Linear HDR Scene Render
      const rPass = new RenderPass(scene, camera);
      comp.addPass(rPass);
      renderPass = rPass;

      // 2. Ground-Truth Ambient Occlusion (ultra preset on hardware GPUs only)
      const enableGtao =
        profile.useGtao &&
        !capabilities.isSoftwareRenderer &&
        capabilities.isWebGL2 &&
        capabilities.supportsDepthTexture;

      if (enableGtao) {
        const aoPass = new FilteredGTAOPass(scene, camera, rtW, rtH);
        aoPass.output = GTAOPass.OUTPUT.Default;
        aoPass.blendIntensity = 0.58;
        aoPass.updateGtaoMaterial({
          radius: 0.58,
          distanceExponent: 1.75,
          thickness: 1.15,
          distanceFallOff: 0.9,
          scale: 1.12,
          samples: 12,
          screenSpaceRadius: false,
        });
        aoPass.updatePdMaterial({
          lumaPhi: 10,
          depthPhi: 2.2,
          normalPhi: 3.0,
          radius: 6,
          radiusExponent: 2,
          rings: 2,
          samples: 8,
        });
        comp.addPass(aoPass);
        gtaoPass = aoPass;
      }

      // 3. Selective Linear HDR Unreal Bloom (Karis firefly-clamped high-pass -> circular halos)
      if (profile.useBloom) {
        const bPass = new UnrealBloomPass(
          new THREE.Vector2(viewportW, viewportH),
          capabilities.isSoftwareRenderer
            ? profile.bloomStrength * 0.8
            : profile.bloomStrength,
          profile.bloomRadius,
          profile.bloomThreshold
        );
        patchBloomPassFireflyClamp(bPass, rtW, rtH, profile.bloomMaxRadiance);
        comp.addPass(bPass);
        bloomPass = bPass;
      }

      // 4. ACES Filmic Tone Mapping + Linear-to-sRGB Transfer
      const oPass = new OutputPass();
      comp.addPass(oPass);
      outputPass = oPass;

      // 5. 35mm Cinematic Night Film Grading Shader (display sRGB space)
      const fPass = new ShaderPass(CinematicNightFilmShader);
      fPass.uniforms.uResolution.value.set(rtW, rtH);
      fPass.uniforms.uContrast.value = profile.contrast;
      fPass.uniforms.uVignetteStrength.value = profile.vignetteStrength;
      fPass.uniforms.uGrainIntensity.value = capabilities.isSoftwareRenderer
        ? Math.min(0.012, profile.grainIntensity)
        : profile.grainIntensity;
      fPass.uniforms.uChromaticAberration.value = capabilities.isSoftwareRenderer
        ? 0.0
        : profile.chromaticAberration;
      fPass.uniforms.uAlarmIntensity.value = alarmIntensity;
      fPass.uniforms.uBinocularsActive.value = binocularsActive ? 1.0 : 0.0;
      comp.addPass(fPass);
      filmPass = fPass;

      composer = comp;
      effectiveMode = 'composer';
      fallbackReason = null;
      applyThemeGrading();
    } catch (err) {
      disposeComposerStack();
      effectiveMode = 'direct';
      fallbackReason =
        err instanceof Error
          ? `Composer initialization fallback: ${err.message}`
          : 'Composer initialization fallback.';
    }
  };

  rebuildPipeline();

  return {
    get quality() {
      return currentQuality;
    },
    capabilities,
    get composer() {
      return composer;
    },
    get bloomPass() {
      return bloomPass;
    },
    get gtaoPass() {
      return gtaoPass;
    },
    get filmPass() {
      return filmPass;
    },

    render(dt: number) {
      if (disposed) return;
      const safeDt = Math.max(0, Math.min(0.1, dt || 0.016));
      elapsedSec += safeDt;

      if (effectiveMode === 'composer' && composer) {
        if (renderPass) {
          renderPass.scene = scene;
          renderPass.camera = camera;
        }
        if (gtaoPass) {
          gtaoPass.scene = scene;
          gtaoPass.camera = camera;
        }
        if (filmPass) {
          filmPass.uniforms.uTime.value = elapsedSec;
          filmPass.uniforms.uAlarmIntensity.value = alarmIntensity;
          filmPass.uniforms.uBinocularsActive.value = binocularsActive ? 1.0 : 0.0;
        }
        try {
          composer.render(safeDt);
          return;
        } catch (err) {
          // Runtime safety net: immediately fall back to direct ACES render if WebGL FBO fails
          disposeComposerStack();
          effectiveMode = 'direct';
          fallbackReason =
            err instanceof Error ? `Runtime composer fallback: ${err.message}` : 'Runtime fallback';
        }
      }

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },

    resize(width: number, height: number) {
      if (disposed) return;
      viewportW = Math.max(1, Math.round(width));
      viewportH = Math.max(1, Math.round(height));

      if (composer) {
        const dpr = renderer.getPixelRatio();
        const rtW = Math.max(1, Math.floor(viewportW * dpr));
        const rtH = Math.max(1, Math.floor(viewportH * dpr));
        composer.setPixelRatio(dpr);
        composer.setSize(viewportW, viewportH);
        if (bloomPass) {
          const texelUniform = (
            bloomPass.materialHighPassFilter.uniforms as Record<string, THREE.IUniform>
          ).uTexelSize;
          if (texelUniform && texelUniform.value instanceof THREE.Vector2) {
            texelUniform.value.set(1 / rtW, 1 / rtH);
          }
        }
        if (filmPass) {
          filmPass.uniforms.uResolution.value.set(rtW, rtH);
        }
      }
    },

    setQuality(quality: RenderQuality) {
      if (disposed) return;
      currentQuality = quality;
      rebuildPipeline();
    },

    setThemeMood(theme: ResolvedEnvironmentTheme) {
      if (disposed) return;
      currentTheme = theme;
      applyThemeGrading();
    },

    setAlarmIntensity(intensity: number) {
      alarmIntensity = Math.max(0, Math.min(1, intensity));
    },

    setBinocularsActive(active: boolean) {
      binocularsActive = active;
    },

    setFilmOptions(options: CinematicFilmOptions) {
      customFilmOverrides = { ...customFilmOverrides, ...options };
      applyFilmOverrides();
    },

    getDiagnostics(): PostProcessingDiagnostics {
      return {
        quality: currentQuality,
        effectiveMode,
        isSoftwareRenderer: capabilities.isSoftwareRenderer,
        rendererName: capabilities.rendererName,
        supportsHalfFloatRT: capabilities.supportsHalfFloatRT,
        gtaoActive: Boolean(gtaoPass && gtaoPass.enabled),
        bloomActive: Boolean(bloomPass && bloomPass.enabled),
        filmPassActive: Boolean(filmPass && filmPass.enabled),
        msaaSamples: activeMsaaSamples,
        fallbackReason,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      disposeComposerStack();
    },
  };
}
