import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// ============================================================================
// NACHTSCHICHT — Round 2 Photorealistic 3D Asset & Multi-Map PBR Registry
// Loads all 18 .glb models (with SkeletonUtils skeletal cloning + cached glTF
// AnimationClips) and full PBR texture sets (albedo + normal + roughness + ao)
// + HDRI night environment maps, with clean procedural fallbacks.
// ============================================================================

export type ModelKey =
  | 'getaway_car'
  | 'police_car'
  | 'traffic_car'
  | 'character_mara'
  | 'character_jupp'
  | 'character_crew'
  | 'character_guard'
  | 'character_civilian'
  | 'safe'
  | 'display_case'
  | 'power_box'
  | 'security_camera'
  | 'palm_tree'
  | 'streetlamp'
  | 'salou_facade'
  | 'dresden_pillar'
  | 'door_detailed'
  | 'cafe_terrace';

export type TextureKey = 'salou_stucco' | 'wet_asphalt' | 'stone_plaza' | 'blueprint_paper';

export type PbrMaterialKey =
  | 'wet_asphalt'
  | 'salou_stucco'
  | 'stone_plaza'
  | 'dresden_sandstone'
  | 'interior_marble'
  | 'brushed_steel'
  | 'brick_alley';

export interface PbrTextureMaps {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
}

interface ManifestPbrEntry {
  albedo?: string;
  map?: string;
  normal?: string;
  normalMap?: string;
  roughness?: string;
  roughnessMap?: string;
  ao?: string;
  aoMap?: string;
}

interface ModelsManifest {
  models: Record<
    string,
    {
      url: string;
      dimensions?: { width: number; height: number; depth: number };
      subMeshes?: string[];
      animations?: string[];
    }
  >;
}

interface ImagesManifest {
  textures?: Record<string, string>;
  pbrSets?: Record<string, ManifestPbrEntry>;
  environments?: Record<string, string>;
}

const DEFAULT_MODEL_URLS: Record<ModelKey, string> = {
  getaway_car: '/assets/models/getaway_car.glb',
  police_car: '/assets/models/police_car.glb',
  traffic_car: '/assets/models/traffic_car.glb',
  character_mara: '/assets/models/character_mara.glb',
  character_jupp: '/assets/models/character_jupp.glb',
  character_crew: '/assets/models/character_crew.glb',
  character_guard: '/assets/models/character_guard.glb',
  character_civilian: '/assets/models/character_civilian.glb',
  safe: '/assets/models/safe.glb',
  display_case: '/assets/models/display_case.glb',
  power_box: '/assets/models/power_box.glb',
  security_camera: '/assets/models/security_camera.glb',
  palm_tree: '/assets/models/palm_tree.glb',
  streetlamp: '/assets/models/streetlamp.glb',
  salou_facade: '/assets/models/salou_facade.glb',
  dresden_pillar: '/assets/models/dresden_pillar.glb',
  door_detailed: '/assets/models/door_detailed.glb',
  cafe_terrace: '/assets/models/cafe_terrace.glb',
};

const ASSET_CACHE_VERSION = '2';

function withAssetVersion(url: string): string {
  return url.includes('?') ? url : `${url}?v=${ASSET_CACHE_VERSION}`;
}

const DEFAULT_TEXTURE_URLS: Record<TextureKey, string> = {
  salou_stucco: `/assets/textures/salou_stucco.webp?v=${ASSET_CACHE_VERSION}`,
  wet_asphalt: `/assets/textures/wet_asphalt.webp?v=${ASSET_CACHE_VERSION}`,
  stone_plaza: `/assets/textures/stone_plaza.webp?v=${ASSET_CACHE_VERSION}`,
  blueprint_paper: `/assets/textures/blueprint_paper.webp?v=${ASSET_CACHE_VERSION}`,
};

const DEFAULT_ENV_URLS: Record<'salou' | 'dresden', string> = {
  salou: '/assets/textures/env_salou_night.webp',
  dresden: '/assets/textures/env_dresden_night.webp',
};

class WorldAssetRegistry {
  private gltfLoader = new GLTFLoader();
  private textureLoader = new THREE.TextureLoader();

  private modelTemplates = new Map<ModelKey, THREE.Group>();
  private modelHasSkinnedMesh = new Map<ModelKey, boolean>();
  private modelAnimations = new Map<ModelKey, THREE.AnimationClip[]>();

  private textureCache = new Map<TextureKey, THREE.Texture>();
  private pbrCache = new Map<
    PbrMaterialKey,
    {
      map?: THREE.Texture;
      normalMap?: THREE.Texture;
      roughnessMap?: THREE.Texture;
      aoMap?: THREE.Texture;
    }
  >();
  private environmentUrls: Record<'salou' | 'dresden', string> = { ...DEFAULT_ENV_URLS };

  private loadPromise: Promise<void> | null = null;
  private readyListeners = new Set<() => void>();
  private loaded = false;

  public get loadedModelKeys(): string[] {
    return Array.from(this.modelTemplates.keys());
  }

  public get loadedTextureKeys(): string[] {
    return Array.from(this.textureCache.keys());
  }

  public get loadedPbrSetKeys(): string[] {
    return Array.from(this.pbrCache.keys());
  }

  public isReady(): boolean {
    return this.loaded;
  }

  public onReady(cb: () => void): () => void {
    if (this.loaded) {
      cb();
      return () => {};
    }
    this.readyListeners.add(cb);
    return () => {
      this.readyListeners.delete(cb);
    };
  }

  public getEnvironmentUrl(city: 'Salou' | 'Dresden'): string {
    return city === 'Dresden' ? this.environmentUrls.dresden : this.environmentUrls.salou;
  }

  private loadTex(url: string, isColor: boolean): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      this.textureLoader.load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.anisotropy = 8;
          tex.userData.sharedAsset = true;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
  }

  public preloadAll(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      let modelUrls: Record<string, string> = {};
      let textureUrls: Record<string, string> = { ...DEFAULT_TEXTURE_URLS };
      let manifestPbrSets: Record<string, ManifestPbrEntry> = {};

      // Fetch both manifests gracefully (only load models listed in manifest to avoid 404s
      // if an optional V2 GLB hasn't landed yet, falling back cleanly!)
      await Promise.all([
        fetch('/assets/models/manifest.json')
          .then((r) => (r.ok ? (r.json() as Promise<ModelsManifest>) : null))
          .then((m) => {
            if (m?.models) {
              for (const [k, info] of Object.entries(m.models)) {
                if (info?.url) modelUrls[k] = info.url;
              }
            }
          })
          .catch(() => {}),
        fetch('/assets/images/manifest.json')
          .then((r) => (r.ok ? (r.json() as Promise<ImagesManifest>) : null))
          .then((m) => {
            if (m?.textures) {
              textureUrls = { ...textureUrls, ...m.textures };
            }
            if (m?.pbrSets) {
              manifestPbrSets = m.pbrSets;
            }
            if (m?.environments) {
              if (m.environments.env_salou_night) {
                this.environmentUrls.salou = m.environments.env_salou_night;
              } else if (m.environments.salou) {
                this.environmentUrls.salou = m.environments.salou;
              }
              if (m.environments.env_dresden_night) {
                this.environmentUrls.dresden = m.environments.env_dresden_night;
              } else if (m.environments.dresden) {
                this.environmentUrls.dresden = m.environments.dresden;
              }
            }
          })
          .catch(() => {}),
      ]);

      // Fallback to V1 core model URLs if manifest failed to fetch
      if (Object.keys(modelUrls).length === 0) {
        modelUrls = {
          getaway_car: DEFAULT_MODEL_URLS.getaway_car,
          police_car: DEFAULT_MODEL_URLS.police_car,
          character_mara: DEFAULT_MODEL_URLS.character_mara,
          character_crew: DEFAULT_MODEL_URLS.character_crew,
          character_guard: DEFAULT_MODEL_URLS.character_guard,
          safe: DEFAULT_MODEL_URLS.safe,
          display_case: DEFAULT_MODEL_URLS.display_case,
          power_box: DEFAULT_MODEL_URLS.power_box,
          security_camera: DEFAULT_MODEL_URLS.security_camera,
          palm_tree: DEFAULT_MODEL_URLS.palm_tree,
          streetlamp: DEFAULT_MODEL_URLS.streetlamp,
          salou_facade: DEFAULT_MODEL_URLS.salou_facade,
          dresden_pillar: DEFAULT_MODEL_URLS.dresden_pillar,
        };
      }

      // 1) Load base tileable textures (with cache-bust query param for Cloudflare edge)
      const texTasks = (Object.keys(DEFAULT_TEXTURE_URLS) as TextureKey[]).map(
        async (key) => {
          const url = withAssetVersion(textureUrls[key] ?? DEFAULT_TEXTURE_URLS[key]);
          const tex = await this.loadTex(url, true);
          if (tex) this.textureCache.set(key, tex);
        }
      );

      // 2) Load full multi-map PBR sets when present in manifest
      const pbrTasks = Object.entries(manifestPbrSets).map(async ([rawKey, entry]) => {
        const key = rawKey as PbrMaterialKey;
        const albedoUrl = entry.albedo ?? entry.map;
        const normalUrl = entry.normal ?? entry.normalMap;
        const roughUrl = entry.roughness ?? entry.roughnessMap;
        const aoUrl = entry.ao ?? entry.aoMap;

        const [map, normalMap, roughnessMap, aoMap] = await Promise.all([
          albedoUrl ? this.loadTex(albedoUrl, true) : Promise.resolve(null),
          normalUrl ? this.loadTex(normalUrl, false) : Promise.resolve(null),
          roughUrl ? this.loadTex(roughUrl, false) : Promise.resolve(null),
          aoUrl ? this.loadTex(aoUrl, false) : Promise.resolve(null),
        ]);

        if (map || normalMap || roughnessMap || aoMap) {
          this.pbrCache.set(key, {
            map: map ?? undefined,
            normalMap: normalMap ?? undefined,
            roughnessMap: roughnessMap ?? undefined,
            aoMap: aoMap ?? undefined,
          });
        }
      });

      // 3) Load all manifest-listed GLB models + their skeletal animation clips
      const modelTasks = Object.entries(modelUrls).map(
        ([rawKey, url]) =>
          new Promise<void>((resolve) => {
            const key = rawKey as ModelKey;
            this.gltfLoader.load(
              withAssetVersion(url),
              (gltf) => {
                const root = gltf.scene;
                let hasSkinned = false;
                root.traverse((obj) => {
                  if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
                    hasSkinned = true;
                  }
                  if ((obj as THREE.Mesh).isMesh) {
                    const mesh = obj as THREE.Mesh;
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    if (mesh.geometry) {
                      mesh.geometry.userData.sharedAsset = true;
                    }
                    if (Array.isArray(mesh.material)) {
                      mesh.material.forEach((m) => {
                        m.userData.sharedAsset = true;
                      });
                    } else if (mesh.material) {
                      mesh.material.userData.sharedAsset = true;
                    }
                  }
                });
                this.modelTemplates.set(key, root);
                this.modelHasSkinnedMesh.set(key, hasSkinned);
                this.modelAnimations.set(key, gltf.animations ?? []);
                resolve();
              },
              undefined,
              () => resolve()
            );
          })
      );

      await Promise.all([...texTasks, ...pbrTasks, ...modelTasks]);
      this.loaded = true;
      for (const cb of this.readyListeners) {
        try {
          cb();
        } catch {
          // ignore listener error
        }
      }
      this.readyListeners.clear();
    })();

    return this.loadPromise;
  }

  private cloneTiledTex(base: THREE.Texture, repeatX: number, repeatY: number): THREE.Texture {
    const cloned = base.clone();
    cloned.wrapS = THREE.RepeatWrapping;
    cloned.wrapT = THREE.RepeatWrapping;
    cloned.repeat.set(repeatX, repeatY);
    cloned.userData.sharedAsset = false;
    cloned.needsUpdate = true;
    return cloned;
  }

  public getTexture(key: TextureKey, repeatX = 1, repeatY = 1): THREE.Texture {
    const pbr = this.pbrCache.get(key as PbrMaterialKey);
    if (pbr?.map) {
      return this.cloneTiledTex(pbr.map, repeatX, repeatY);
    }
    const cached = this.textureCache.get(key);
    if (cached) {
      return this.cloneTiledTex(cached, repeatX, repeatY);
    }
    return createProceduralTexture(key, repeatX, repeatY);
  }

  /**
   * Returns a complete PBR texture set (albedo + optional normal/roughness/ao)
   * with calibrated tiling repeats. Falls back gracefully to base textures.
   */
  public getPbrMaps(key: PbrMaterialKey, repeatX = 1, repeatY = 1): PbrTextureMaps {
    const set = this.pbrCache.get(key);
    if (set?.map) {
      const result: PbrTextureMaps = {
        map: this.cloneTiledTex(set.map, repeatX, repeatY),
      };
      if (set.normalMap) result.normalMap = this.cloneTiledTex(set.normalMap, repeatX, repeatY);
      if (set.roughnessMap) {
        result.roughnessMap = this.cloneTiledTex(set.roughnessMap, repeatX, repeatY);
      }
      if (set.aoMap) {
        const ao = this.cloneTiledTex(set.aoMap, repeatX, repeatY);
        ao.channel = 0;
        result.aoMap = ao;
      }
      return result;
    }

    // Fallback mapping to V1 tileable textures
    const fallbackTexKey: TextureKey =
      key === 'wet_asphalt'
        ? 'wet_asphalt'
        : key === 'salou_stucco' || key === 'dresden_sandstone' || key === 'brick_alley'
          ? 'salou_stucco'
          : 'stone_plaza';
    return { map: this.getTexture(fallbackTexKey, repeatX, repeatY) };
  }

  public getModelAnimations(key: ModelKey): THREE.AnimationClip[] {
    return this.modelAnimations.get(key) ?? [];
  }

  public getAnimationClips(key: ModelKey): THREE.AnimationClip[] {
    return this.getModelAnimations(key);
  }

  public hasSkeletalAnimations(key: ModelKey): boolean {
    const clips = this.modelAnimations.get(key);
    return Array.isArray(clips) && clips.length > 0;
  }

  /**
   * Returns a fresh clone of the loaded `.glb` model (using SkeletonUtils.clone
   * for Armature/SkinnedMesh rigs so every instance animates independently!),
   * or a stylized procedural fallback with matching sub-mesh hierarchy.
   */
  public instantiateModel(key: ModelKey, cloneMaterials = false): THREE.Group {
    const template = this.modelTemplates.get(key);
    if (template) {
      const useSkeleton = this.modelHasSkinnedMesh.get(key) === true;
      const cloned = useSkeleton ? SkeletonUtils.clone(template) : template.clone(true);
      const instance =
        cloned instanceof THREE.Group ? cloned : new THREE.Group().add(cloned);

      if (cloneMaterials) {
        instance.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const mesh = obj as THREE.Mesh;
            if (Array.isArray(mesh.material)) {
              mesh.material = mesh.material.map((m) => {
                const cm = m.clone();
                cm.userData.sharedAsset = false;
                return cm;
              });
            } else if (mesh.material) {
              const cm = mesh.material.clone();
              cm.userData.sharedAsset = false;
              mesh.material = cm;
            }
          }
        });
      }
      instance.userData.isFallback = false;
      instance.userData.modelKey = key;
      instance.userData.isSkinned = useSkeleton;
      instance.userData.animations = this.getModelAnimations(key);
      return instance;
    }

    // Smart cross-fallback: if character_jupp isn't loaded yet, check character_crew
    if (key === 'character_jupp' && this.modelTemplates.has('character_crew')) {
      return this.instantiateModel('character_crew', true);
    }

    const fallback = buildProceduralFallback(key);
    fallback.userData.isFallback = true;
    fallback.userData.modelKey = key;
    fallback.userData.isSkinned = false;
    return fallback;
  }
}

export const assetRegistry = new WorldAssetRegistry();

/**
 * Safely disposes Three.js resources inside a subtree while preserving
 * shared GLB geometries/materials cached inside `assetRegistry`.
 */
export function disposeSceneSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      if (m.geometry && !m.geometry.userData?.sharedAsset) {
        m.geometry.dispose();
      }
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && !mat.userData?.sharedAsset) {
          mat.dispose();
        }
      }
    } else if ((obj as THREE.Sprite).isSprite) {
      const sp = obj as THREE.Sprite;
      if (sp.material.map && !sp.material.map.userData?.sharedAsset) {
        sp.material.map.dispose();
      }
      if (!sp.material.userData?.sharedAsset) {
        sp.material.dispose();
      }
    }
  });
}

// ----------------------------------------------------------------------------
// Procedural Texture Fallback (Crisp stylized canvas patterns)
// ----------------------------------------------------------------------------

function createProceduralTexture(
  key: TextureKey,
  repeatX: number,
  repeatY: number
): THREE.Texture {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([30, 38, 52, 255]);
    const tex = new THREE.DataTexture(data, 1, 1);
    tex.needsUpdate = true;
    return tex;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (key === 'wet_asphalt') {
      ctx.fillStyle = '#18202c';
      ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 650; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(120,160,210,0.08)' : 'rgba(10,14,22,0.22)';
        ctx.fillRect(x, y, 3, 3);
      }
    } else if (key === 'stone_plaza') {
      ctx.fillStyle = '#2a3342';
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = 'rgba(10,15,24,0.45)';
      ctx.lineWidth = 2;
      for (let y = 0; y < 256; y += 32) {
        for (let x = 0; x < 256; x += 64) {
          const offset = (y / 32) % 2 === 0 ? 0 : 32;
          ctx.fillStyle = (x + y) % 64 === 0 ? '#313c4f' : '#293344';
          ctx.fillRect((x + offset) % 256, y, 62, 30);
          ctx.strokeRect((x + offset) % 256, y, 64, 32);
        }
      }
    } else {
      ctx.fillStyle = '#6f5c4c';
      ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = 'rgba(255,220,180,0.05)';
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 8, 8);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ----------------------------------------------------------------------------
// Stylized Procedural 3D Fallbacks (Exact Sub-Mesh Names Matching Manifest)
// ----------------------------------------------------------------------------

function buildProceduralFallback(key: ModelKey): THREE.Group {
  const group = new THREE.Group();
  const mat = (
    color: number,
    roughness = 0.55,
    metalness = 0.2,
    emissive = 0x000000,
    emissiveIntensity = 0
  ) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      emissive,
      emissiveIntensity,
    });

  if (key === 'getaway_car' || key === 'police_car' || key === 'traffic_car') {
    const isPolice = key === 'police_car';
    const isTraffic = key === 'traffic_car';
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(isTraffic ? 1.88 : 2.0, 0.72, isTraffic ? 4.2 : 4.4),
      mat(isPolice ? 0x16294b : isTraffic ? 0x64748b : 0x1e293b, 0.28, 0.6)
    );
    body.name = 'Body';
    body.position.set(0, 0.62, 0);
    body.castShadow = true;
    group.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.68, 0.52, 2.0),
      mat(isPolice ? 0xe2e8f0 : 0x0f172a, 0.2, 0.4)
    );
    cabin.name = 'Glass';
    cabin.position.set(0, 1.15, -0.1);
    cabin.castShadow = true;
    group.add(cabin);

    const hl = new THREE.Mesh(
      new THREE.BoxGeometry(1.56, 0.16, 0.12),
      mat(0xfff3c4, 0.2, 0.1, 0xffd580, 2.2)
    );
    hl.name = 'Headlights';
    hl.position.set(0, 0.64, isTraffic ? 2.12 : 2.22);
    group.add(hl);

    const tl = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.14, 0.1),
      mat(0xff2e2e, 0.2, 0.1, 0xef4444, 1.8)
    );
    tl.name = 'Taillights';
    tl.position.set(0, 0.66, isTraffic ? -2.11 : -2.21);
    group.add(tl);

    if (isPolice) {
      const lbBlue = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.16, 0.26),
        mat(0x2563eb, 0.2, 0.1, 0x3b82f6, 3.0)
      );
      lbBlue.name = 'Lightbar_Blue';
      lbBlue.position.set(0.32, 1.49, 0.0);
      group.add(lbBlue);

      const lbRed = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.16, 0.26),
        mat(0xdc2626, 0.2, 0.1, 0xef4444, 3.0)
      );
      lbRed.name = 'Lightbar_Red';
      lbRed.position.set(-0.32, 1.49, 0.0);
      group.add(lbRed);
    }

    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.28, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = mat(0x111827, 0.85, 0.15);
    const wheelDefs: Array<[string, number, number]> = [
      ['Wheel_FL', 0.84, 1.32],
      ['Wheel_FR', -0.84, 1.32],
      ['Wheel_RL', 0.84, -1.28],
      ['Wheel_RR', -0.84, -1.28],
    ];
    for (const [name, wx, wz] of wheelDefs) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.name = name;
      w.position.set(wx, 0.34, wz);
      w.castShadow = true;
      group.add(w);
    }
    return group;
  }

  if (
    key === 'character_mara' ||
    key === 'character_jupp' ||
    key === 'character_crew' ||
    key === 'character_guard' ||
    key === 'character_civilian'
  ) {
    const jacketColor =
      key === 'character_mara'
        ? 0x1e3a5f
        : key === 'character_jupp'
          ? 0x3f3a36
          : key === 'character_guard'
            ? 0x172554
            : key === 'character_civilian'
              ? 0x4b5563
              : 0x334155;
    const accentColor =
      key === 'character_mara'
        ? 0x38bdf8
        : key === 'character_jupp'
          ? 0xd97706
          : key === 'character_guard'
            ? 0xfef08a
            : key === 'character_civilian'
              ? 0xd6cfc2
              : 0xf59e0b;

    const pelvis = new THREE.Group();
    pelvis.name = 'Pelvis';
    pelvis.position.set(0, 0.9, 0);
    group.add(pelvis);

    const legGeo = new THREE.CapsuleGeometry(0.085, 0.62, 4, 8);
    const legMat = mat(0x111827, 0.8, 0.1);
    const legL = new THREE.Mesh(legGeo, legMat);
    legL.name = 'Leg_L';
    legL.position.set(0.11, -0.45, 0);
    legL.castShadow = true;
    pelvis.add(legL);

    const legR = new THREE.Mesh(legGeo, legMat);
    legR.name = 'Leg_R';
    legR.position.set(-0.11, -0.45, 0);
    legR.castShadow = true;
    pelvis.add(legR);

    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.56, 0.24),
      mat(jacketColor, 0.6, 0.15)
    );
    torso.name = 'Torso';
    torso.position.set(0, 0.28, 0);
    torso.castShadow = true;
    pelvis.add(torso);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 12, 10),
      mat(0xe2c3a4, 0.6, 0.05)
    );
    head.name = 'Head';
    head.position.set(0, 0.44, 0);
    head.castShadow = true;
    torso.add(head);

    const armGeo = new THREE.CapsuleGeometry(0.065, 0.46, 4, 8);
    const armMat = mat(jacketColor, 0.6, 0.15);
    const armL = new THREE.Mesh(armGeo, armMat);
    armL.name = 'Arm_L';
    armL.position.set(0.26, 0.02, 0);
    torso.add(armL);

    const armR = new THREE.Mesh(armGeo, armMat);
    armR.name = 'Arm_R';
    armR.position.set(-0.26, 0.02, 0);
    torso.add(armR);

    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.08, 0.04),
      mat(accentColor, 0.3, 0.2, accentColor, 0.55)
    );
    badge.position.set(0, 0.1, 0.13);
    torso.add(badge);

    return group;
  }

  if (key === 'door_detailed') {
    const frameMat = mat(0x362b23, 0.65, 0.25);
    const postL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.5, 0.24), frameMat);
    postL.position.set(-0.82, 1.25, 0);
    group.add(postL);

    const postR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.5, 0.24), frameMat);
    postR.position.set(0.82, 1.25, 0);
    group.add(postR);

    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.26), frameMat);
    lintel.position.set(0, 2.5, 0);
    group.add(lintel);

    const doorPivot = new THREE.Group();
    doorPivot.name = 'Door_Leaf';
    doorPivot.position.set(-0.74, 0, 0);
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(1.48, 2.4, 0.09),
      mat(0x2b3648, 0.45, 0.4)
    );
    leaf.position.set(0.74, 1.2, 0);
    doorPivot.add(leaf);

    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.05, 0.18),
      mat(0xd4a347, 0.25, 0.85)
    );
    handle.position.set(1.25, 1.05, 0);
    doorPivot.add(handle);
    group.add(doorPivot);
    return group;
  }

  if (key === 'cafe_terrace') {
    const ironMat = mat(0x1e293b, 0.55, 0.72);
    const topMat = mat(0xd6cfc2, 0.45, 0.15);
    const tablePost = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.74, 8), ironMat);
    tablePost.position.set(0, 0.37, 0);
    group.add(tablePost);

    const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.05, 14), topMat);
    tableTop.position.set(0, 0.75, 0);
    tableTop.castShadow = true;
    group.add(tableTop);

    for (const sx of [-0.68, 0.68]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), ironMat);
      seat.position.set(sx, 0.46, 0);
      group.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.46, 0.42), ironMat);
      back.position.set(sx + Math.sign(sx) * 0.18, 0.7, 0);
      group.add(back);
    }
    return group;
  }

  if (key === 'safe') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.45, 0.96),
      mat(0x273142, 0.45, 0.75)
    );
    body.name = 'Safe_Body';
    body.position.set(0, 0.725, 0);
    body.castShadow = true;
    group.add(body);

    const doorPivot = new THREE.Group();
    doorPivot.name = 'Safe_Door';
    doorPivot.position.set(0.48, 0.725, 0.48);
    const doorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.96, 1.28, 0.08),
      mat(0x334155, 0.35, 0.85)
    );
    doorMesh.position.set(-0.48, 0, 0.02);
    doorPivot.add(doorMesh);

    const dial = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.06, 12),
      mat(0xd4a347, 0.25, 0.9)
    );
    dial.name = 'Safe_Dial';
    dial.rotation.x = Math.PI / 2;
    dial.position.set(-0.54, 0, 0.08);
    doorPivot.add(dial);

    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 8, 8),
      mat(0xef4444, 0.2, 0.1, 0xef4444, 2.0)
    );
    led.name = 'Safe_LED';
    led.position.set(-0.28, 0.32, 0.08);
    doorPivot.add(led);
    group.add(doorPivot);
    return group;
  }

  if (key === 'display_case') {
    const ped = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.95, 0.95),
      mat(0x1f2937, 0.4, 0.3)
    );
    ped.name = 'Pedestal';
    ped.position.set(0, 0.475, 0);
    ped.castShadow = true;
    group.add(ped);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.75, 0.86),
      new THREE.MeshPhysicalMaterial({
        color: 0xbae6fd,
        transparent: true,
        opacity: 0.32,
        roughness: 0.1,
        metalness: 0.1,
      })
    );
    glass.name = 'Glass_Hood';
    glass.position.set(0, 1.32, 0);
    group.add(glass);

    const artifact = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18, 0),
      mat(0xfbbf24, 0.15, 0.8, 0xf59e0b, 1.4)
    );
    artifact.name = 'Artifact';
    artifact.position.set(0, 1.24, 0);
    group.add(artifact);
    return group;
  }

  if (key === 'power_box') {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.92, 0.28),
      mat(0x475569, 0.6, 0.65)
    );
    box.name = 'Box_Body';
    box.position.set(0, 0.46, 0.14);
    box.castShadow = true;
    group.add(box);

    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.28, 0.08),
      mat(0xdc2626, 0.4, 0.4)
    );
    lever.name = 'Breaker_Lever';
    lever.position.set(0.32, 0.52, 0.18);
    group.add(lever);

    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 8),
      mat(0x22c55e, 0.2, 0.1, 0x22c55e, 2.5)
    );
    led.name = 'Status_LED';
    led.position.set(0.16, 0.72, 0.29);
    group.add(led);
    return group;
  }

  if (key === 'security_camera') {
    const mount = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.18, 0.25),
      mat(0x334155, 0.5, 0.7)
    );
    mount.name = 'Camera_Mount';
    mount.position.set(0, 0.1, 0.12);
    group.add(mount);

    const head = new THREE.Group();
    head.name = 'Camera_Head';
    head.position.set(0, 0.16, 0.25);
    const lensBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.13, 0.3),
      mat(0xe2e8f0, 0.35, 0.5)
    );
    lensBody.position.set(0, 0, 0.12);
    head.add(lensBody);
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 8, 8),
      mat(0xef4444, 0.2, 0.1, 0xef4444, 3.0)
    );
    led.name = 'Camera_LED';
    led.position.set(0.05, 0.04, 0.26);
    head.add(led);
    group.add(head);
    return group;
  }

  if (key === 'palm_tree') {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.32, 5.8, 8),
      mat(0x5c4033, 0.9, 0.05)
    );
    trunk.name = 'Trunk';
    trunk.position.set(0, 2.9, 0);
    trunk.castShadow = true;
    group.add(trunk);

    const canopy = new THREE.Group();
    canopy.name = 'Canopy';
    canopy.position.set(0, 5.8, 0);
    const frondMat = mat(0x14532d, 0.75, 0.05);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.8, 5), frondMat);
      frond.rotation.z = Math.PI * 0.42;
      frond.rotation.y = a;
      frond.position.set(Math.cos(a) * 1.15, 0.15, Math.sin(a) * 1.15);
      canopy.add(frond);
    }
    group.add(canopy);
    return group;
  }

  if (key === 'streetlamp') {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.12, 4.5, 8),
      mat(0x1f2937, 0.5, 0.8)
    );
    post.name = 'Lamp_Post';
    post.position.set(0, 2.25, 0);
    post.castShadow = true;
    group.add(post);

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 10, 8),
      mat(0xffcf7d, 0.1, 0.1, 0xffb347, 3.0)
    );
    glow.name = 'Lamp_Glow';
    glow.position.set(0, 4.25, 0.4);
    group.add(glow);
    return group;
  }

  if (key === 'dresden_pillar') {
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.52, 5.4, 12),
      mat(0xb8a992, 0.75, 0.1)
    );
    col.name = 'Sandstone_Column';
    col.position.set(0, 2.7, 0);
    col.castShadow = true;
    group.add(col);

    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.35, 1.3),
      mat(0xd4a347, 0.3, 0.8)
    );
    trim.name = 'Gold_Trim';
    trim.position.set(0, 5.45, 0);
    group.add(trim);
    return group;
  }

  // salou_facade fallback
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(6.0, 8.2, 2.2),
    mat(0x9a7b5c, 0.85, 0.08)
  );
  wall.name = 'Facade_Wall';
  wall.position.set(0, 4.1, -1.1);
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  const win = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 1.3, 0.1),
    mat(0xffcf7d, 0.2, 0.1, 0xf59e0b, 1.2)
  );
  win.name = 'Windows_Warm';
  win.position.set(0, 5.1, 0.05);
  group.add(win);

  const neon = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.36, 0.14),
    mat(0x38bdf8, 0.2, 0.1, 0x38bdf8, 2.2)
  );
  neon.name = 'Neon_Sign';
  neon.position.set(0, 3.1, 0.12);
  group.add(neon);
  return group;
}
