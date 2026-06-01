// Pure logic, types, constants, and helpers for the Invader game.
// Stays free of React / DOM / Supabase so it can be unit-tested.

export type EnemyKind = "newsletter" | "urgent" | "attachment" | "phishing";
export type PowerupKind = "rapid" | "multi" | "shield" | "life" | "pierce" | "bomb" | "slow";
export type BuffKind = "rapid" | "multi" | "pierce" | "slow";
export type Difficulty = "easy" | "normal" | "hard";

export type Bullet = {
  id: number;
  x: number;
  y: number;
  vx?: number;
  pierce?: boolean;
  hits?: number;
};
export type Enemy = {
  id: number;
  col: number;
  row: number;
  kind: EnemyKind;
  hp: number;
  alive: boolean;
  hitUntil: number;
  // phishing zig-zag offset
  zig: number;
};
export type Boss = {
  id: number;
  x: number;
  y: number;
  vx: number;
  hp: number;
  maxHp: number;
  fireCooldown: number;
};
export type Ufo = { id: number; x: number; y: number; vx: number; value: number };
export type Bunker = { id: number; x: number; y: number; cells: boolean[][] }; // cells[row][col]
export type Burst = { id: number; x: number; y: number; startedAt: number; big?: boolean };
export type Particle = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  color: string;
};
export type Powerup = { id: number; x: number; y: number; kind: PowerupKind };
export type ActiveBuff = { kind: BuffKind; expiresAt: number };
export type FloatText = {
  id: number;
  x: number;
  y: number;
  text: string;
  startedAt: number;
  color: string;
};

// ---------------- Constants ----------------
export const FIELD_H = 100;
export const PLAYER_Y = 90;
export const PLAYER_SPEED = 58;
export const BULLET_SPEED = 110;
export const ENEMY_BULLET_BASE = 38;
export const BURST_MS = 600;
export const BASE_COOLDOWN = 180;
export const RAPID_COOLDOWN = 80;
export const POWERUP_DURATION = 8000;
export const SHIELD_DURATION = 6000;
export const SLOW_DURATION = 8000;
export const PIERCE_DURATION = 8000;
export const FORMATION_TOP = 14;
export const ROW_GAP = 6.5;
export const COL_GAP = 8.5;
export const ENEMY_HALF_W = 2.7;
export const ENEMY_HALF_H = 1.8;
export const PLAYER_HALF_W = 3.2;
export const INVULN_MS = 900;
export const POWERUP_FALL = 22;
export const POWERUP_DROP_CHANCE = 0.14;
export const COMBO_WINDOW_MS = 2200;
export const HIT_STOP_MS = 70;
export const UFO_MIN_INTERVAL_MS = 14_000;
export const UFO_MAX_INTERVAL_MS = 28_000;
export const BOSS_LEVEL_INTERVAL = 5;
export const BUNKER_Y = 78;
export const BUNKER_COLS = 5;
export const BUNKER_ROWS = 3;
export const BUNKER_CELL = 0.9; // svg units

export const POWERUP_COLORS: Record<PowerupKind, string> = {
  rapid: "#ff8a3d",
  multi: "#67ffb8",
  shield: "#7cc4ff",
  life: "#ffb74d",
  pierce: "#ffe066",
  bomb: "#ff5a8a",
  slow: "#a78bfa",
};

export const POWERUP_LABEL: Record<PowerupKind, string> = {
  rapid: "R",
  multi: "M",
  shield: "S",
  life: "+",
  pierce: "P",
  bomb: "B",
  slow: "~",
};

export const POWERUP_NAME: Record<PowerupKind, string> = {
  rapid: "BULK ARCHIVE",
  multi: "FILTER SPREAD",
  shield: "SNOOZE",
  life: "INBOX BOOST",
  pierce: "SUPER FILTER",
  bomb: "MARK ALL READ",
  slow: "DELAY DELIVERY",
};

export const ENEMY_COLORS: Record<EnemyKind, { body: string; accent: string; stamp: string }> = {
  newsletter: { body: "#131826", accent: "#ff8a3d", stamp: "#ff5a2e" },
  urgent: { body: "#3a0d12", accent: "#ff3b5c", stamp: "#ffd400" },
  attachment: { body: "#0d2330", accent: "#7cc4ff", stamp: "#67ffb8" },
  phishing: { body: "#2a0d35", accent: "#a78bfa", stamp: "#ff5a8a" },
};

export const ENEMY_HP: Record<EnemyKind, number> = {
  newsletter: 1,
  urgent: 1,
  attachment: 2,
  phishing: 1,
};

export const ENEMY_BASE_POINTS: Record<EnemyKind, number> = {
  newsletter: 10,
  urgent: 15,
  attachment: 20,
  phishing: 25,
};

export const DIFFICULTY: Record<
  Difficulty,
  { fireMul: number; speedMul: number; bulletMul: number; label: string }
> = {
  easy: { fireMul: 0.65, speedMul: 0.85, bulletMul: 0.85, label: "EASY" },
  normal: { fireMul: 1, speedMul: 1, bulletMul: 1, label: "NORMAL" },
  hard: { fireMul: 1.35, speedMul: 1.15, bulletMul: 1.2, label: "HARD" },
};

// ---------------- Seeded RNG (mulberry32) ----------------
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function todaySeedString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------- Spawning ----------------
export function pickEnemyKind(level: number, row: number, rand: Rng): EnemyKind {
  const r = rand();
  // Higher rows tend to be tougher, scaling with level.
  if (row === 0 && level >= 3 && r < 0.35) return "attachment";
  if (level >= 2 && r < 0.18) return "phishing";
  if (level >= 2 && r < 0.4) return "urgent";
  if (level >= 4 && r < 0.55) return "attachment";
  return "newsletter";
}

export function spawnWave(level: number, rand: Rng): Enemy[] {
  const rows = Math.min(5, 3 + Math.floor(level / 2));
  const cols = Math.min(8, 5 + Math.floor(level / 3));
  const enemies: Enemy[] = [];
  let id = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = pickEnemyKind(level, r, rand);
      enemies.push({
        id: id++,
        col: c,
        row: r,
        kind,
        hp: ENEMY_HP[kind],
        alive: true,
        hitUntil: 0,
        zig: rand() * Math.PI * 2,
      });
    }
  }
  return enemies;
}

export function spawnBoss(level: number): Boss {
  const tier = Math.floor(level / BOSS_LEVEL_INTERVAL);
  const hp = 25 + tier * 15;
  return { id: 1, x: 50, y: 18, vx: 18, hp, maxHp: hp, fireCooldown: 800 };
}

export function spawnBunkers(): Bunker[] {
  const xs = [20, 50, 80];
  return xs.map((x, i) => {
    const cells: boolean[][] = [];
    for (let r = 0; r < BUNKER_ROWS; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < BUNKER_COLS; c++) {
        // top-corner notch to look like classic bunker
        const isCorner = r === 0 && (c === 0 || c === BUNKER_COLS - 1);
        const isArch = r === BUNKER_ROWS - 1 && c >= 1 && c <= BUNKER_COLS - 2;
        row.push(!isCorner && !isArch);
      }
      cells.push(row);
    }
    return { id: i + 1, x, y: BUNKER_Y, cells };
  });
}

export function pickPowerupKind(rand: Rng): PowerupKind {
  const r = rand();
  // Weighted distribution; rare bomb/pierce
  if (r < 0.22) return "rapid";
  if (r < 0.42) return "multi";
  if (r < 0.55) return "shield";
  if (r < 0.66) return "life";
  if (r < 0.78) return "pierce";
  if (r < 0.92) return "slow";
  return "bomb";
}

export function formationBounds(enemies: Enemy[], originX: number, originY: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const x = originX + e.col * COL_GAP;
    const y = originY + e.row * ROW_GAP;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, maxY, anyAlive: minX !== Infinity };
}

// Bunker hit test — returns true if a cell was destroyed at that point.
export function hitBunker(b: Bunker, px: number, py: number): boolean {
  const totalW = BUNKER_COLS * BUNKER_CELL;
  const totalH = BUNKER_ROWS * BUNKER_CELL;
  const left = b.x - totalW / 2;
  const top = b.y - totalH / 2;
  if (px < left || px > left + totalW || py < top || py > top + totalH) return false;
  const c = Math.floor((px - left) / BUNKER_CELL);
  const r = Math.floor((py - top) / BUNKER_CELL);
  if (r < 0 || r >= BUNKER_ROWS || c < 0 || c >= BUNKER_COLS) return false;
  if (!b.cells[r][c]) return false;
  b.cells[r][c] = false;
  return true;
}

export function enemyPoints(kind: EnemyKind, level: number, combo: number): number {
  return ENEMY_BASE_POINTS[kind] * level * Math.max(1, combo);
}
