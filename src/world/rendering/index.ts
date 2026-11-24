import * as THREE from 'three';
import type { TargetThemePalette } from '../../sim/types';
import {
  createEnvironmentLighting,
  configureWebGLRenderer,
  createStreetlampLight,
  resolveEnvironmentTheme,
  type EnvironmentLightingController,
  type EnvironmentLightingOptions,
  type EnvironmentTheme,
  type RenderQuality,
  type ResolvedEnvironmentTheme,
  type StreetlampLightOptions,
} from './environmentLighting';
import {
  createPostProcessing,
  detectRendererCapabilities,
  type CinematicFilmOptions,
  type PostProcessingController,
  type PostProcessingDiagnostics,
  type RendererCapabilities,
} from './postProcessing';
import {
  createWetSurfaceMaterial,
  enhanceWithWetPuddles,
  loadPbrTextureSet,
  type PbrTextureSet,
  type WetSurfaceMaterialHandle,
  type WetSurfaceOptions,
  type WetSurfacePreset,
  type WetSurfaceShaderParams,
} from './wetSurfaceMaterial';
import {
  createVolumetricAtmosphere,
  createVolumetricLightCone,
  type VolumetricAtmosphere,
  type VolumetricAtmosphereOptions,
  type VolumetricConeHandle,
  type VolumetricConeOptions,
  type VolumetricConePreset,
} from './volumetrics';

// ============================================================================
// NACHTSCHICHT — Unified Photorealistic Rendering Pipeline Facade
// Coordinates ACES Filmic Environment/PMREM IBL, WebGL2 EffectComposer
// (GTAO + Selective HDR UnrealBloom + OutputPass + 35mm Night Film Grading),
// Wet Night Puddle Materials, and Volumetric Light Cones / Coastal Mist / Rain.
// ============================================================================

export interface RenderPipelineOptions {
  theme?: EnvironmentTheme;
  palette?: Partial<TargetThemePalette>;
  focusPos?: { x: number; z: number };
  enableRain?: boolean;
  enableMist?: boolean;
  rainIntensity?: number;
  mistOpacity?: number;
  environmentUrls?: Partial<Record<ResolvedEnvironmentTheme, string>>;
}

export interface RenderPipelineDiagnostics extends PostProcessingDiagnostics {
  theme: ResolvedEnvironmentTheme;
  hasLoadedHdriMap: boolean;
  registeredWetMaterials: number;
}

export interface RenderPipeline {
  readonly quality: RenderQuality;
  readonly theme: ResolvedEnvironmentTheme;
  readonly environment: EnvironmentLightingController;
  readonly postProcessing: PostProcessingController;
  readonly volumetrics: VolumetricAtmosphere;

  /** Updates rain/mist/volumetric/wet-puddle shaders and renders the frame cleanly. */
  render(dt: number, focusPos?: THREE.Vector3 | { x: number; y?: number; z: number }): void;

  /** Resizes renderer & all post-processing render targets cleanly. */
  resize(width: number, height: number): void;

  /** Switches between 'ultra' | 'high' | 'medium' presets at runtime. */
  setQuality(quality: RenderQuality): void;

  /** Switches Salou / Dresden IBL environment, lighting hierarchy, film split-tone & mist. */
  setEnvironment(theme: EnvironmentTheme, palette?: Partial<TargetThemePalette>): void;

  /** Updates moonlight shadow frustum tracking & rain/mist focus center (player/vehicle). */
  setFocusPoint(x: number, z: number, y?: number, shadowRadius?: number): void;

  /** Registers wet-surface material handles so render(dt) animates puddle rain ripples. */
  registerWetMaterial(handle: WetSurfaceMaterialHandle): void;
  unregisterWetMaterial(handle: WetSurfaceMaterialHandle): void;

  /** Dynamic scene state hooks (blackout, alarm vignette pulse, binoculars, rain, cellar). */
  setPowerDisabled(disabled: boolean): void;
  setAlarmIntensity(intensity: number): void;
  setBinocularsActive(active: boolean): void;
  setRainIntensity(intensity: number): void;
  setIndoorCutaway(indoor: boolean): void;

  /** Runtime GPU/composer diagnostics for debug overlays & QA verification. */
  getDiagnostics(): RenderPipelineDiagnostics;

  /** Disposes composer, render targets, PMREM env maps, lights & volumetric layers. */
  dispose(): void;
}

export function createRenderPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: RenderQuality = 'high',
  options: RenderPipelineOptions = {}
): RenderPipeline {
  let currentQuality: RenderQuality = quality;
  let currentTheme: ResolvedEnvironmentTheme = resolveEnvironmentTheme(options.theme ?? 'salou');
  let disposed = false;

  const focusVec = new THREE.Vector3(
    options.focusPos?.x ?? 0,
    0,
    options.focusPos?.z ?? 0
  );
  const wetMaterials = new Set<WetSurfaceMaterialHandle>();

  // Probe WebGL2 / HalfFloat / SwiftShader capabilities first so every subsystem adapts safely
  const capabilities = detectRendererCapabilities(renderer);

  // 1. Environment Lighting + PMREM Night HDRI IBL + Focused PCFSoft Shadows
  const environment = createEnvironmentLighting(renderer, scene, {
    theme: currentTheme,
    quality: currentQuality,
    palette: options.palette,
    focusPos: options.focusPos,
    environmentUrls: options.environmentUrls,
    isSoftwareRenderer: capabilities.isSoftwareRenderer,
  });

  // 2. EffectComposer Post-Processing (GTAO on ultra HW + Selective HDR Bloom + ACES + 35mm Film)
  const postProcessing = createPostProcessing(
    renderer,
    scene,
    camera,
    currentQuality,
    currentTheme
  );

  // 3. Volumetric Night Atmosphere (Light Cones Registry + Coastal Mist + GPU Rain/Ripples)
  const volumetrics = createVolumetricAtmosphere(scene, {
    quality: currentQuality,
    theme: currentTheme,
    enableRain: options.enableRain,
    enableMist: options.enableMist,
    rainIntensity: options.rainIntensity,
    mistOpacity: options.mistOpacity,
  });

  return {
    get quality() {
      return currentQuality;
    },
    get theme() {
      return currentTheme;
    },
    environment,
    postProcessing,
    volumetrics,

    render(dt: number, focusPos?: THREE.Vector3 | { x: number; y?: number; z: number }) {
      if (disposed) return;
      const safeDt = Math.max(0, Math.min(0.1, dt || 0.016));

      if (focusPos) {
        const fx = focusPos.x;
        const fy = focusPos.y ?? 0;
        const fz = focusPos.z;
        focusVec.set(fx, fy, fz);
        environment.setShadowFocus(fx, fz);
      }

      // Advance animated raindrop puddle ripples on all registered wet materials
      for (const wet of wetMaterials) {
        wet.update(safeDt);
      }

      // Advance volumetric light haze, drifting coastal mist, rain streaks & puddle splashes
      volumetrics.update(safeDt, focusVec);

      // Render through linear HDR EffectComposer (or safe direct ACES fallback)
      postProcessing.render(safeDt);
    },

    resize(width: number, height: number) {
      if (disposed) return;
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      renderer.setSize(w, h, false);
      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const persp = camera as THREE.PerspectiveCamera;
        persp.aspect = w / h;
        persp.updateProjectionMatrix();
      }
      postProcessing.resize(w, h);
    },

    setQuality(nextQuality: RenderQuality) {
      if (disposed) return;
      currentQuality = nextQuality;
      environment.setQuality(nextQuality, capabilities.isSoftwareRenderer);
      postProcessing.setQuality(nextQuality);
      volumetrics.setQuality(nextQuality);
    },

    setEnvironment(theme: EnvironmentTheme, palette?: Partial<TargetThemePalette>) {
      if (disposed) return;
      currentTheme = resolveEnvironmentTheme(theme);
      environment.setTheme(theme, palette);
      postProcessing.setThemeMood(currentTheme);
      volumetrics.setTheme(currentTheme);
    },

    setFocusPoint(x: number, z: number, y = 0, shadowRadius?: number) {
      if (disposed) return;
      focusVec.set(x, y, z);
      environment.setShadowFocus(x, z, shadowRadius);
    },

    registerWetMaterial(handle: WetSurfaceMaterialHandle) {
      wetMaterials.add(handle);
    },

    unregisterWetMaterial(handle: WetSurfaceMaterialHandle) {
      wetMaterials.delete(handle);
    },

    setPowerDisabled(disabled: boolean) {
      if (disposed) return;
      environment.setPowerCutFactor(disabled ? 0.65 : 0);
    },

    setAlarmIntensity(intensity: number) {
      if (disposed) return;
      postProcessing.setAlarmIntensity(intensity);
    },

    setBinocularsActive(active: boolean) {
      if (disposed) return;
      postProcessing.setBinocularsActive(active);
    },

    setRainIntensity(intensity: number) {
      if (disposed) return;
      volumetrics.setRainIntensity(intensity);
    },

    setIndoorCutaway(indoor: boolean) {
      if (disposed) return;
      volumetrics.setIndoorCutaway(indoor);
    },

    getDiagnostics(): RenderPipelineDiagnostics {
      return {
        ...postProcessing.getDiagnostics(),
        theme: currentTheme,
        hasLoadedHdriMap: environment.hasLoadedHdriMap,
        registeredWetMaterials: wetMaterials.size,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      wetMaterials.clear();
      volumetrics.dispose();
      postProcessing.dispose();
      environment.dispose();
    },
  };
}

// Re-export all rendering primitives & types for direct use by @world, @npc-brain, @driving-sim
export {
  createEnvironmentLighting,
  configureWebGLRenderer,
  createStreetlampLight,
  resolveEnvironmentTheme,
  createPostProcessing,
  detectRendererCapabilities,
  createWetSurfaceMaterial,
  enhanceWithWetPuddles,
  loadPbrTextureSet,
  createVolumetricAtmosphere,
  createVolumetricLightCone,
};

export type {
  RenderQuality,
  EnvironmentTheme,
  ResolvedEnvironmentTheme,
  EnvironmentLightingOptions,
  EnvironmentLightingController,
  StreetlampLightOptions,
  RendererCapabilities,
  PostProcessingDiagnostics,
  PostProcessingController,
  CinematicFilmOptions,
  WetSurfacePreset,
  PbrTextureSet,
  WetSurfaceShaderParams,
  WetSurfaceOptions,
  WetSurfaceMaterialHandle,
  VolumetricConePreset,
  VolumetricConeOptions,
  VolumetricConeHandle,
  VolumetricAtmosphereOptions,
  VolumetricAtmosphere,
};
