import type { Difficulty } from "./engine";

const SETTINGS_KEY = "invader.settings.v1";
const ACHIEVEMENTS_KEY = "invader.achievements.v1";
const COUNTERS_KEY = "invader.counters.v1";

export type GameSettings = {
  muted: boolean;
  difficulty: Difficulty;
  dailyMode: boolean;
};

export const DEFAULT_SETTINGS: GameSettings = {
  muted: false,
  difficulty: "normal",
  dailyMode: false,
};

export type AchievementKey =
  | "first_blood"
  | "streak_10"
  | "streak_25"
  | "pacifist_wave"
  | "inbox_zero"
  | "boss_slayer"
  | "ufo_hunter"
  | "daily_warrior";

export type AchievementDef = {
  key: AchievementKey;
  name: string;
  description: string;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: "first_blood", name: "First Blood", description: "Destroy your first email." },
  { key: "streak_10", name: "On A Roll", description: "Reach a 10× combo." },
  { key: "streak_25", name: "Inbox Annihilator", description: "Reach a 25× combo." },
  { key: "pacifist_wave", name: "Untouchable", description: "Clear a wave without taking a hit." },
  { key: "inbox_zero", name: "Inbox Zero", description: "Reach level 10." },
  { key: "boss_slayer", name: "Spam King Slayer", description: "Defeat 5 boss waves (lifetime)." },
  { key: "ufo_hunter", name: "VIP Hunter", description: "Destroy 10 bonus VIPs (lifetime)." },
  { key: "daily_warrior", name: "Daily Drill", description: "Complete a daily challenge run." },
];

export type Counters = {
  bossKills: number;
  ufoKills: number;
};

const DEFAULT_COUNTERS: Counters = { bossKills: 0, ufoKills: 0 };

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export function loadSettings(): GameSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  return safeParse<GameSettings>(window.localStorage.getItem(SETTINGS_KEY), DEFAULT_SETTINGS);
}

export function saveSettings(s: GameSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadAchievements(): Set<AchievementKey> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as AchievementKey[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export function saveAchievements(set: Set<AchievementKey>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify([...set]));
}

export function loadCounters(): Counters {
  if (typeof window === "undefined") return { ...DEFAULT_COUNTERS };
  return safeParse<Counters>(window.localStorage.getItem(COUNTERS_KEY), DEFAULT_COUNTERS);
}

export function saveCounters(c: Counters): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(COUNTERS_KEY, JSON.stringify(c));
}
