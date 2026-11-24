import * as THREE from 'three';
import type { TargetDistrict, TargetId, TargetThemePalette } from '../../sim/types';

// ============================================================================
// NACHTSCHICHT — Photorealistic Night Environment Lighting & PMREM IBL
// Physical ACES Filmic calibration, procedural HDR night city sky probe with
// seamless upgrade to @artist's equirectangular WebP environment maps, plus
// focus-tracking texel-snapped PCFSoft moonlight & sodium-vapor hierarchy.
// ============================================================================

export type RenderQuality = 'ultra' | 'high' | 'medium';

export type EnvironmentTheme =
  | 'salou'
  | 'dresden'
  | 'Salou'
  | 'Dresden'
  | TargetId
  | TargetDistrict;

export type ResolvedEnvironmentTheme = 'salou' | 'dresden';

export function resolveEnvironmentTheme(theme: EnvironmentTheme): ResolvedEnvironmentTheme {
  const lower = String(theme).toLowerCase();
  if (lower.includes('dresden') || lower.includes('schatzkammer')) {
    return 'dresden';
  }
  return 'salou';
}

export interface EnvironmentLightingOptions {
  theme?: EnvironmentTheme;
  quality?: RenderQuality;
  palette?: Partial<TargetThemePalette>;
  /** Initial world focus (x, z) for the tight PCFSoft shadow frustum. */
  focusPos?: { x: number; z: number };
  /** Overrides default equirectangular WebP URLs if needed. */
  environmentUrls?: Partial<Record<ResolvedEnvironmentTheme, string>>;
  /** When true, marks renderer capabilities for reduced shadow resolution on software GPUs. */
  isSoftwareRenderer?: boolean;
}

export interface StreetlampLightOptions {
  color?: THREE.ColorRepresentation;
  intensity?: number;
  distance?: number;
  decay?: number;
  /** 'point' for fast ambient pools or 'spot' for directional streetlamp cones. */
  kind?: 'point' | 'spot';
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
}

export interface EnvironmentLightingController {
  readonly theme: ResolvedEnvironmentTheme;
  readonly quality: RenderQuality;
  readonly rigGroup: THREE.Group;
  readonly moonLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly rimLight: THREE.DirectionalLight;
  readonly fillLight: THREE.DirectionalLight;
  readonly hasLoadedHdriMap: boolean;

  setTheme(theme: EnvironmentTheme, palette?: Partial<TargetThemePalette>): void;
  setQuality(quality: RenderQuality, isSoftwareRenderer?: boolean): void;
  /** Centers the moonlight shadow frustum around the active player/vehicle with texel snapping. */
  setShadowFocus(x: number, z: number, radius?: number): void;
  /** Smoothly adjusts exposure and fill lights during interior/power-cut transitions. */
  setPowerCutFactor(factor: number): void;
  /** Manually override ACES Filmic exposure (defaults to theme-calibrated value). */
  setExposure(exposure: number): void;
  /** Loads or reloads an equirectangular night HDRI/WebP map for a theme. */
  loadEnvironmentMap(theme: EnvironmentTheme, url?: string): void;
  dispose(): void;
}

interface ThemeLightingProfile {
  exposure: number;
  envIntensity: number;
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyHorizon: number;
  horizonGlow: number;
  seaAccent: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  moonColor: number;
  moonIntensity: number;
  moonOffset: [number, number, number];
  rimColor: number;
  rimIntensity: number;
  rimPosition: [number, number, number];
  fillColor: number;
  fillIntensity: number;
  fillPosition: [number, number, number];
  defaultEnvUrl: string;
}

const THEME_PROFILES: Record<ResolvedEnvironmentTheme, ThemeLightingProfile> = {
  salou: {
    exposure: 1.14,
    envIntensity: 0.92,
    fogColor: 0x07101f,
    fogDensity: 0.0052,
    skyTop: 0x020714,
    skyHorizon: 0x10213a,
    horizonGlow: 0xff943d,
    seaAccent: 0x145369,
    hemiSky: 0x3b63a6,
    hemiGround: 0x1f1916,
    hemiIntensity: 0.42,
    moonColor: 0xa2c8ff,
    moonIntensity: 1.38,
    moonOffset: [-26, 44, 30],
    rimColor: 0xff9d47,
    rimIntensity: 0.56,
    rimPosition: [36, 15, -24],
    fillColor: 0x26658c,
    fillIntensity: 0.28,
    fillPosition: [-12, 12, 42],
    defaultEnvUrl: '/assets/textures/env_salou_night.webp',
  },
  dresden: {
    exposure: 1.1,
    envIntensity: 0.96,
    fogColor: 0x090c17,
    fogDensity: 0.0046,
    skyTop: 0x03050e,
    skyHorizon: 0x181c2e,
    horizonGlow: 0xffb357,
    seaAccent: 0x243b5e,
    hemiSky: 0x4b6294,
    hemiGround: 0x261e16,
    hemiIntensity: 0.38,
    moonColor: 0xb5ccf5,
    moonIntensity: 1.24,
    moonOffset: [-22, 48, 28],
    rimColor: 0xffbe6b,
    rimIntensity: 0.62,
    rimPosition: [32, 18, -30],
    fillColor: 0x344c7a,
    fillIntensity: 0.24,
    fillPosition: [-16, 14, 38],
    defaultEnvUrl: '/assets/textures/env_dresden_night.webp',
  },
};

const SHADOW_PRESETS: Record<
  RenderQuality,
  { mapSize: number; frustumRadius: number; shadowRadius: number }
> = {
  ultra: { mapSize: 2048, frustumRadius: 34, shadowRadius: 2.4 },
  high: { mapSize: 2048, frustumRadius: 38, shadowRadius: 2.0 },
  medium: { mapSize: 1024, frustumRadius: 40, shadowRadius: 1.5 },
};

/**
 * Configures a Three.js WebGLRenderer for physical ACES Filmic rendering & crisp PCFSoft shadows.
 */
export function configureWebGLRenderer(
  renderer: THREE.WebGLRenderer,
  quality: RenderQuality = 'high',
  isSoftwareRenderer = false
): void {
  const maxDpr = isSoftwareRenderer
    ? 1
    : quality === 'ultra'
      ? 2
      : quality === 'high'
        ? 1.5
        : 1.25;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  renderer.setPixelRatio(Math.min(dpr, maxDpr));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/**
 * Factory for physically-calibrated sodium-vapor (Salou) or historic warm-gold (Dresden)
 * streetlamp lights with realistic inverse-square falloff.
 */
export function createStreetlampLight(
  theme: EnvironmentTheme = 'salou',
  options: StreetlampLightOptions = {}
): THREE.PointLight | THREE.SpotLight {
  const resolved = resolveEnvironmentTheme(theme);
  const defaultColor = resolved === 'dresden' ? 0xffbe6b : 0xff9e4a;
  const color = options.color ?? defaultColor;
  const decay = options.decay ?? 2.0;

  if (options.kind === 'spot') {
    const spot = new THREE.SpotLight(
      color,
      options.intensity ?? 34,
      options.distance ?? 26,
      options.angle ?? Math.PI * 0.36,
      options.penumbra ?? 0.62,
      decay
    );
    spot.castShadow = Boolean(options.castShadow);
    if (spot.castShadow) {
      spot.shadow.mapSize.set(512, 512);
      spot.shadow.bias = -0.0004;
      spot.shadow.normalBias = 0.02;
    }
    return spot;
  }

  const point = new THREE.PointLight(
    color,
    options.intensity ?? 22,
    options.distance ?? 26,
    decay
  );
  point.castShadow = Boolean(options.castShadow);
  return point;
}

/**
 * Generates an immediate high-dynamic-range procedural night city environment probe
 * via PMREMGenerator so metallic clearcoat cars, wet asphalt puddles, brass safes, and
 * museum glass reflect realistic moonlight, sodium-vapor city glow, and urban bokeh
 * from frame 0 before async equirectangular maps finish loading.
 */
function buildProceduralNightPMREM(
  pmrem: THREE.PMREMGenerator,
  profile: ThemeLightingProfile
): THREE.WebGLRenderTarget {
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(40, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uSkyTop: { value: new THREE.Color(profile.skyTop) },
      uSkyHorizon: { value: new THREE.Color(profile.skyHorizon) },
      uHorizonGlow: { value: new THREE.Color(profile.horizonGlow) },
      uSeaAccent: { value: new THREE.Color(profile.seaAccent) },
      uMoonDir: {
        value: new THREE.Vector3(...profile.moonOffset).normalize(),
      },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSkyTop;
      uniform vec3 uSkyHorizon;
      uniform vec3 uHorizonGlow;
      uniform vec3 uSeaAccent;
      uniform vec3 uMoonDir;
      varying vec3 vDir;

      float hash21(vec2 p) {
        p = fract(p * vec2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, 0.0, 1.0);

        // Deep midnight sky dome gradient
        vec3 col = mix(uSkyHorizon * 1.15, uSkyTop, pow(up, 0.58));

        // Warm sodium-vapor urban horizon band (bright HDR so wet puddles gleam!)
        float band = exp(-abs(d.y - 0.03) * 8.5);
        float cityAzimuth = 0.55 + 0.45 * sin(atan(d.z, d.x) * 2.0 + 0.8);
        col += uHorizonGlow * band * (0.95 + 1.35 * cityAzimuth);

        // Soft coastal turquoise / riverside reflection below horizon
        float below = smoothstep(0.04, -0.35, d.y);
        col = mix(col, uSeaAccent * 0.45 + uSkyTop * 0.5, below);

        // High-dynamic-range moon disk + atmospheric halo
        float moonDot = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.55, 0.76, 1.0) * pow(moonDot, 18.0) * 0.9;
        col += vec3(0.88, 0.94, 1.0) * pow(moonDot, 220.0) * 6.5;

        // Crisp HDR urban skyline pinpoints (streetlamps / neon / baroque uplights)
        if (d.y > -0.02 && d.y < 0.24) {
          float az = atan(d.z, d.x);
          vec2 cell = floor(vec2(az * 24.0, d.y * 42.0));
          float r = hash21(cell);
          if (r > 0.86) {
            float spark = smoothstep(0.86, 0.995, r);
            vec3 lampTint = r > 0.95
              ? vec3(0.35, 0.85, 1.0)
              : (r > 0.91 ? vec3(1.0, 0.82, 0.52) : uHorizonGlow);
            col += lampTint * spark * 4.2 * (1.0 - abs(d.y - 0.06) * 4.0);
          }
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  envScene.add(skyDome);

  // Add subtle HDR overhead sodium & cool studio bounce cards for crisp clearcoat streaks
  const bounceCardGeo = new THREE.PlaneGeometry(18, 3.2);
  const warmCardMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(profile.horizonGlow).multiplyScalar(3.4),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const warmCard = new THREE.Mesh(bounceCardGeo, warmCardMat);
  warmCard.position.set(16, 6.5, -14);
  warmCard.lookAt(0, 0, 0);
  envScene.add(warmCard);

  const coolCardMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(profile.moonColor).multiplyScalar(2.4),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const coolCard = new THREE.Mesh(bounceCardGeo, coolCardMat);
  coolCard.position.set(-16, 12, 16);
  coolCard.lookAt(0, 0, 0);
  envScene.add(coolCard);

  const pmremTarget = pmrem.fromScene(envScene, 0.035);

  skyGeo.dispose();
  skyMat.dispose();
  bounceCardGeo.dispose();
  warmCardMat.dispose();
  coolCardMat.dispose();

  return pmremTarget;
}

/**
 * Projects an 8-bit equirectangular night WebP onto an interior sphere with physically
 * plausible HDR highlight expansion (lifting lamp cores & moon glow > 1.0 while keeping
 * dark skies faithful) so PMREM IBL yields photographic reflections on wet roads & clearcoat.
 */
function buildHdrBoostedEquirectPMREM(
  pmrem: THREE.PMREMGenerator,
  equirectTex: THREE.Texture,
  profile: ThemeLightingProfile
): THREE.WebGLRenderTarget {
  const envScene = new THREE.Scene();
  const sphereGeo = new THREE.SphereGeometry(32, 48, 24);
  const sphereMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uEnvMap: { value: equirectTex },
      uHighlightBoost: { value: 3.8 },
      uBaseGain: { value: 1.08 },
      uWarmAccent: { value: new THREE.Color(profile.horizonGlow) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uEnvMap;
      uniform float uHighlightBoost;
      uniform float uBaseGain;
      uniform vec3 uWarmAccent;
      varying vec2 vUv;

      void main() {
        // Flip U horizontally to match Three.js EquirectangularReflectionMapping interior view
        vec2 uv = vec2(1.0 - vUv.x, vUv.y);
        vec3 srgb = texture2D(uEnvMap, uv).rgb;
        // Convert sRGB to linear light
        vec3 lin = pow(max(srgb, vec3(0.0)), vec3(2.2)) * uBaseGain;
        float luma = dot(lin, vec3(0.2126, 0.7152, 0.0722));

        // Expand bright lights/lamps/moon in the night photo into genuine HDR values
        float highlightMask = smoothstep(0.32, 0.95, luma);
        vec3 hdr = lin + lin * (highlightMask * highlightMask * uHighlightBoost);

        // Preserve slight warm horizon specular lift for wet road reflections
        float horizonMask = exp(-abs(vUv.y - 0.5) * 14.0);
        hdr += uWarmAccent * horizonMask * 0.14;

        gl_FragColor = vec4(hdr, 1.0);
      }
    `,
  });

  const dome = new THREE.Mesh(sphereGeo, sphereMat);
  envScene.add(dome);

  const pmremTarget = pmrem.fromScene(envScene, 0.015);
  sphereGeo.dispose();
  sphereMat.dispose();
  return pmremTarget;
}

export function createEnvironmentLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  options: EnvironmentLightingOptions = {}
): EnvironmentLightingController {
  let currentTheme: ResolvedEnvironmentTheme = resolveEnvironmentTheme(options.theme ?? 'salou');
  let currentQuality: RenderQuality = options.quality ?? 'high';
  let isSoftware = Boolean(options.isSoftwareRenderer);
  let powerCutFactor = 0;
  let customExposure: number | null = null;
  let disposed = false;

  const focusXRef = { x: options.focusPos?.x ?? 0, z: options.focusPos?.z ?? 0 };
  let shadowFrustumRadius = SHADOW_PRESETS[currentQuality].frustumRadius;

  configureWebGLRenderer(renderer, currentQuality, isSoftware);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const textureLoader = new THREE.TextureLoader();
  const envCache = new Map<ResolvedEnvironmentTheme, THREE.WebGLRenderTarget>();
  const hdriLoadedThemes = new Set<ResolvedEnvironmentTheme>();
  const pendingLoads = new Set<ResolvedEnvironmentTheme>();

  let manifestEnvUrls: Partial<Record<ResolvedEnvironmentTheme, string>> = {
    ...(options.environmentUrls ?? {}),
  };
  let manifestFetched = false;
  let manifestHasEnvironments = false;

  // Lighting rig group
  const rigGroup = new THREE.Group();
  rigGroup.name = 'Nachtschicht_EnvironmentRig';

  const initialProfile = THEME_PROFILES[currentTheme];

  const hemiLight = new THREE.HemisphereLight(
    initialProfile.hemiSky,
    initialProfile.hemiGround,
    initialProfile.hemiIntensity
  );
  hemiLight.name = 'Env_SkylightHemi';
  rigGroup.add(hemiLight);

  const moonLight = new THREE.DirectionalLight(
    initialProfile.moonColor,
    initialProfile.moonIntensity
  );
  moonLight.name = 'Env_MoonKeyLight';
  moonLight.castShadow = true;
  moonLight.shadow.camera.near = 2;
  moonLight.shadow.camera.far = 145;
  moonLight.shadow.bias = -0.00035;
  moonLight.shadow.normalBias = 0.025;
  rigGroup.add(moonLight);
  rigGroup.add(moonLight.target);

  const rimLight = new THREE.DirectionalLight(
    initialProfile.rimColor,
    initialProfile.rimIntensity
  );
  rimLight.name = 'Env_SodiumHorizonRim';
  rimLight.castShadow = false;
  rigGroup.add(rimLight);

  const fillLight = new THREE.DirectionalLight(
    initialProfile.fillColor,
    initialProfile.fillIntensity
  );
  fillLight.name = 'Env_CoastalFill';
  fillLight.castShadow = false;
  rigGroup.add(fillLight);

  scene.add(rigGroup);

  const applyShadowConfig = () => {
    const preset = SHADOW_PRESETS[currentQuality];
    const mapSize = isSoftware ? Math.min(1024, preset.mapSize) : preset.mapSize;
    shadowFrustumRadius = preset.frustumRadius;

    if (
      moonLight.shadow.mapSize.width !== mapSize ||
      moonLight.shadow.mapSize.height !== mapSize
    ) {
      moonLight.shadow.mapSize.set(mapSize, mapSize);
      if (moonLight.shadow.map) {
        moonLight.shadow.map.dispose();
        moonLight.shadow.map = null;
      }
    }

    moonLight.shadow.radius = isSoftware ? 1.0 : preset.shadowRadius;
    const cam = moonLight.shadow.camera;
    cam.left = -shadowFrustumRadius;
    cam.right = shadowFrustumRadius;
    cam.top = shadowFrustumRadius;
    cam.bottom = -shadowFrustumRadius;
    cam.updateProjectionMatrix();
  };

  const updateMoonFocus = (x: number, z: number, radius?: number) => {
    focusXRef.x = x;
    focusXRef.z = z;

    if (radius !== undefined && Math.abs(radius - shadowFrustumRadius) > 0.25) {
      shadowFrustumRadius = Math.max(16, Math.min(80, radius));
      const cam = moonLight.shadow.camera;
      cam.left = -shadowFrustumRadius;
      cam.right = shadowFrustumRadius;
      cam.top = shadowFrustumRadius;
      cam.bottom = -shadowFrustumRadius;
      cam.updateProjectionMatrix();
    }

    // Texel-snap the shadow target in world XZ to eliminate shimmering/crawling during motion
    const mapSize = Math.max(512, moonLight.shadow.mapSize.width || 1024);
    const texelWorldSize = (shadowFrustumRadius * 2) / mapSize;
    const snappedX = Math.round(x / texelWorldSize) * texelWorldSize;
    const snappedZ = Math.round(z / texelWorldSize) * texelWorldSize;

    const [ox, oy, oz] = THEME_PROFILES[currentTheme].moonOffset;
    moonLight.target.position.set(snappedX, 0, snappedZ);
    moonLight.position.set(snappedX + ox, oy, snappedZ + oz);
    moonLight.target.updateMatrixWorld();
  };

  const applyLightIntensities = () => {
    const profile = THEME_PROFILES[currentTheme];
    const cut = Math.max(0, Math.min(1, powerCutFactor));

    hemiLight.intensity = profile.hemiIntensity * (1 - cut * 0.26);
    moonLight.intensity = profile.moonIntensity * (1 - cut * 0.06);
    rimLight.intensity = profile.rimIntensity * (1 - cut * 0.22);
    fillLight.intensity = profile.fillIntensity * (1 - cut * 0.15);

    const baseExp = customExposure ?? profile.exposure;
    renderer.toneMappingExposure = baseExp * (1 - cut * 0.08);
    scene.environmentIntensity = profile.envIntensity * (1 - cut * 0.2);
  };

  const ensureManifestEnvUrls = async (): Promise<void> => {
    if (manifestFetched || typeof fetch === 'undefined') return;
    manifestFetched = true;
    try {
      const resp = await fetch('/assets/images/manifest.json');
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        environments?: Record<string, string>;
        textures?: Record<string, string>;
      };
      const envs = data?.environments ?? {};
      const texs = data?.textures ?? {};
      const salouUrl = envs.salou ?? envs.env_salou_night ?? texs.env_salou_night;
      const dresdenUrl = envs.dresden ?? envs.env_dresden_night ?? texs.env_dresden_night;
      if (salouUrl || dresdenUrl) {
        manifestHasEnvironments = true;
      }
      if (!manifestEnvUrls.salou && salouUrl) {
        manifestEnvUrls.salou = salouUrl;
      }
      if (!manifestEnvUrls.dresden && dresdenUrl) {
        manifestEnvUrls.dresden = dresdenUrl;
      }
    } catch {
      // Fall back quietly to procedural high-dynamic night PMREM
    }
  };

  const loadThemeHdriAsync = (
    theme: ResolvedEnvironmentTheme,
    explicitUrl?: string
  ) => {
    if (disposed || pendingLoads.has(theme)) return;
    if (!explicitUrl && hdriLoadedThemes.has(theme)) return;
    pendingLoads.add(theme);

    void (async () => {
      if (!explicitUrl) {
        await ensureManifestEnvUrls();
      }
      if (disposed) {
        pendingLoads.delete(theme);
        return;
      }

      const profile = THEME_PROFILES[theme];
      const url =
        explicitUrl ??
        manifestEnvUrls[theme] ??
        (manifestHasEnvironments ? profile.defaultEnvUrl : undefined);

      // Avoid spurious 404 console errors when manifest hasn't published equirect WebPs yet
      if (!url) {
        pendingLoads.delete(theme);
        return;
      }

      textureLoader.load(
        url,
        (tex) => {
          pendingLoads.delete(theme);
          if (disposed) {
            tex.dispose();
            return;
          }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.needsUpdate = true;

          let pmremRT: THREE.WebGLRenderTarget;
          try {
            pmremRT = buildHdrBoostedEquirectPMREM(pmremGenerator, tex, profile);
          } catch {
            pmremRT = pmremGenerator.fromEquirectangular(tex);
          }
          tex.dispose();

          const previous = envCache.get(theme);
          envCache.set(theme, pmremRT);
          hdriLoadedThemes.add(theme);

          if (currentTheme === theme) {
            scene.environment = pmremRT.texture;
            scene.environmentIntensity = profile.envIntensity * (1 - powerCutFactor * 0.2);
          }
          if (previous && previous !== pmremRT) {
            previous.dispose();
          }
        },
        undefined,
        () => {
          pendingLoads.delete(theme);
          // Procedural high-dynamic night PMREM stays seamlessly active
        }
      );
    })();
  };

  const applyTheme = (themeInput: EnvironmentTheme, palette?: Partial<TargetThemePalette>) => {
    currentTheme = resolveEnvironmentTheme(themeInput);
    const profile = THEME_PROFILES[currentTheme];

    // Ensure immediate PMREM IBL exists synchronously (procedural fallback until HDRI WebP loads)
    let envRT = envCache.get(currentTheme);
    if (!envRT) {
      envRT = buildProceduralNightPMREM(pmremGenerator, profile);
      envCache.set(currentTheme, envRT);
    }
    scene.environment = envRT.texture;

    // Trigger async upgrade to @artist's equirectangular environment map
    loadThemeHdriAsync(currentTheme);

    // Update lighting palette
    hemiLight.color.setHex(profile.hemiSky);
    hemiLight.groundColor.setHex(profile.hemiGround);
    moonLight.color.setHex(profile.moonColor);

    if (palette?.streetlampHex) {
      rimLight.color.set(palette.streetlampHex);
    } else {
      rimLight.color.setHex(profile.rimColor);
    }
    rimLight.position.set(...profile.rimPosition);

    fillLight.color.setHex(profile.fillColor);
    fillLight.position.set(...profile.fillPosition);

    // Calibrated atmospheric night fog & background
    const fogColor = palette?.fogColor
      ? new THREE.Color(palette.fogColor)
      : new THREE.Color(profile.fogColor);
    scene.background = fogColor;
    scene.fog = new THREE.FogExp2(fogColor.getHex(), profile.fogDensity);

    applyLightIntensities();
    updateMoonFocus(focusXRef.x, focusXRef.z);
  };

  applyShadowConfig();
  applyTheme(currentTheme, options.palette);

  return {
    get theme() {
      return currentTheme;
    },
    get quality() {
      return currentQuality;
    },
    rigGroup,
    moonLight,
    hemiLight,
    rimLight,
    fillLight,
    get hasLoadedHdriMap() {
      return hdriLoadedThemes.has(currentTheme);
    },

    setTheme(theme: EnvironmentTheme, palette?: Partial<TargetThemePalette>) {
      if (disposed) return;
      applyTheme(theme, palette);
    },

    setQuality(quality: RenderQuality, isSoftwareRenderer?: boolean) {
      if (disposed) return;
      currentQuality = quality;
      if (isSoftwareRenderer !== undefined) {
        isSoftware = isSoftwareRenderer;
      }
      configureWebGLRenderer(renderer, currentQuality, isSoftware);
      applyShadowConfig();
      applyLightIntensities();
      updateMoonFocus(focusXRef.x, focusXRef.z);
    },

    setShadowFocus(x: number, z: number, radius?: number) {
      if (disposed) return;
      updateMoonFocus(x, z, radius);
    },

    setPowerCutFactor(factor: number) {
      if (disposed) return;
      powerCutFactor = Math.max(0, Math.min(1, factor));
      applyLightIntensities();
    },

    setExposure(exposure: number) {
      if (disposed) return;
      customExposure = Math.max(0.25, Math.min(3.0, exposure));
      applyLightIntensities();
    },

    loadEnvironmentMap(theme: EnvironmentTheme, url?: string) {
      if (disposed) return;
      const resolved = resolveEnvironmentTheme(theme);
      if (url) {
        manifestEnvUrls[resolved] = url;
      }
      hdriLoadedThemes.delete(resolved);
      loadThemeHdriAsync(resolved, url);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(rigGroup);
      if (scene.environment) {
        for (const rt of envCache.values()) {
          if (scene.environment === rt.texture) {
            scene.environment = null;
          }
        }
      }
      for (const rt of envCache.values()) {
        rt.dispose();
      }
      envCache.clear();
      if (moonLight.shadow.map) {
        moonLight.shadow.map.dispose();
        moonLight.shadow.map = null;
      }
      pmremGenerator.dispose();
    },
  };
}
