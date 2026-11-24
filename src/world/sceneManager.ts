import * as THREE from 'three';
import {
  FloorId,
  GamePhase,
  HeistTarget,
  TargetId,
  Vec2,
} from '../sim/types';
import { TARGETS } from '../sim/data';
import { useGameStore } from '../state/store';
import { assetRegistry } from './assetLoader';
import { AudioEngine } from './audioEngine';
import { BuiltLevel, buildLevel } from './levelBuilder';
import { GuardSystem } from './guardSystem';
import { CharacterController } from './characterController';
import { VehicleController } from './vehicleController';
import { clamp, damp, dampAngleRad, dist2D } from './mathUtils';

// ============================================================================
// NACHTSCHICHT — Three.js Scene Manager & 3D Game Loop Orchestrator
// Coordinates Scouting, Live Heist Execution, and Getaway Escape modes,
// lighting, cameras, audio, asset hot-upgrade, and window.__NACHTSCHICHT__.
// ============================================================================

export interface WorldOverlayFeedback {
  promptText: string | null;
  promptSubtext: string | null;
  promptProgress: number; // 0..1
  binocularsActive: boolean;
  webglError: string | null;
  activeFloor: FloorId;
  availableFloors: FloorId[];
  showFloorSwitcher: boolean;
}

export interface NachtschichtDebugHandle {
  getState: () => {
    phase: GamePhase;
    targetId: TargetId;
    playerPos: Vec2;
    playerFloor: FloorId;
    cameraPos: { x: number; y: number; z: number };
    escapeCarPos: Vec2;
    safehousePos: Vec2;
    fps: number;
    webglOk: boolean;
    assetsReady: boolean;
    loadedModels: string[];
    loadedTextures: string[];
    powerDisabled: boolean;
    alarmLevel: string;
    guardCount: number;
    crewCount: number;
  };
  setPhase: (phase: GamePhase) => void;
  quickPlay: (targetId: TargetId, mode?: 'planning' | 'scouting' | 'executing') => void;
  setCamera: (
    pos: [number, number, number],
    lookAt: [number, number, number]
  ) => void;
  resetCamera: () => void;
  discoverAllIntel: () => void;
  teleportToSafehouse: () => void;
  getStore: () => typeof useGameStore;
}

declare global {
  interface Window {
    __NACHTSCHICHT__?: NachtschichtDebugHandle;
  }
}

export class SceneManager {
  private container: HTMLElement;
  private onFeedback: (fb: WorldOverlayFeedback) => void;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.25, 620);
  private audio: AudioEngine;

  private level: BuiltLevel | null = null;
  private guards: GuardSystem | null = null;
  private characters: CharacterController | null = null;
  private vehicles: VehicleController | null = null;
  private builtTargetId: TargetId | null = null;
  private currentPhase: GamePhase = 'title';

  // Camera state
  private cameraYaw = 0; // 0 = looking toward -Z (North)
  private cameraPitch = 0.52;
  private camPosSmooth = new THREE.Vector3(0, 6, 18);
  private camLookSmooth = new THREE.Vector3(0, 1.5, 8);
  private cameraOverride: {
    pos: THREE.Vector3;
    lookAt: THREE.Vector3;
  } | null = null;

  // Input state
  private keys = new Set<string>();
  private isDragging = false;
  private dragMoved = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private rightMouseDown = false;
  private rightMouseMoved = false;

  // Interaction & Scouting state
  private binocularsActive = false;
  private scanTargetKind: 'node' | 'guard' | null = null;
  private scanTargetId: string | null = null;
  private scanProgress = 0;
  private scanAutoLock = false;

  private interactNodeId: string | null = null;
  private interactProgress = 0;
  private interactAutoLock = false;

  // Timing & Audio transition trackers
  private rafId = 0;
  private lastFrameMs = 0;
  private elapsedSec = 0;
  private fps = 60;
  private hudSyncTimer = 0;
  private prevPowerDisabled = false;
  private prevLootTotal = 0;
  private prevRadioCount = 0;
  private disposed = false;
  private webglError: string | null = null;
  private lastFeedbackHash = '';

  // Cleanup handles
  private resizeObserver: ResizeObserver | null = null;
  private unsubStore: (() => void) | null = null;
  private unsubAssets: (() => void) | null = null;
  private debugHandle: NachtschichtDebugHandle | null = null;

  constructor(container: HTMLElement, onFeedback: (fb: WorldOverlayFeedback) => void) {
    this.container = container;
    this.onFeedback = onFeedback;
    this.audio = new AudioEngine(useGameStore.getState().audioMuted);

    this.initRenderer();
    this.initBaseLighting();
    this.bindEvents();
    this.registerDebugHook();

    // Preload GLB models & WebP textures immediately
    void assetRegistry.preloadAll();
    this.unsubAssets = assetRegistry.onReady(() => {
      if (this.disposed) return;
      // Upgrade procedural placeholders seamlessly to real GLB/WebP models while preserving live coordinates!
      this.hotUpgradeAssets();
    });

    // Build initial target
    const state = useGameStore.getState();
    this.currentPhase = state.phase;
    this.rebuildWorld(state.activeTargetId, true);

    // Subscribe to Zustand store transitions
    this.unsubStore = useGameStore.subscribe((next, prev) => {
      if (this.disposed) return;
      if (next.audioMuted !== prev.audioMuted) {
        this.audio.setMuted(next.audioMuted);
      }
      if (next.activeTargetId !== prev.activeTargetId) {
        this.rebuildWorld(next.activeTargetId, true);
      }
      if (next.phase !== prev.phase) {
        this.onPhaseChanged(next.phase);
      }
    });

    this.lastFrameMs = performance.now();
    this.loop(this.lastFrameMs);
  }

  private initRenderer(): void {
    try {
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const w = Math.max(320, this.container.clientWidth || window.innerWidth);
      const h = Math.max(240, this.container.clientHeight || window.innerHeight);
      renderer.setSize(w, h, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      renderer.domElement.setAttribute('data-testid', 'nachtschicht-webgl-canvas');

      this.container.appendChild(renderer.domElement);
      this.renderer = renderer;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();

      renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.webglError = 'WebGL-Kontext wurde unterbrochen. Bitte Ansicht neu laden.';
        this.emitFeedback(null, null, 0);
      });
      renderer.domElement.addEventListener('webglcontextrestored', () => {
        this.webglError = null;
        this.emitFeedback(null, null, 0);
      });
    } catch (err) {
      this.webglError =
        err instanceof Error
          ? `WebGL konnte nicht initialisiert werden (${err.message}).`
          : 'WebGL wird in diesem Browser nicht unterstützt.';
      this.emitFeedback(null, null, 0);
    }
  }

  private initBaseLighting(): void {
    // Rich Mediterranean midnight skylight + warm ground bounce
    const hemi = new THREE.HemisphereLight(0x4c6fa8, 0x1b2334, 0.92);
    this.scene.add(hemi);

    // Crisp coastal moonlight casting noir shadows
    const moon = new THREE.DirectionalLight(0xa5c4ff, 1.15);
    moon.position.set(-28, 46, 34);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.near = 4;
    moon.shadow.camera.far = 160;
    const d = 44;
    moon.shadow.camera.left = -d;
    moon.shadow.camera.right = d;
    moon.shadow.camera.top = d;
    moon.shadow.camera.bottom = -d;
    moon.shadow.bias = -0.0005;
    this.scene.add(moon);

    // Subtle warm city horizon rim light from the south/west promenade
    const rim = new THREE.DirectionalLight(0xffb366, 0.38);
    rim.position.set(35, 16, -28);
    this.scene.add(rim);
  }

  private rebuildWorld(targetId: TargetId, resetPositions: boolean): void {
    const prevMaraPos = this.characters ? { ...this.characters.maraPos } : null;
    const prevMaraFloor = this.characters ? this.characters.maraFloor : (0 as FloorId);
    const prevMaraRot = this.characters ? this.characters.maraRotY : Math.PI;
    const prevManual = this.characters ? this.characters.manualExecutionControl : false;
    const prevCarPos = this.vehicles ? { ...this.vehicles.carPos } : null;
    const prevCarRot = this.vehicles ? this.vehicles.carRotY : 0;

    // Dispose old level sub-systems
    if (this.level) {
      this.scene.remove(this.level.root);
      this.level.dispose();
    }
    if (this.guards) {
      this.scene.remove(this.guards.root);
      this.guards.dispose();
    }
    if (this.characters) {
      this.scene.remove(this.characters.root);
      this.characters.dispose();
    }
    if (this.vehicles) {
      this.scene.remove(this.vehicles.root);
      this.vehicles.dispose();
    }

    const target = TARGETS[targetId];
    const store = useGameStore.getState();

    this.scene.background = new THREE.Color(target.themePalette.fogColor);
    this.scene.fog = new THREE.FogExp2(target.themePalette.fogColor, 0.0062);

    this.level = buildLevel(target);
    this.scene.add(this.level.root);

    this.guards = new GuardSystem(target);
    this.scene.add(this.guards.root);

    this.characters = new CharacterController(target, store.crew);
    this.scene.add(this.characters.root);

    this.vehicles = new VehicleController(target, this.level.safehousePos);
    this.scene.add(this.vehicles.root);

    this.builtTargetId = targetId;

    if (resetPositions) {
      this.applyPhaseSetup(store.phase);
    } else if (prevMaraPos && this.characters && this.vehicles) {
      this.characters.maraPos = prevMaraPos;
      this.characters.maraFloor = prevMaraFloor;
      this.characters.maraRotY = prevMaraRot;
      this.characters.manualExecutionControl = prevManual;
      this.level.setFocusFloor(prevMaraFloor);
      if (store.phase === 'escape' && prevCarPos) {
        this.vehicles.startEscape(store.escapeState?.pursuitHeat ?? 45);
        this.vehicles.carPos = prevCarPos;
        this.vehicles.carRotY = prevCarRot;
      } else {
        this.vehicles.resetParked();
      }
    }
  }

  private hotUpgradeAssets(): void {
    if (!this.builtTargetId) return;
    this.rebuildWorld(this.builtTargetId, false);
  }

  private onPhaseChanged(phase: GamePhase): void {
    this.currentPhase = phase;
    this.applyPhaseSetup(phase);
  }

  private applyPhaseSetup(phase: GamePhase): void {
    this.binocularsActive = false;
    this.scanTargetKind = null;
    this.scanTargetId = null;
    this.scanProgress = 0;
    this.scanAutoLock = false;
    this.interactNodeId = null;
    this.interactProgress = 0;
    this.interactAutoLock = false;
    this.cameraOverride = null;

    const store = useGameStore.getState();
    this.prevPowerDisabled = store.liveState?.powerDisabled ?? false;
    this.prevLootTotal = store.liveState?.totalLootEur ?? 0;
    this.prevRadioCount = store.liveState?.radioLog.length ?? 0;

    if (!this.characters || !this.vehicles || !this.level) return;

    if (phase === 'scouting') {
      this.characters.resetForScouting();
      this.vehicles.resetParked();
      this.level.setFocusFloor(0);
      this.level.setPowerDisabled(false);
      this.cameraYaw = 0;
      this.cameraPitch = 0.44;
      this.camPosSmooth.set(
        this.characters.maraPos.x,
        4.6,
        this.characters.maraPos.z + 8.5
      );
      this.camLookSmooth.set(this.characters.maraPos.x, 1.5, this.characters.maraPos.z - 2);
      this.audio.updateEngine(0, false, false);
      this.audio.updatePoliceSiren(0, false, 0);
      this.audio.setAmbienceLevel(0.14);
    } else if (phase === 'executing') {
      this.characters.resetForExecuting();
      this.vehicles.resetParked();
      this.level.setFocusFloor(0);
      this.cameraYaw = 0.25;
      this.cameraPitch = 0.56;
      this.camPosSmooth.set(
        this.characters.maraPos.x + 3,
        6.2,
        this.characters.maraPos.z + 9.5
      );
      this.camLookSmooth.set(this.characters.maraPos.x, 1.4, this.characters.maraPos.z - 2);
      this.audio.updateEngine(0, false, false);
      this.audio.updatePoliceSiren(0, false, 0);
      this.audio.setAmbienceLevel(0.16);
    } else if (phase === 'escape') {
      this.level.setFocusFloor(0);
      this.level.setPowerDisabled(false);
      this.vehicles.startEscape(store.escapeState?.pursuitHeat ?? 55);
      const cx = this.vehicles.carPos.x;
      const cz = this.vehicles.carPos.z;
      this.camPosSmooth.set(cx - 10, 4.4, cz);
      this.camLookSmooth.set(cx + 6, 1.2, cz);
      this.audio.setAmbienceLevel(0.08);
    } else {
      this.audio.updateEngine(0, false, false);
      this.audio.updatePoliceSiren(0, false, 0);
      this.audio.setAmbienceLevel(0.06);
    }
  }

  public switchFloor(delta: number): void {
    if (!this.level || !this.characters) return;
    const floors = this.level.target.floors;
    const idx = floors.indexOf(this.characters.maraFloor);
    const nextIdx = clamp(idx + delta, 0, floors.length - 1);
    const nextFloor = floors[nextIdx];
    if (nextFloor !== undefined && nextFloor !== this.characters.maraFloor) {
      this.characters.maraFloor = nextFloor;
      this.level.setFocusFloor(nextFloor);
      this.audio.playFootstep(false);
    }
  }

  private isTypingTarget(ev: KeyboardEvent): boolean {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (this.isTypingTarget(ev)) return;
    const code = ev.code;
    this.keys.add(code);

    const store = useGameStore.getState();
    if (store.phase === 'scouting') {
      if (code === 'KeyF') {
        ev.preventDefault();
        this.binocularsActive = !this.binocularsActive;
        this.audio.playRadioBeep(false);
        store.setScoutingState({ binocularsActive: this.binocularsActive });
      } else if (code === 'KeyE') {
        this.triggerScoutingAction();
      } else if (code === 'Tab') {
        ev.preventDefault();
        store.setPhase('planning');
      } else if (code === 'BracketRight' || code === 'PageUp') {
        this.switchFloor(1);
      } else if (code === 'BracketLeft' || code === 'PageDown') {
        this.switchFloor(-1);
      }
    } else if (store.phase === 'executing') {
      if (code === 'Digit1') {
        const isHolding = store.liveState?.holdActive;
        store.issueRadioCommand(isHolding ? 'resume' : 'hold');
      } else if (code === 'Digit2') {
        store.issueRadioCommand('plan_b');
      } else if (code === 'Digit3') {
        store.issueRadioCommand('abort');
      } else if (code === 'KeyE') {
        this.triggerExecutingInteract();
      } else if (code === 'BracketRight' || code === 'PageUp') {
        this.switchFloor(1);
      } else if (code === 'BracketLeft' || code === 'PageDown') {
        this.switchFloor(-1);
      }
    } else if (store.phase === 'escape') {
      if (code === 'Space') {
        ev.preventDefault();
      }
    }
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    this.keys.delete(ev.code);
  };

  private onPointerDown = (ev: PointerEvent): void => {
    this.audio.unlock();
    if (ev.button === 2) {
      this.rightMouseDown = true;
      this.rightMouseMoved = false;
      this.lastPointerX = ev.clientX;
      this.lastPointerY = ev.clientY;
    } else if (ev.button === 0) {
      this.isDragging = true;
      this.dragMoved = false;
      this.lastPointerX = ev.clientX;
      this.lastPointerY = ev.clientY;
    }
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.isDragging && !this.rightMouseDown) return;
    const dx = ev.clientX - this.lastPointerX;
    const dy = ev.clientY - this.lastPointerY;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      if (this.isDragging) this.dragMoved = true;
      if (this.rightMouseDown) this.rightMouseMoved = true;
    }
    this.lastPointerX = ev.clientX;
    this.lastPointerY = ev.clientY;

    this.cameraYaw -= dx * 0.0055;
    this.cameraPitch = clamp(this.cameraPitch + dy * 0.004, 0.16, 1.15);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const store = useGameStore.getState();
    if (ev.button === 2) {
      if (this.rightMouseDown && !this.rightMouseMoved && store.phase === 'scouting') {
        this.binocularsActive = !this.binocularsActive;
        this.audio.playRadioBeep(false);
        store.setScoutingState({ binocularsActive: this.binocularsActive });
      }
      this.rightMouseDown = false;
    } else if (ev.button === 0) {
      if (this.isDragging && !this.dragMoved) {
        if (store.phase === 'scouting') {
          this.triggerScoutingAction();
        } else if (store.phase === 'executing') {
          this.triggerExecutingInteract();
        }
      }
      this.isDragging = false;
    }
  };

  private onContextMenu = (ev: MouseEvent): void => {
    const phase = useGameStore.getState().phase;
    if (phase === 'scouting' || phase === 'executing' || phase === 'escape') {
      ev.preventDefault();
    }
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.isDragging = false;
    this.rightMouseDown = false;
  };

  private bindEvents(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    const dom = this.renderer?.domElement ?? this.container;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('contextmenu', this.onContextMenu);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener('resize', this.handleResize);
  }

  private handleResize = (): void => {
    if (!this.renderer) return;
    const w = Math.max(320, this.container.clientWidth || window.innerWidth);
    const h = Math.max(240, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  private findBestScoutingCandidate(): {
    kind: 'node' | 'guard';
    id: string;
    label: string;
    alreadyKnown: boolean;
    connectsToFloor?: FloorId;
    connectsToPos?: Vec2;
  } | null {
    if (!this.level || !this.characters || !this.guards) return null;
    const store = useGameStore.getState();
    const target = this.level.target;
    const intel = store.intelByTarget[target.id];
    const maxRange = this.binocularsActive ? 28 : 8.5;
    const mara = this.characters.maraPos;
    const floor = this.characters.maraFloor;

    const camDirX = -Math.sin(this.cameraYaw);
    const camDirZ = -Math.cos(this.cameraYaw);

    let bestScore = Infinity;
    let best: {
      kind: 'node' | 'guard';
      id: string;
      label: string;
      alreadyKnown: boolean;
      connectsToFloor?: FloorId;
      connectsToPos?: Vec2;
    } | null = null;

    // 1) Check Target Nodes
    for (const node of target.nodes) {
      if (node.kind === 'getaway_zone') continue;
      if (!this.binocularsActive && node.floor !== floor) continue;
      const d = dist2D(mara.x, mara.z, node.pos.x, node.pos.z);
      if (d > maxRange) continue;

      const known = intel.discoveredNodeIds.includes(node.id);
      // Prioritize unknown nodes, or stairs when close
      if (known && node.connectsToFloor === undefined && d > 4.2) continue;

      let score = d;
      if (this.binocularsActive && d > 1.5) {
        const dot = ((node.pos.x - mara.x) * camDirX + (node.pos.z - mara.z) * camDirZ) / d;
        if (dot < 0.52) continue; // Must be roughly inside binocular view
        score = (1 - dot) * 20 + d * 0.25;
      }
      if (!known) score -= 6.5;

      if (score < bestScore) {
        bestScore = score;
        best = {
          kind: 'node',
          id: node.id,
          label: node.label,
          alreadyKnown: known,
          connectsToFloor: node.connectsToFloor,
          connectsToPos: node.connectsToPos,
        };
      }
    }

    // 2) Check Guards for patrol timing
    for (const g of this.guards.getGuardWorldInfo()) {
      if (!this.binocularsActive && g.floor !== floor) continue;
      const d = dist2D(mara.x, mara.z, g.pos.x, g.pos.z);
      if (d > maxRange) continue;

      const timed = intel.timedGuardIds.includes(g.guardId);
      if (timed) continue;

      let score = d - 5.5;
      if (this.binocularsActive && d > 1.5) {
        const dot = ((g.pos.x - mara.x) * camDirX + (g.pos.z - mara.z) * camDirZ) / d;
        if (dot < 0.5) continue;
        score = (1 - dot) * 18 + d * 0.25 - 6.0;
      }

      if (score < bestScore) {
        bestScore = score;
        best = {
          kind: 'guard',
          id: g.guardId,
          label: g.name,
          alreadyKnown: false,
        };
      }
    }

    return best;
  }

  private triggerScoutingAction(): void {
    const cand = this.findBestScoutingCandidate();
    if (!cand || !this.characters || !this.level) return;

    if (cand.kind === 'node' && cand.alreadyKnown && cand.connectsToFloor !== undefined) {
      this.characters.maraFloor = cand.connectsToFloor;
      if (cand.connectsToPos) {
        this.characters.maraPos = { ...cand.connectsToPos };
      }
      this.level.setFocusFloor(cand.connectsToFloor);
      this.audio.playFootstep(false);
      return;
    }

    if (!cand.alreadyKnown) {
      this.scanTargetKind = cand.kind;
      this.scanTargetId = cand.id;
      this.scanAutoLock = true;
    }
  }

  private findNearestExecutingNode(): {
    nodeId: string;
    label: string;
    isGetaway: boolean;
    connectsToFloor?: FloorId;
    connectsToPos?: Vec2;
  } | null {
    if (!this.level || !this.characters) return null;
    const store = useGameStore.getState();
    const live = store.liveState;
    if (!live) return null;
    const mara = this.characters.maraPos;
    const floor = this.characters.maraFloor;

    // Check getaway car first when close!
    const distCar = dist2D(
      mara.x,
      mara.z,
      this.level.target.getawayPos.x,
      this.level.target.getawayPos.z
    );
    if (floor === 0 && distCar < 4.5 && (live.readyForEscape || live.collectedLoot.length > 0)) {
      return {
        nodeId: 'getaway_car',
        label: 'Fluchtwagen starten (Flucht)',
        isGetaway: true,
      };
    }

    let bestDist = 3.8;
    let best: {
      nodeId: string;
      label: string;
      isGetaway: boolean;
      connectsToFloor?: FloorId;
      connectsToPos?: Vec2;
    } | null = null;

    for (const node of this.level.target.nodes) {
      if (node.floor !== floor) continue;
      if (node.kind === 'camera' || node.kind === 'lookout' || node.kind === 'getaway_zone') {
        continue;
      }
      const alreadyDone = live.completedNodeIds.includes(node.id);
      if (alreadyDone && node.connectsToFloor === undefined) continue;

      const d = dist2D(mara.x, mara.z, node.pos.x, node.pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = {
          nodeId: node.id,
          label: node.label,
          isGetaway: false,
          connectsToFloor: node.connectsToFloor,
          connectsToPos: node.connectsToPos,
        };
      }
    }
    return best;
  }

  private triggerExecutingInteract(): void {
    const near = this.findNearestExecutingNode();
    if (!near || !this.characters || !this.level) return;

    const store = useGameStore.getState();
    if (near.isGetaway) {
      store.startEscape();
      return;
    }
    if (near.connectsToFloor !== undefined) {
      const done = store.liveState?.completedNodeIds.includes(near.nodeId) ?? false;
      if (done || near.nodeId.includes('stairs')) {
        this.characters.maraFloor = near.connectsToFloor;
        if (near.connectsToPos) {
          this.characters.maraPos = { ...near.connectsToPos };
        }
        this.level.setFocusFloor(near.connectsToFloor);
        this.characters.manualExecutionControl = true;
        store.updatePlayerLivePos(
          this.characters.maraPos,
          this.characters.maraFloor,
          this.characters.getMaraHeadingDeg(),
          this.characters.maraSneaking
        );
        return;
      }
    }

    this.characters.manualExecutionControl = true;
    this.interactNodeId = near.nodeId;
    this.interactAutoLock = true;
  }

  private emitFeedback(
    promptText: string | null,
    promptSubtext: string | null,
    promptProgress: number
  ): void {
    const activeFloor = this.characters?.maraFloor ?? 0;
    const availableFloors = this.level?.target.floors ?? [0];
    const phase = useGameStore.getState().phase;
    const showFloorSwitcher =
      (phase === 'scouting' || phase === 'executing') && availableFloors.length > 1;
    const roundedProg = Math.round(promptProgress * 50) / 50;
    const hash = `${promptText}|${promptSubtext}|${roundedProg}|${this.binocularsActive}|${this.webglError}|${activeFloor}|${availableFloors.join(',')}|${showFloorSwitcher}`;
    if (hash === this.lastFeedbackHash) return;
    this.lastFeedbackHash = hash;
    this.onFeedback({
      promptText,
      promptSubtext,
      promptProgress,
      binocularsActive: this.binocularsActive,
      webglError: this.webglError,
      activeFloor,
      availableFloors,
      showFloorSwitcher,
    });
  }

  private loop = (nowMs: number): void => {
    if (this.disposed) return;
    this.rafId = window.requestAnimationFrame(this.loop);

    const rawDt = (nowMs - this.lastFrameMs) / 1000;
    this.lastFrameMs = nowMs;
    const dt = clamp(rawDt, 0.001, 0.05);
    this.elapsedSec += dt;
    this.fps = Math.round(damp(this.fps, 1 / Math.max(0.001, rawDt), 5, dt));

    const store = useGameStore.getState();
    const phase = store.phase;

    if (phase !== 'scouting' && phase !== 'executing' && phase !== 'escape') {
      this.emitFeedback(null, null, 0);
      return;
    }

    if (this.builtTargetId !== store.activeTargetId) {
      this.rebuildWorld(store.activeTargetId, true);
    }

    if (!this.level || !this.guards || !this.characters || !this.vehicles) return;

    const target = this.level.target;
    const intel = store.intelByTarget[target.id];

    // Keyboard camera yaw rotate (Q/C)
    if (phase === 'scouting' || phase === 'executing') {
      if (this.keys.has('KeyQ')) this.cameraYaw += 1.65 * dt;
      if (this.keys.has('KeyC')) this.cameraYaw -= 1.65 * dt;
    }

    if (phase === 'scouting') {
      this.tickScouting(dt, target);
    } else if (phase === 'executing') {
      this.tickExecuting(dt, target);
    } else if (phase === 'escape') {
      this.tickEscape(dt);
    }

    // Update level visuals (doors, safes, palms, power-cut lights, safehouse beacon)
    const live = store.liveState;
    const workingNodeIds = new Set<string>();
    if (phase === 'executing' && live) {
      for (const c of Object.values(live.crew)) {
        if (c.state === 'working' && c.activeBlockId) {
          const plan = store.plansByTarget[target.id];
          const blk = plan?.blocks.find((b) => b.id === c.activeBlockId);
          if (blk?.targetNodeId) workingNodeIds.add(blk.targetNodeId);
        }
      }
      if (this.interactNodeId) workingNodeIds.add(this.interactNodeId);
    }

    const bestScoutCand = phase === 'scouting' ? this.findBestScoutingCandidate() : null;
    const highlightedNodeId =
      phase === 'scouting'
        ? this.scanTargetKind === 'node'
          ? this.scanTargetId
          : bestScoutCand?.kind === 'node'
            ? bestScoutCand.id
            : null
        : phase === 'executing'
          ? this.interactNodeId ?? this.findNearestExecutingNode()?.nodeId ?? null
          : null;

    this.level.update({
      dt,
      timeSec: this.elapsedSec,
      phase,
      intel,
      completedNodeIds: phase === 'executing' && live ? live.completedNodeIds : [],
      triggeredHazardIds: phase === 'executing' && live ? live.triggeredHazardNodeIds : [],
      powerDisabled: phase === 'executing' && live ? live.powerDisabled : false,
      alarmLevel: phase === 'executing' && live ? live.alarmLevel : 'silent',
      highlightedNodeId,
      workingNodeIds,
    });

    this.guards.update({
      dt,
      timeSec: this.elapsedSec,
      phase,
      focusFloor: this.characters.maraFloor,
      intel,
      liveGuards: phase === 'executing' ? live?.guards : undefined,
      liveCameras: phase === 'executing' ? live?.cameras : undefined,
      powerDisabled: phase === 'executing' && live ? live.powerDisabled : false,
      timingGuardId:
        phase === 'scouting' && this.scanTargetKind === 'guard'
          ? this.scanTargetId
          : null,
    });

    this.characters.updateVisuals({
      dt,
      timeSec: this.elapsedSec,
      phase,
      focusFloor: this.characters.maraFloor,
      crewById: store.crew,
      liveCrew: phase === 'executing' ? live?.crew : undefined,
      maraScanProgress: phase === 'scouting' ? this.scanProgress : 0,
      maraInteractProgress: phase === 'executing' ? this.interactProgress : 0,
    });

    if (phase !== 'escape') {
      this.vehicles.updateIdle(this.elapsedSec);
    }

    this.updateCamera(dt, phase);

    if (this.renderer) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  private tickScouting(dt: number, target: HeistTarget): void {
    if (!this.level || !this.characters) return;
    const store = useGameStore.getState();

    const fwd =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const right =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const sneaking = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    const doorPositions = target.nodes
      .filter((n) => n.isAccessPoint && n.floor === this.characters!.maraFloor)
      .map((n) => n.pos);

    const moved = this.characters.moveMaraByInput({
      dt,
      forwardInput: fwd,
      rightInput: right,
      sneaking,
      cameraYawRad: this.cameraYaw,
      wallColliders: this.level.wallColliders,
      allowPassThroughDoors: true,
      doorPositions,
    });
    if (moved) {
      this.audio.playFootstep(sneaking);
    }

    // Automatically scout any room Mara walks into!
    for (const room of target.rooms) {
      if (room.floor !== this.characters.maraFloor) continue;
      if (
        this.characters.maraPos.x >= room.x &&
        this.characters.maraPos.x <= room.x + room.width &&
        this.characters.maraPos.z >= room.z &&
        this.characters.maraPos.z <= room.z + room.depth
      ) {
        const intel = store.intelByTarget[target.id];
        if (!intel.scoutedRoomIds.includes(room.id)) {
          store.scoutRoom(target.id, room.id);
        }
      }
    }

    // Scanning / Guard Timing progress
    const cand = this.findBestScoutingCandidate();
    const holdingScan = this.keys.has('KeyE') || this.scanAutoLock;
    const hasScannerRig = store.workshopUpgrades.some(
      (u) => u.id === 'scanner_rig' && u.purchased
    );
    const scanSpeed = hasScannerRig ? 1.85 : 1.05;

    if (holdingScan && cand && !cand.alreadyKnown) {
      if (this.scanTargetId !== cand.id) {
        this.scanTargetKind = cand.kind;
        this.scanTargetId = cand.id;
        this.scanProgress = 0;
      }
      this.scanProgress = Math.min(1, this.scanProgress + dt * scanSpeed);
      this.audio.playScanTick(this.scanProgress);

      if (this.scanProgress >= 1) {
        if (cand.kind === 'node') {
          store.discoverNode(target.id, cand.id);
        } else {
          store.timeGuardPatrol(target.id, cand.id);
        }
        this.audio.playDiscovery();
        this.scanProgress = 0;
        this.scanTargetKind = null;
        this.scanTargetId = null;
        this.scanAutoLock = false;
      }
    } else {
      this.scanProgress = Math.max(0, this.scanProgress - dt * 2.2);
      if (this.scanProgress <= 0.01) {
        this.scanTargetKind = null;
        this.scanTargetId = null;
        this.scanAutoLock = false;
      }
    }

    // Prompt overlay feedback
    if (cand) {
      if (!cand.alreadyKnown) {
        this.emitFeedback(
          cand.kind === 'guard'
            ? `[E] Wachrunde stoppen: ${cand.label}`
            : `[E] Auskundschaften: ${cand.label}`,
          this.binocularsActive ? 'Fernglas aktiv · gedrückt halten' : 'F / Rechtsklick für Fernglas',
          this.scanProgress
        );
      } else if (cand.connectsToFloor !== undefined) {
        this.emitFeedback(
          `[E] Etage wechseln (${cand.label})`,
          'Treppe / Zugang nutzen',
          0
        );
      } else {
        this.emitFeedback(null, null, 0);
      }
    } else {
      this.emitFeedback(null, null, 0);
    }

    // Throttled store HUD sync (~15 Hz)
    this.hudSyncTimer += dt;
    if (this.hudSyncTimer >= 0.065) {
      this.hudSyncTimer = 0;
      store.setScoutingState({
        binocularsActive: this.binocularsActive,
        nearbyNodeId: cand?.kind === 'node' ? cand.id : null,
        nearbyNodeLabel: cand?.kind === 'node' ? cand.label : null,
        scanProgress: cand?.kind === 'node' ? this.scanProgress : 0,
        timingGuardId: cand?.kind === 'guard' ? cand.id : null,
        timingGuardName: cand?.kind === 'guard' ? cand.label : null,
        guardTimingProgress: cand?.kind === 'guard' ? this.scanProgress : 0,
        playerPos: { ...this.characters.maraPos },
        playerFloor: this.characters.maraFloor,
      });
    }
  }

  private tickExecuting(dt: number, target: HeistTarget): void {
    if (!this.level || !this.characters) return;
    const store = useGameStore.getState();

    const fwd =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const right =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const sneaking = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    const liveBefore = store.liveState;
    const doorPositions = target.nodes
      .filter((n) => n.isAccessPoint && n.floor === this.characters!.maraFloor)
      .map((n) => n.pos);

    if (Math.abs(fwd) > 0.05 || Math.abs(right) > 0.05) {
      this.characters.manualExecutionControl = true;
    }

    if (this.characters.manualExecutionControl) {
      const moved = this.characters.moveMaraByInput({
        dt,
        forwardInput: fwd,
        rightInput: right,
        sneaking,
        cameraYawRad: this.cameraYaw,
        wallColliders: this.level.wallColliders,
        allowPassThroughDoors: true,
        doorPositions,
      });
      if (moved) {
        this.audio.playFootstep(sneaking);
      }
      store.updatePlayerLivePos(
        this.characters.maraPos,
        this.characters.maraFloor,
        this.characters.getMaraHeadingDeg(),
        sneaking
      );
    }

    // Advance pure-TS simulation engine for AI crew, guards, cameras, deviations, alarms!
    store.tickLiveExecution(dt, {
      playerSteeredExternally: this.characters.manualExecutionControl,
    });

    const liveAfter = useGameStore.getState().liveState;
    if (!liveAfter) return;

    // Keep floor cutaway synced if Mara changes floor on auto-track
    if (!this.characters.manualExecutionControl && liveAfter.crew.mara) {
      if (liveAfter.crew.mara.floor !== this.characters.maraFloor) {
        this.level.setFocusFloor(liveAfter.crew.mara.floor);
      }
    }

    // Audio event triggers from live state changes
    if (liveAfter.powerDisabled && !this.prevPowerDisabled) {
      this.audio.playPowerCut();
    }
    this.prevPowerDisabled = liveAfter.powerDisabled;

    if (liveAfter.totalLootEur > this.prevLootTotal) {
      this.audio.playLootPickup();
    }
    this.prevLootTotal = liveAfter.totalLootEur;

    if (liveAfter.radioLog.length > this.prevRadioCount) {
      this.audio.playRadioBeep(liveAfter.abortActive || liveAfter.planBActive);
    }
    this.prevRadioCount = liveAfter.radioLog.length;

    if (liveAfter.alarmLevel === 'alarm' || liveAfter.alarmLevel === 'lockdown') {
      this.audio.playAlarmPulse();
    }

    // Interactive work progress for Mara pressing E on a nearby node
    const near = this.findNearestExecutingNode();
    if (
      (this.keys.has('KeyE') || this.interactAutoLock) &&
      near &&
      !near.isGetaway &&
      (!liveBefore || !liveBefore.completedNodeIds.includes(near.nodeId))
    ) {
      this.interactNodeId = near.nodeId;
      this.interactProgress = Math.min(1, this.interactProgress + dt * 1.25);
      this.audio.playLockpickClick();
      if (this.interactProgress >= 1) {
        store.interactPlayerWithNode(near.nodeId);
        this.interactProgress = 0;
        this.interactNodeId = null;
        this.interactAutoLock = false;
      }
    } else {
      this.interactProgress = Math.max(0, this.interactProgress - dt * 2.5);
      if (this.interactProgress <= 0.01) {
        this.interactNodeId = null;
        this.interactAutoLock = false;
      }
    }

    // Contextual prompt
    if (near) {
      this.emitFeedback(
        near.isGetaway ? '[E] Einsteigen & Flucht starten!' : `[E] ${near.label}`,
        near.isGetaway
          ? 'Alle Mann ab Richtung La Pineda'
          : '1: Halten · 2: Plan B · 3: Abbruch',
        this.interactProgress
      );
    } else if (liveAfter.readyForEscape) {
      this.emitFeedback(
        'Fluchtwagen bereit!',
        'Zum Fluchtwagen laufen & [E] drücken',
        0
      );
    } else {
      this.emitFeedback(null, null, 0);
    }
  }

  private tickEscape(dt: number): void {
    if (!this.level || !this.vehicles) return;
    const store = useGameStore.getState();

    const throttle =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const steer =
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) -
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0);
    const handbrake = this.keys.has('Space');

    const res = this.vehicles.updateEscape({
      dt,
      timeSec: this.elapsedSec,
      throttle,
      steer,
      handbrake,
      cityBoxColliders: this.level.cityBoxColliders,
      audio: this.audio,
    });

    this.hudSyncTimer += dt;
    if (this.hudSyncTimer >= 0.06 || res.finished) {
      this.hudSyncTimer = 0;
      store.updateEscapeState(res.patch);
    }

    if (res.finished === 'escaped') {
      this.audio.playDiscovery();
      this.audio.updateEngine(0, false, false);
      this.audio.updatePoliceSiren(0, false, 0);
      store.finishEscape(true);
    } else if (res.finished === 'busted') {
      this.audio.playAlarmPulse();
      this.audio.updateEngine(0, false, false);
      this.audio.updatePoliceSiren(0, false, 0);
      store.finishEscape(false);
    } else {
      this.emitFeedback(null, null, 0);
    }
  }

  private updateCamera(dt: number, phase: 'scouting' | 'executing' | 'escape'): void {
    if (this.cameraOverride) {
      this.camera.position.copy(this.cameraOverride.pos);
      this.camera.lookAt(this.cameraOverride.lookAt);
      return;
    }

    if (phase === 'escape' && this.vehicles) {
      const carX = this.vehicles.carPos.x;
      const carZ = this.vehicles.carPos.z;
      const rot = this.vehicles.carRotY;
      const fwdX = Math.sin(rot);
      const fwdZ = Math.cos(rot);

      const speedNorm = clamp(this.vehicles.speedKmh / 120, 0, 1);
      const dist = 9.2 + speedNorm * 2.2;
      const height = 4.1 + speedNorm * 0.7;

      const desiredPos = new THREE.Vector3(
        carX - fwdX * dist,
        height,
        carZ - fwdZ * dist
      );
      const desiredLook = new THREE.Vector3(
        carX + fwdX * (5.5 + speedNorm * 3.5),
        1.25,
        carZ + fwdZ * (5.5 + speedNorm * 3.5)
      );

      this.camPosSmooth.lerp(desiredPos, 1 - Math.exp(-6.5 * dt));
      this.camLookSmooth.lerp(desiredLook, 1 - Math.exp(-9.0 * dt));

      const targetFov = 56 + speedNorm * 13;
      this.camera.fov = damp(this.camera.fov, targetFov, 6, dt);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.camPosSmooth);
      this.camera.lookAt(this.camLookSmooth);
      return;
    }

    if (this.characters && this.level) {
      const fy = this.characters.maraFloor * this.level.target.floorHeightM;
      const mx = this.characters.maraPos.x;
      const mz = this.characters.maraPos.z;

      const isBino = phase === 'scouting' && this.binocularsActive;
      const targetFov = isBino ? 25 : 54;
      if (Math.abs(this.camera.fov - targetFov) > 0.05) {
        this.camera.fov = damp(this.camera.fov, targetFov, 9, dt);
        this.camera.updateProjectionMatrix();
      }

      if (isBino) {
        // Elevated over-shoulder binocular vantage
        const lookDist = 18;
        const dirX = -Math.sin(this.cameraYaw);
        const dirZ = -Math.cos(this.cameraYaw);
        const desiredPos = new THREE.Vector3(mx - dirX * 0.9, fy + 1.95, mz - dirZ * 0.9);
        const desiredLook = new THREE.Vector3(
          mx + dirX * lookDist,
          fy + 1.55 - (this.cameraPitch - 0.35) * 4.5,
          mz + dirZ * lookDist
        );
        this.camPosSmooth.lerp(desiredPos, 1 - Math.exp(-12 * dt));
        this.camLookSmooth.lerp(desiredLook, 1 - Math.exp(-12 * dt));
      } else {
        const dist = phase === 'executing' ? 9.4 : 8.2;
        const horiz = Math.cos(this.cameraPitch) * dist;
        const vert = Math.sin(this.cameraPitch) * dist + 1.5;

        const desiredPos = new THREE.Vector3(
          mx + Math.sin(this.cameraYaw) * horiz,
          fy + vert,
          mz + Math.cos(this.cameraYaw) * horiz
        );
        const desiredLook = new THREE.Vector3(mx, fy + 1.25, mz);

        this.camPosSmooth.lerp(desiredPos, 1 - Math.exp(-8.5 * dt));
        this.camLookSmooth.lerp(desiredLook, 1 - Math.exp(-11 * dt));
      }

      this.camera.position.copy(this.camPosSmooth);
      this.camera.lookAt(this.camLookSmooth);
    }
  }

  private registerDebugHook(): void {
    const handle: NachtschichtDebugHandle = {
      getState: () => {
        const s = useGameStore.getState();
        return {
          phase: s.phase,
          targetId: s.activeTargetId,
          playerPos: this.characters ? { ...this.characters.maraPos } : { x: 0, z: 0 },
          playerFloor: this.characters?.maraFloor ?? 0,
          cameraPos: {
            x: Math.round(this.camera.position.x * 100) / 100,
            y: Math.round(this.camera.position.y * 100) / 100,
            z: Math.round(this.camera.position.z * 100) / 100,
          },
          escapeCarPos: this.vehicles ? { ...this.vehicles.carPos } : { x: 0, z: 0 },
          safehousePos: this.level ? { ...this.level.safehousePos } : { x: 162, z: -158 },
          fps: this.fps,
          webglOk: this.renderer !== null && this.webglError === null,
          assetsReady: assetRegistry.isReady(),
          loadedModels: assetRegistry.loadedModelKeys,
          loadedTextures: assetRegistry.loadedTextureKeys,
          powerDisabled: s.liveState?.powerDisabled ?? false,
          alarmLevel: s.liveState?.alarmLevel ?? 'silent',
          guardCount: this.guards?.getGuardWorldInfo().length ?? 0,
          crewCount: s.liveState ? Object.keys(s.liveState.crew).length : 1,
        };
      },
      setPhase: (phase) => {
        useGameStore.getState().setPhase(phase);
      },
      quickPlay: (targetId, mode = 'executing') => {
        useGameStore.getState().quickPlayTarget(targetId, mode);
      },
      setCamera: (pos, lookAt) => {
        this.cameraOverride = {
          pos: new THREE.Vector3(pos[0], pos[1], pos[2]),
          lookAt: new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]),
        };
        if (this.renderer) {
          this.camera.position.copy(this.cameraOverride.pos);
          this.camera.lookAt(this.cameraOverride.lookAt);
          this.renderer.render(this.scene, this.camera);
        }
      },
      resetCamera: () => {
        this.cameraOverride = null;
      },
      discoverAllIntel: () => {
        const s = useGameStore.getState();
        const t = TARGETS[s.activeTargetId];
        for (const n of t.nodes) {
          s.discoverNode(t.id, n.id);
        }
        for (const g of t.guards) {
          s.timeGuardPatrol(t.id, g.id);
        }
      },
      teleportToSafehouse: () => {
        this.vehicles?.teleportNearSafehouse();
      },
      getStore: () => useGameStore,
    };

    this.debugHandle = handle;
    if (typeof window !== 'undefined') {
      window.__NACHTSCHICHT__ = handle;
    }
  }

  public dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);

    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.handleResize);

    const dom = this.renderer?.domElement ?? this.container;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('contextmenu', this.onContextMenu);

    this.resizeObserver?.disconnect();
    this.unsubStore?.();
    this.unsubAssets?.();

    this.level?.dispose();
    this.guards?.dispose();
    this.characters?.dispose();
    this.vehicles?.dispose();
    this.audio.dispose();

    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode === this.container) {
        this.container.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }

    if (typeof window !== 'undefined' && window.__NACHTSCHICHT__ === this.debugHandle) {
      delete window.__NACHTSCHICHT__;
    }
  }
}

export { dampAngleRad };
