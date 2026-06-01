import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_COOLDOWN,
  BOSS_LEVEL_INTERVAL,
  BULLET_SPEED,
  BUNKER_CELL,
  BUNKER_COLS,
  BUNKER_ROWS,
  BURST_MS,
  COMBO_WINDOW_MS,
  DIFFICULTY,
  ENEMY_BULLET_BASE,
  ENEMY_COLORS,
  ENEMY_HALF_H,
  ENEMY_HALF_W,
  FIELD_H,
  FORMATION_TOP,
  HIT_STOP_MS,
  INVULN_MS,
  PIERCE_DURATION,
  PLAYER_HALF_W,
  PLAYER_SPEED,
  PLAYER_Y,
  POWERUP_DROP_CHANCE,
  POWERUP_DURATION,
  POWERUP_FALL,
  POWERUP_NAME,
  RAPID_COOLDOWN,
  ROW_GAP,
  COL_GAP,
  SHIELD_DURATION,
  SLOW_DURATION,
  UFO_MAX_INTERVAL_MS,
  UFO_MIN_INTERVAL_MS,
  createRng,
  enemyPoints,
  formationBounds,
  hashString,
  hitBunker,
  pickPowerupKind,
  spawnBoss,
  spawnBunkers,
  spawnWave,
  todaySeedString,
  type ActiveBuff,
  type Boss,
  type Bullet,
  type Bunker,
  type Burst,
  type Enemy,
  type FloatText,
  type Particle,
  type Powerup,
  type PowerupKind,
  type Rng,
  type Ufo,
} from "./engine";
import {
  ACHIEVEMENTS,
  type AchievementKey,
  type GameSettings,
  loadAchievements,
  loadCounters,
  loadSettings,
  saveAchievements,
  saveCounters,
  saveSettings,
} from "./storage";

export type Phase = "ready" | "playing" | "paused" | "over";

export type GameState = {
  phase: Phase;
  score: number;
  combo: number;
  maxCombo: number;
  kills: number;
  level: number;
  lives: number;
  activeBuff: ActiveBuff | null;
  shieldUntil: number;
  hitStopUntil: number;
  shakeUntil: number;
  // refs (mutated each frame; read for rendering through frame ticks)
  bullets: Bullet[];
  enemyBullets: Bullet[];
  enemies: Enemy[];
  boss: Boss | null;
  ufo: Ufo | null;
  bunkers: Bunker[];
  bursts: Burst[];
  particles: Particle[];
  powerups: Powerup[];
  floats: FloatText[];
  formationX: number;
  formationY: number;
  playerX: number;
  startedAt: number;
  durationMs: number;
  newAchievements: AchievementKey[];
};

// Live, mutable game data exposed to GameField for per-frame rendering
// without going through React state. GameField subscribes via `subscribe`
// and reads these refs directly, avoiding a parent re-render every RAF.
export type LiveGame = {
  bullets: Bullet[];
  enemyBullets: Bullet[];
  enemies: Enemy[];
  boss: Boss | null;
  ufo: Ufo | null;
  bunkers: Bunker[];
  bursts: Burst[];
  particles: Particle[];
  powerups: Powerup[];
  floats: FloatText[];
  formationX: number;
  formationY: number;
  playerX: number;
  shieldUntil: number;
  shakeUntil: number;
  invulnUntil: number;
};

export type UseInvaderGameResult = {
  state: GameState;
  settings: GameSettings;
  setSettings: (next: GameSettings) => void;
  setKey: (key: "left" | "right" | "fire", pressed: boolean) => void;
  start: () => void;
  togglePause: () => void;
  restart: () => void;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  // Per-frame data for GameField + subscribe API to drive its render loop.
  getLive: () => LiveGame;
  subscribe: (listener: () => void) => () => void;
  // For result submission once game ends.
  consumeFinishedRun: () => null | {
    score: number;
    level: number;
    kills: number;
    maxCombo: number;
    durationMs: number;
    dailySeed: string | null;
    achievements: AchievementKey[];
  };
};

// Soft caps to keep the SVG render + GC pressure bounded.
const MAX_PARTICLES = 80;
const MAX_BURSTS = 24;
const MAX_FLOATS = 40;
const MAX_PLAYER_BULLETS = 40;
const MAX_ENEMY_BULLETS = 40;

function newId(ref: { current: number }): number {
  ref.current += 1;
  return ref.current;
}

function emitParticles(
  arr: Particle[],
  idRef: { current: number },
  x: number,
  y: number,
  color: string,
  count: number,
  speed: number,
  ttl: number,
) {
  for (let i = 0; i < count; i++) {
    if (arr.length >= MAX_PARTICLES) arr.shift();
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.5 + Math.random());
    arr.push({
      id: newId(idRef),
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0,
      ttl,
      color,
    });
  }
}

export function useInvaderGame(): UseInvaderGameResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const reducedMotionRef = useRef(false);
  const idRef = useRef(1);

  const [settings, setSettingsState] = useState<GameSettings>(() => loadSettings());
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const setSettings = useCallback((next: GameSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  // Phase
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Counters / achievements
  const achievementsRef = useRef<Set<AchievementKey>>(new Set());
  const countersRef = useRef(loadCounters());
  useEffect(() => {
    achievementsRef.current = loadAchievements();
  }, []);

  // RNG — re-created per run; deterministic when dailyMode is on.
  const rngRef = useRef<Rng>(createRng(Date.now() >>> 0));
  const dailySeedRef = useRef<string | null>(null);

  // ---------- State surfaced to React ----------
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [kills, setKills] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(3);
  const [activeBuff, setActiveBuff] = useState<ActiveBuff | null>(null);
  // Per-frame subscribers (GameField). Avoid setState on parent every RAF.
  const listenersRef = useRef<Set<() => void>>(new Set());
  const notify = useCallback(() => {
    for (const l of listenersRef.current) l();
  }, []);
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  const [newAchievements, setNewAchievements] = useState<AchievementKey[]>([]);

  // ---------- Per-frame refs ----------
  const playerXRef = useRef(50);
  const playerCooldownRef = useRef(0);
  const invulnUntilRef = useRef(0);
  const shieldUntilRef = useRef(0);
  const shakeUntilRef = useRef(0);
  const hitStopUntilRef = useRef(0);
  const keysRef = useRef<{ left: boolean; right: boolean; fire: boolean }>({
    left: false,
    right: false,
    fire: false,
  });

  const bulletsRef = useRef<Bullet[]>([]);
  const enemyBulletsRef = useRef<Bullet[]>([]);
  const enemiesRef = useRef<Enemy[]>([]);
  const bossRef = useRef<Boss | null>(null);
  const ufoRef = useRef<Ufo | null>(null);
  const nextUfoAtRef = useRef(0);
  const bunkersRef = useRef<Bunker[]>([]);
  const burstsRef = useRef<Burst[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const powerupsRef = useRef<Powerup[]>([]);
  const floatsRef = useRef<FloatText[]>([]);

  const formationXRef = useRef(10);
  const formationYRef = useRef(FORMATION_TOP);
  const marchDirRef = useRef<1 | -1>(1);
  const marchSpeedRef = useRef(6);
  const levelRef = useRef(1);
  const comboRef = useRef(0);
  const comboExpireAtRef = useRef(0);
  const maxComboRef = useRef(0);
  const killsRef = useRef(0);
  const tookHitThisWaveRef = useRef(false);

  const activeBuffRef = useRef<ActiveBuff | null>(null);
  const startedAtRef = useRef(0);
  const finishedRunRef =
    useRef<UseInvaderGameResult["consumeFinishedRun"] extends () => infer R ? R : never>(null);
  const newAchRunRef = useRef<AchievementKey[]>([]);

  // ---------- Audio ----------
  const ensureAudio = useCallback(() => {
    if (reducedMotionRef.current) return null;
    if (settingsRef.current.muted) return null;
    if (!audioCtxRef.current) {
      const Ctor =
        (window.AudioContext as typeof AudioContext | undefined) ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  type Tone = {
    type: OscillatorType;
    fStart: number;
    fEnd: number;
    dur: number;
    gain: number;
  };
  const playTone = useCallback(
    (tone: Tone) => {
      const ctx = ensureAudio();
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = tone.type;
      const t0 = ctx.currentTime;
      o.frequency.setValueAtTime(tone.fStart, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, tone.fEnd), t0 + tone.dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(tone.gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + tone.dur + 0.02);
    },
    [ensureAudio],
  );

  // Memoized so the object identity is stable — otherwise every consumer
  // useCallback/effect (incl. the RAF game loop) would re-create each render.
  const sfx = useMemo(
    () => ({
      pew: () => playTone({ type: "sine", fStart: 880, fEnd: 220, dur: 0.07, gain: 0.035 }),
      boom: () => playTone({ type: "triangle", fStart: 180, fEnd: 60, dur: 0.25, gain: 0.07 }),
      bigBoom: () => playTone({ type: "sawtooth", fStart: 220, fEnd: 40, dur: 0.45, gain: 0.09 }),
      pickup: () => playTone({ type: "square", fStart: 660, fEnd: 990, dur: 0.1, gain: 0.05 }),
      ufo: () => playTone({ type: "sawtooth", fStart: 440, fEnd: 660, dur: 0.2, gain: 0.04 }),
      achievement: () =>
        playTone({ type: "triangle", fStart: 523, fEnd: 1046, dur: 0.3, gain: 0.06 }),
    }),
    [playTone],
  );

  // ---------- Achievements ----------
  const unlock = useCallback(
    (key: AchievementKey) => {
      if (achievementsRef.current.has(key)) return;
      achievementsRef.current.add(key);
      saveAchievements(achievementsRef.current);
      newAchRunRef.current.push(key);
      setNewAchievements([...newAchRunRef.current]);
      sfx.achievement();
      const def = ACHIEVEMENTS.find((a) => a.key === key);
      if (def) {
        floatsRef.current.push({
          id: newId(idRef),
          x: 50,
          y: 30,
          text: `★ ${def.name.toUpperCase()}`,
          startedAt: performance.now(),
          color: "#ffe066",
        });
      }
    },
    [sfx],
  );

  // ---------- Gameplay actions ----------
  const initRng = useCallback(() => {
    if (settingsRef.current.dailyMode) {
      const seed = todaySeedString();
      dailySeedRef.current = seed;
      rngRef.current = createRng(hashString(`zerrow-invader-${seed}`));
    } else {
      dailySeedRef.current = null;
      rngRef.current = createRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    }
  }, []);

  const resetGame = useCallback(() => {
    initRng();
    levelRef.current = 1;
    enemiesRef.current = spawnWave(1, rngRef.current);
    bossRef.current = null;
    ufoRef.current = null;
    nextUfoAtRef.current = performance.now() + 8000;
    bunkersRef.current = spawnBunkers();
    bulletsRef.current = [];
    enemyBulletsRef.current = [];
    burstsRef.current = [];
    particlesRef.current = [];
    powerupsRef.current = [];
    floatsRef.current = [];
    formationXRef.current = 10;
    formationYRef.current = FORMATION_TOP;
    marchDirRef.current = 1;
    marchSpeedRef.current = 6;
    playerXRef.current = 50;
    playerCooldownRef.current = 0;
    invulnUntilRef.current = 0;
    shieldUntilRef.current = 0;
    shakeUntilRef.current = 0;
    hitStopUntilRef.current = 0;
    activeBuffRef.current = null;
    setActiveBuff(null);
    comboRef.current = 0;
    comboExpireAtRef.current = 0;
    maxComboRef.current = 0;
    killsRef.current = 0;
    tookHitThisWaveRef.current = false;
    startedAtRef.current = performance.now();
    newAchRunRef.current = [];
    setNewAchievements([]);
    setScore(0);
    setCombo(0);
    setMaxCombo(0);
    setKills(0);
    setLives(3);
    setLevel(1);
  }, [initRng]);

  // Init once on mount.
  useEffect(() => {
    bunkersRef.current = spawnBunkers();
    enemiesRef.current = spawnWave(1, rngRef.current);
    nextUfoAtRef.current = performance.now() + 8000;
  }, []);

  const start = useCallback(() => {
    ensureAudio();
    if (phaseRef.current === "ready") setPhase("playing");
    else if (phaseRef.current === "paused") setPhase("playing");
    else if (phaseRef.current === "over") {
      resetGame();
      setPhase("playing");
    }
  }, [ensureAudio, resetGame]);

  const togglePause = useCallback(() => {
    if (phaseRef.current === "playing") setPhase("paused");
    else if (phaseRef.current === "paused") setPhase("playing");
  }, []);

  const restart = useCallback(() => {
    resetGame();
    setPhase("playing");
  }, [resetGame]);

  const setKey = useCallback((key: "left" | "right" | "fire", pressed: boolean) => {
    keysRef.current[key] = pressed;
  }, []);

  // ---------- Reduced motion ----------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = () => {
      reducedMotionRef.current = mq.matches;
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // ---------- Keyboard ----------
  useEffect(() => {
    const isEditableTarget = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e)) return;
      const k = e.key;
      const isGameKey = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "a",
        "A",
        "d",
        "D",
        "w",
        "W",
        " ",
        "p",
        "P",
        "Enter",
        "m",
        "M",
      ].includes(k);
      if (!isGameKey) return;
      e.preventDefault();
      ensureAudio();
      if (k === "ArrowLeft" || k === "a" || k === "A") keysRef.current.left = true;
      if (k === "ArrowRight" || k === "d" || k === "D") keysRef.current.right = true;
      if (k === " " || k === "ArrowUp" || k === "w" || k === "W") keysRef.current.fire = true;
      if (k === " " || k === "Enter") {
        if (phaseRef.current === "ready") setPhase("playing");
        else if (phaseRef.current === "over") {
          resetGame();
          setPhase("playing");
        }
      }
      if (k === "p" || k === "P") togglePause();
      if (k === "m" || k === "M") {
        const next = { ...settingsRef.current, muted: !settingsRef.current.muted };
        settingsRef.current = next;
        setSettingsState(next);
        saveSettings(next);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      const k = e.key;
      if (k === "ArrowLeft" || k === "a" || k === "A") keysRef.current.left = false;
      if (k === "ArrowRight" || k === "d" || k === "D") keysRef.current.right = false;
      if (k === " " || k === "ArrowUp" || k === "w" || k === "W") keysRef.current.fire = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [ensureAudio, resetGame, togglePause]);

  // ---------- Gamepad ----------
  const gamepadFirePrevRef = useRef(false);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      for (const p of pads) {
        if (!p) continue;
        const ax = p.axes[0] ?? 0;
        const left = p.buttons[14]?.pressed || ax < -0.3;
        const right = p.buttons[15]?.pressed || ax > 0.3;
        const fire = p.buttons[0]?.pressed || p.buttons[7]?.pressed;
        keysRef.current.left = left;
        keysRef.current.right = right;
        keysRef.current.fire = !!fire;
        const startBtn = p.buttons[9]?.pressed;
        if (startBtn && !gamepadFirePrevRef.current) togglePause();
        gamepadFirePrevRef.current = !!startBtn;
        break;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [togglePause]);

  // ---------- Power-up application ----------
  const applyPowerup = useCallback(
    (kind: PowerupKind, now: number) => {
      sfx.pickup();
      floatsRef.current.push({
        id: newId(idRef),
        x: playerXRef.current,
        y: PLAYER_Y - 4,
        text: POWERUP_NAME[kind],
        startedAt: now,
        color: "#fff5e0",
      });
      if (kind === "shield") {
        shieldUntilRef.current = now + SHIELD_DURATION;
        invulnUntilRef.current = Math.max(invulnUntilRef.current, now + SHIELD_DURATION);
        return;
      }
      if (kind === "life") {
        setLives((l) => Math.min(5, l + 1));
        return;
      }
      if (kind === "bomb") {
        sfx.bigBoom();
        shakeUntilRef.current = now + 250;
        // Kill everything currently on screen.
        let killed = 0;
        const fx = formationXRef.current;
        const fy = formationYRef.current;
        for (const e of enemiesRef.current) {
          if (!e.alive) continue;
          e.alive = false;
          killed += 1;
          const ex = fx + e.col * COL_GAP;
          const ey = fy + e.row * ROW_GAP;
          burstsRef.current.push({ id: newId(idRef), x: ex, y: ey, startedAt: now });
          emitParticles(
            particlesRef.current,
            idRef,
            ex,
            ey,
            ENEMY_COLORS[e.kind].accent,
            8,
            18,
            600,
          );
        }
        const boss = bossRef.current;
        if (boss) {
          boss.hp -= 8;
          emitParticles(particlesRef.current, idRef, boss.x, boss.y, "#ff5a8a", 14, 22, 700);
        }
        killsRef.current += killed;
        setKills(killsRef.current);
        setScore((s) => s + killed * 5 * levelRef.current);
        return;
      }
      const dur =
        kind === "rapid" || kind === "multi"
          ? POWERUP_DURATION
          : kind === "pierce"
            ? PIERCE_DURATION
            : SLOW_DURATION;
      const buff: ActiveBuff = { kind: kind as ActiveBuff["kind"], expiresAt: now + dur };
      activeBuffRef.current = buff;
      setActiveBuff(buff);
    },
    [sfx],
  );

  // ---------- Helpers used in loop ----------
  const handleEnemyKill = useCallback(
    (enemy: Enemy, ex: number, ey: number, now: number) => {
      // combo
      if (now < comboExpireAtRef.current) {
        comboRef.current += 1;
      } else {
        comboRef.current = 1;
      }
      comboExpireAtRef.current = now + COMBO_WINDOW_MS;
      if (comboRef.current > maxComboRef.current) {
        maxComboRef.current = comboRef.current;
        setMaxCombo(maxComboRef.current);
      }
      setCombo(comboRef.current);
      if (comboRef.current >= 10) unlock("streak_10");
      if (comboRef.current >= 25) unlock("streak_25");

      const pts = enemyPoints(enemy.kind, levelRef.current, comboRef.current);
      setScore((s) => s + pts);
      killsRef.current += 1;
      setKills(killsRef.current);
      if (killsRef.current === 1) unlock("first_blood");

      burstsRef.current.push({ id: newId(idRef), x: ex, y: ey, startedAt: now });
      emitParticles(
        particlesRef.current,
        idRef,
        ex,
        ey,
        ENEMY_COLORS[enemy.kind].accent,
        5,
        20,
        500,
      );
      floatsRef.current.push({
        id: newId(idRef),
        x: ex,
        y: ey,
        text: `+${pts}${comboRef.current > 1 ? ` ×${comboRef.current}` : ""}`,
        startedAt: now,
        color: comboRef.current >= 5 ? "#ffe066" : "#fff5e0",
      });
      sfx.boom();
      if (Math.random() < POWERUP_DROP_CHANCE) {
        powerupsRef.current.push({
          id: newId(idRef),
          x: ex,
          y: ey,
          kind: pickPowerupKind(rngRef.current),
        });
      }
    },
    [sfx, unlock],
  );

  // ---------- Main RAF loop ----------
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      if (reducedMotionRef.current) {
        raf = requestAnimationFrame(loop);
        return;
      }
      if (phaseRef.current !== "playing") {
        // Still tick particles/floats/bursts so pause overlay looks alive,
        // but only notify subscribers — don't re-render the React parent.
        notify();
        raf = requestAnimationFrame(loop);
        return;
      }
      if (now < hitStopUntilRef.current) {
        notify();
        raf = requestAnimationFrame(loop);
        return;
      }

      const dts = dt / 1000;
      const diff = DIFFICULTY[settingsRef.current.difficulty];

      // Expire combo
      if (comboRef.current > 0 && now >= comboExpireAtRef.current) {
        comboRef.current = 0;
        setCombo(0);
      }

      // Expire buff
      if (activeBuffRef.current && now >= activeBuffRef.current.expiresAt) {
        activeBuffRef.current = null;
        setActiveBuff(null);
      }

      // Player movement
      let px = playerXRef.current;
      if (keysRef.current.left) px -= PLAYER_SPEED * dts;
      if (keysRef.current.right) px += PLAYER_SPEED * dts;
      if (px < 6) px = 6;
      if (px > 94) px = 94;
      playerXRef.current = px;

      // Player firing
      playerCooldownRef.current = Math.max(0, playerCooldownRef.current - dt);
      const buffKind = activeBuffRef.current?.kind;
      const cooldown = buffKind === "rapid" ? RAPID_COOLDOWN : BASE_COOLDOWN;
      if (keysRef.current.fire && playerCooldownRef.current === 0) {
        const y0 = PLAYER_Y - 4;
        const pierce = buffKind === "pierce";
        if (buffKind === "multi") {
          bulletsRef.current.push({ id: newId(idRef), x: px, y: y0, vx: 0, pierce });
          bulletsRef.current.push({ id: newId(idRef), x: px - 0.7, y: y0 + 0.4, vx: -14, pierce });
          bulletsRef.current.push({ id: newId(idRef), x: px + 0.7, y: y0 + 0.4, vx: 14, pierce });
        } else {
          bulletsRef.current.push({ id: newId(idRef), x: px, y: y0, vx: 0, pierce });
        }
        playerCooldownRef.current = cooldown;
        sfx.pew();
      }

      // Player bullets travel (in-place, no allocations)
      {
        const arr = bulletsRef.current;
        let w = 0;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i];
          b.x += (b.vx ?? 0) * dts;
          b.y -= BULLET_SPEED * dts;
          if (b.y > -2 && b.x > -2 && b.x < 102) arr[w++] = b;
        }
        arr.length = w;
        if (arr.length > MAX_PLAYER_BULLETS) arr.splice(0, arr.length - MAX_PLAYER_BULLETS);
      }

      const lvl = levelRef.current;
      const slowMul = buffKind === "slow" ? 0.5 : 1;

      // ---- Boss wave (every BOSS_LEVEL_INTERVAL levels) ----
      if (bossRef.current) {
        const boss = bossRef.current;
        boss.x += boss.vx * dts * slowMul * diff.speedMul;
        if (boss.x < 10) {
          boss.x = 10;
          boss.vx = Math.abs(boss.vx);
        }
        if (boss.x > 90) {
          boss.x = 90;
          boss.vx = -Math.abs(boss.vx);
        }
        boss.fireCooldown -= dt;
        if (boss.fireCooldown <= 0) {
          boss.fireCooldown = 800 + Math.random() * 600;
          // 3-shot spread
          for (let i = -1; i <= 1; i++) {
            enemyBulletsRef.current.push({
              id: newId(idRef),
              x: boss.x + i * 1.5,
              y: boss.y + 3,
              vx: i * 6,
            });
          }
        }
        // bullets vs boss
        const remaining: Bullet[] = [];
        for (const b of bulletsRef.current) {
          if (Math.abs(b.x - boss.x) < 5 && Math.abs(b.y - boss.y) < 4) {
            boss.hp -= 1;
            burstsRef.current.push({ id: newId(idRef), x: b.x, y: b.y, startedAt: now });
            emitParticles(particlesRef.current, idRef, b.x, b.y, "#ff5a8a", 3, 14, 400);
            if (!b.pierce) continue;
          }
          remaining.push(b);
        }
        bulletsRef.current = remaining;
        if (boss.hp <= 0) {
          sfx.bigBoom();
          shakeUntilRef.current = now + 350;
          hitStopUntilRef.current = now + HIT_STOP_MS;
          emitParticles(particlesRef.current, idRef, boss.x, boss.y, "#ff5a8a", 30, 28, 900);
          burstsRef.current.push({
            id: newId(idRef),
            x: boss.x,
            y: boss.y,
            startedAt: now,
            big: true,
          });
          setScore((s) => s + 500 * lvl);
          floatsRef.current.push({
            id: newId(idRef),
            x: boss.x,
            y: boss.y,
            text: `BOSS +${500 * lvl}`,
            startedAt: now,
            color: "#ff5a8a",
          });
          countersRef.current.bossKills += 1;
          saveCounters(countersRef.current);
          if (countersRef.current.bossKills >= 5) unlock("boss_slayer");
          bossRef.current = null;
          // Advance level after boss
          const nextLvl = lvl + 1;
          levelRef.current = nextLvl;
          setLevel(nextLvl);
          if (nextLvl >= 10) unlock("inbox_zero");
          enemiesRef.current = spawnWave(nextLvl, rngRef.current);
          formationXRef.current = 10;
          formationYRef.current = FORMATION_TOP;
          marchDirRef.current = 1;
          marchSpeedRef.current = Math.min(30, 6 + nextLvl * 1.8);
          tookHitThisWaveRef.current = false;
        }
      }

      // ---- Regular formation march & wave clear ----
      if (!bossRef.current) {
        const bounds = formationBounds(
          enemiesRef.current,
          formationXRef.current,
          formationYRef.current,
        );
        if (!bounds.anyAlive) {
          if (!tookHitThisWaveRef.current && lvl >= 1) unlock("pacifist_wave");
          const nextLvl = lvl + 1;
          levelRef.current = nextLvl;
          setLevel(nextLvl);
          setScore((s) => s + 50);
          if (nextLvl >= 10) unlock("inbox_zero");
          // Boss every BOSS_LEVEL_INTERVAL
          if (nextLvl % BOSS_LEVEL_INTERVAL === 0) {
            bossRef.current = spawnBoss(nextLvl);
            enemiesRef.current = [];
          } else {
            enemiesRef.current = spawnWave(nextLvl, rngRef.current);
          }
          formationXRef.current = 10;
          formationYRef.current = FORMATION_TOP;
          marchDirRef.current = 1;
          marchSpeedRef.current = Math.min(30, 6 + nextLvl * 1.8);
          bulletsRef.current = [];
          enemyBulletsRef.current = [];
          tookHitThisWaveRef.current = false;
        } else {
          const dir = marchDirRef.current;
          let nextX =
            formationXRef.current + dir * marchSpeedRef.current * dts * slowMul * diff.speedMul;
          const nextBounds = formationBounds(enemiesRef.current, nextX, formationYRef.current);
          if (nextBounds.minX - ENEMY_HALF_W < 2 || nextBounds.maxX + ENEMY_HALF_W > 98) {
            marchDirRef.current = dir === 1 ? -1 : 1;
            formationYRef.current += 3 + Math.min(lvl, 5);
            marchSpeedRef.current = Math.min(30, marchSpeedRef.current * 1.12);
            if (nextBounds.minX - ENEMY_HALF_W < 2)
              nextX = formationXRef.current + (2 + ENEMY_HALF_W - nextBounds.minX);
            if (nextBounds.maxX + ENEMY_HALF_W > 98)
              nextX = formationXRef.current - (nextBounds.maxX - (98 - ENEMY_HALF_W));
          }
          formationXRef.current = nextX;
        }
      }

      // Phishing zig-zag (per-enemy x offset)
      for (const e of enemiesRef.current) {
        if (e.kind === "phishing") e.zig += dts * 2;
      }

      // ---- Enemy firing ----
      const liveEnemies = enemiesRef.current.filter((e) => e.alive);
      if (liveEnemies.length > 0) {
        const fireChance = Math.min(2.5, 0.35 + lvl * 0.18) * dts * diff.fireMul * slowMul;
        // urgent enemies double their chance
        const urgentBoost = liveEnemies.some((e) => e.kind === "urgent") ? 1.4 : 1;
        if (Math.random() < fireChance * urgentBoost) {
          const shooter = liveEnemies[Math.floor(Math.random() * liveEnemies.length)];
          const ex =
            formationXRef.current +
            shooter.col * COL_GAP +
            (shooter.kind === "phishing" ? Math.sin(shooter.zig) * 2 : 0);
          const ey = formationYRef.current + shooter.row * ROW_GAP;
          enemyBulletsRef.current.push({ id: newId(idRef), x: ex, y: ey + 2 });
        }
      }

      const eBulletSpeed = Math.min(70, ENEMY_BULLET_BASE + lvl * 3) * diff.bulletMul * slowMul;
      {
        const arr = enemyBulletsRef.current;
        let w = 0;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i];
          b.x += (b.vx ?? 0) * dts;
          b.y += eBulletSpeed * dts;
          if (b.y < FIELD_H + 2) arr[w++] = b;
        }
        arr.length = w;
        if (arr.length > MAX_ENEMY_BULLETS) arr.splice(0, arr.length - MAX_ENEMY_BULLETS);
      }

      // ---- UFO ----
      if (!ufoRef.current && now >= nextUfoAtRef.current) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        ufoRef.current = {
          id: newId(idRef),
          x: dir === 1 ? -4 : 104,
          y: 7,
          vx: dir * 28,
          value: 100 + Math.floor(Math.random() * 3) * 100,
        };
        sfx.ufo();
      }
      if (ufoRef.current) {
        const u = ufoRef.current;
        u.x += u.vx * dts;
        if (u.x < -8 || u.x > 108) {
          ufoRef.current = null;
          nextUfoAtRef.current =
            now + UFO_MIN_INTERVAL_MS + Math.random() * (UFO_MAX_INTERVAL_MS - UFO_MIN_INTERVAL_MS);
        }
      }
      // bullets vs UFO
      if (ufoRef.current) {
        const u = ufoRef.current;
        const remaining: Bullet[] = [];
        let killed = false;
        for (const b of bulletsRef.current) {
          if (!killed && Math.abs(b.x - u.x) < 3.5 && Math.abs(b.y - u.y) < 1.8) {
            killed = true;
            setScore((s) => s + u.value);
            sfx.bigBoom();
            hitStopUntilRef.current = now + 40;
            shakeUntilRef.current = now + 150;
            burstsRef.current.push({ id: newId(idRef), x: u.x, y: u.y, startedAt: now, big: true });
            emitParticles(particlesRef.current, idRef, u.x, u.y, "#ffe066", 16, 22, 700);
            floatsRef.current.push({
              id: newId(idRef),
              x: u.x,
              y: u.y,
              text: `VIP +${u.value}`,
              startedAt: now,
              color: "#ffe066",
            });
            countersRef.current.ufoKills += 1;
            saveCounters(countersRef.current);
            if (countersRef.current.ufoKills >= 10) unlock("ufo_hunter");
            if (!b.pierce) continue;
          }
          remaining.push(b);
        }
        bulletsRef.current = remaining;
        if (killed) {
          ufoRef.current = null;
          nextUfoAtRef.current =
            now + UFO_MIN_INTERVAL_MS + Math.random() * (UFO_MAX_INTERVAL_MS - UFO_MIN_INTERVAL_MS);
        }
      }

      // ---- Player bullets vs enemies + bunkers ----
      const remainingBullets: Bullet[] = [];
      for (const b of bulletsRef.current) {
        // bunkers (only when traveling up across BUNKER_Y band)
        let blocked = false;
        for (const bunker of bunkersRef.current) {
          if (hitBunker(bunker, b.x, b.y)) {
            blocked = true;
            burstsRef.current.push({ id: newId(idRef), x: b.x, y: b.y, startedAt: now });
            break;
          }
        }
        if (blocked && !b.pierce) continue;

        let hit = false;
        for (const e of enemiesRef.current) {
          if (!e.alive) continue;
          const offset = e.kind === "phishing" ? Math.sin(e.zig) * 2 : 0;
          const ex = formationXRef.current + e.col * COL_GAP + offset;
          const ey = formationYRef.current + e.row * ROW_GAP;
          if (Math.abs(b.x - ex) < ENEMY_HALF_W && Math.abs(b.y - ey) < ENEMY_HALF_H) {
            e.hp -= 1;
            e.hitUntil = now + 90;
            hit = true;
            if (e.hp <= 0) {
              e.alive = false;
              handleEnemyKill(e, ex, ey, now);
            } else {
              sfx.pew();
            }
            if (!b.pierce) break;
            hit = false; // pierce continues
          }
        }
        if (!hit) remainingBullets.push(b);
      }
      bulletsRef.current = remainingBullets;

      // ---- Powerups fall + pickup ----
      const newPowerups: Powerup[] = [];
      const isInvuln = now < invulnUntilRef.current;
      for (const p of powerupsRef.current) {
        const ny = p.y + POWERUP_FALL * dts;
        if (ny > PLAYER_Y + 6) continue;
        if (Math.abs(p.x - px) < PLAYER_HALF_W + 2 && Math.abs(ny - PLAYER_Y) < 3) {
          applyPowerup(p.kind, now);
          continue;
        }
        newPowerups.push({ ...p, y: ny });
      }
      powerupsRef.current = newPowerups;

      // ---- Enemy bullets vs player and bunkers ----
      const safeBullets: Bullet[] = [];
      for (const b of enemyBulletsRef.current) {
        // bunker block
        let blocked = false;
        for (const bunker of bunkersRef.current) {
          if (hitBunker(bunker, b.x, b.y)) {
            blocked = true;
            burstsRef.current.push({ id: newId(idRef), x: b.x, y: b.y, startedAt: now });
            break;
          }
        }
        if (blocked) continue;
        if (!isInvuln && Math.abs(b.x - px) < PLAYER_HALF_W && Math.abs(b.y - PLAYER_Y) < 3.5) {
          burstsRef.current.push({ id: newId(idRef), x: px, y: PLAYER_Y, startedAt: now });
          emitParticles(particlesRef.current, idRef, px, PLAYER_Y, "#ff8a3d", 12, 20, 600);
          sfx.boom();
          shakeUntilRef.current = now + 220;
          invulnUntilRef.current = now + INVULN_MS;
          comboRef.current = 0;
          setCombo(0);
          tookHitThisWaveRef.current = true;
          setLives((l) => {
            const nl = l - 1;
            if (nl <= 0) setPhase("over");
            return nl;
          });
        } else {
          safeBullets.push(b);
        }
      }
      enemyBulletsRef.current = safeBullets;

      // Formation bottoming out = game over
      if (!bossRef.current) {
        const b2 = formationBounds(
          enemiesRef.current,
          formationXRef.current,
          formationYRef.current,
        );
        if (b2.anyAlive && b2.maxY >= PLAYER_Y - 4) setPhase("over");
      }

      // Cleanup bursts / particles / floats (in-place)
      {
        const a = burstsRef.current;
        let w = 0;
        for (let i = 0; i < a.length; i++) if (now - a[i].startedAt < BURST_MS) a[w++] = a[i];
        a.length = w;
        if (a.length > MAX_BURSTS) a.splice(0, a.length - MAX_BURSTS);
      }
      {
        const a = particlesRef.current;
        let w = 0;
        for (let i = 0; i < a.length; i++) {
          const p = a[i];
          p.x += p.vx * dts;
          p.y += p.vy * dts;
          p.life += dt;
          if (p.life < p.ttl) a[w++] = p;
        }
        a.length = w;
      }
      {
        const a = floatsRef.current;
        let w = 0;
        for (let i = 0; i < a.length; i++) {
          const f = a[i];
          f.y -= 8 * dts;
          if (now - f.startedAt < 900) a[w++] = f;
        }
        a.length = w;
        if (a.length > MAX_FLOATS) a.splice(0, a.length - MAX_FLOATS);
      }

      notify();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [applyPowerup, handleEnemyKill, sfx, unlock, notify]);

  // ---------- Game-over: finalize run for submission ----------
  useEffect(() => {
    if (phase === "over") {
      const duration = performance.now() - startedAtRef.current;
      if (settingsRef.current.dailyMode) unlock("daily_warrior");
      finishedRunRef.current = {
        score,
        level: levelRef.current,
        kills: killsRef.current,
        maxCombo: maxComboRef.current,
        durationMs: Math.round(duration),
        dailySeed: dailySeedRef.current,
        achievements: [...newAchRunRef.current],
      };
    }
    if (phase === "playing") {
      finishedRunRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const consumeFinishedRun = useCallback(() => {
    const r = finishedRunRef.current;
    finishedRunRef.current = null;
    return r;
  }, []);

  const state: GameState = {
    phase,
    score,
    combo,
    maxCombo,
    kills,
    level,
    lives,
    activeBuff,
    shieldUntil: shieldUntilRef.current,
    hitStopUntil: hitStopUntilRef.current,
    shakeUntil: shakeUntilRef.current,
    bullets: bulletsRef.current,
    enemyBullets: enemyBulletsRef.current,
    enemies: enemiesRef.current,
    boss: bossRef.current,
    ufo: ufoRef.current,
    bunkers: bunkersRef.current,
    bursts: burstsRef.current,
    particles: particlesRef.current,
    powerups: powerupsRef.current,
    floats: floatsRef.current,
    formationX: formationXRef.current,
    formationY: formationYRef.current,
    playerX: playerXRef.current,
    startedAt: startedAtRef.current,
    durationMs: phase === "over" ? performance.now() - startedAtRef.current : 0,
    newAchievements,
  };

  const getLive = useCallback<() => LiveGame>(
    () => ({
      bullets: bulletsRef.current,
      enemyBullets: enemyBulletsRef.current,
      enemies: enemiesRef.current,
      boss: bossRef.current,
      ufo: ufoRef.current,
      bunkers: bunkersRef.current,
      bursts: burstsRef.current,
      particles: particlesRef.current,
      powerups: powerupsRef.current,
      floats: floatsRef.current,
      formationX: formationXRef.current,
      formationY: formationYRef.current,
      playerX: playerXRef.current,
      shieldUntil: shieldUntilRef.current,
      shakeUntil: shakeUntilRef.current,
      invulnUntil: invulnUntilRef.current,
    }),
    [],
  );

  return {
    state,
    settings,
    setSettings,
    setKey,
    start,
    togglePause,
    restart,
    containerRef,
    consumeFinishedRun,
    getLive,
    subscribe,
  };
}
