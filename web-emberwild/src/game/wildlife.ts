/**
 * Wildlife behavior (Phase 9) — the unified, needs-driven decision layer for
 * wild monsters.
 *
 * Responsibilities are split along the roadmap lines without inventing a heavy
 * AI framework:
 *  - Profiles: species-derived behavioral tendencies (sociality, nest defense,
 *    challenge willingness, injury fear) so strategies come from species data,
 *    never hardcoded per-species conditionals in the decision code.
 *  - Perception: one bounded pass over the bodies the sim already collected
 *    (`near`, everything within the simulation radius) answers every question
 *    the decisions ask — threats, prey, mates, kin, range intruders, brood.
 *  - Decisions: migration (pressure-driven, cooldown-gated, real movement) and
 *    dominance transfer live here; sim.ts executes movement and combat through
 *    its existing machinery, and the authoritative territory, mating, ecology
 *    and reproduction systems keep their roles untouched.
 *
 * Everything is deterministic: decisions read only seeded hashes and state the
 * sim already gathered. No global searches; strategic decisions are staggered.
 */
import { SPECIES, developmentTypeFor } from "./data";
import { canMate } from "./mating";
import { hashString } from "./rng";
import { ensureTerritory, releaseTerritoryOwner, territoryOf } from "./territory";
import type { TerritoryEcology } from "./ecology";
import type { GameState, Nest, Territory, WildCreature } from "./types";

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/* --------------------------------- Profiles ---------------------------------- */

export type Sociality = "pack" | "loose" | "solitary";

export interface BehaviorProfile {
  social: Sociality;
  /** Defends nests and developing offspring. */
  defendsNest: boolean;
  /** May depose a weakened same-species alpha. */
  challenges: boolean;
  /** hpFrac below which the body breaks off and flees. */
  fleeHp: number;
}

/** Named overrides where species data alone misleads (kept minimal). */
const OVERRIDES: Record<string, Partial<BehaviorProfile>> = {
  crystal_golem: { social: "solitary", challenges: false, defendsNest: false },
  ironfang_tyrant: { social: "solitary", challenges: true },
};

const profiles = new Map<string, BehaviorProfile>();

/** Species-derived behavioral profile (cached; species data is the single source). */
export function profileOf(speciesId: string): BehaviorProfile {
  const hit = profiles.get(speciesId);
  if (hit) return hit;
  const sp = SPECIES[speciesId];
  const social: Sociality = sp.family === "Beast" && sp.aggression >= 0.35 ? "pack" : sp.family === "Bug" || sp.family === "Spirit" ? "solitary" : "loose";
  const p: BehaviorProfile = {
    social,
    defendsNest: developmentTypeFor(speciesId, "sexual") === "egg" || social !== "solitary",
    challenges: sp.aggression >= 0.45 && social !== "solitary",
    fleeHp: Math.min(0.32, Math.max(0.08, 0.3 - sp.aggression * 0.2)),
  };
  const out: BehaviorProfile = { ...p, ...OVERRIDES[speciesId] };
  profiles.set(speciesId, out);
  return out;
}

/** Predator/prey rule — the one source both perception and hunting use. A
 *  desperate (starving) predator stretches the rule by one size class and one
 *  level; threat detection always uses the strict rule. */
export function predatesOn(a: WildCreature, b: WildCreature, desperate = false): boolean {
  const sa = SPECIES[a.speciesId];
  const sb = SPECIES[b.speciesId];
  if (a.speciesId === b.speciesId || b.alpha) return false;
  if (sa.diet === "carnivore" || (sa.diet === "omnivore" && a.satiety < 25)) {
    return desperate
      ? sa.size + 1 >= sb.size && a.level + 3 >= b.level
      : sa.size >= sb.size && a.level + 2 >= b.level;
  }
  return false;
}

/* -------------------------------- Perception --------------------------------- */

export interface WildlifePerception {
  /** A predator that can eat this body (nearest first). */
  threat: WildCreature | null;
  /** The best prey this body can hunt. */
  prey: WildCreature | null;
  /** A compatible, ready mate within touching distance. */
  mate: WildCreature | null;
  /** Same-species free-roaming bodies nearby (competition metric). */
  kin: number;
  /** A non-kin body inside this body's territory. */
  intruder: WildCreature | null;
  /** This body's (or its range's) nest with developing young. */
  brood: Nest | null;
  /** A body loitering beside the brood. */
  broodThreat: WildCreature | null;
}

/** One bounded pass over the sim's collected bodies answers every query below. */
export function perceiveWildlife(state: GameState, c: WildCreature, near: WildCreature[], terr: Territory | null, tick: number): WildlifePerception {
  const packmate = (o: WildCreature): boolean => o.pack === c.id || c.pack === o.id || (c.pack !== undefined && o.pack === c.pack);
  let threat: WildCreature | null = null;
  let threatD = 5;
  let prey: WildCreature | null = null;
  let preyD = 7;
  let mate: WildCreature | null = null;
  let kin = 0;
  let intruder: WildCreature | null = null;
  let intruderD = 99;
  for (const o of near) {
    if (o === c || !state.creatures[o.id]) continue;
    const d = cheb(o.x, o.y, c.x, c.y);
    if (d < threatD && predatesOn(o, c) && o.satiety < 50) {
      threat = o;
      threatD = d;
    }
    if (d < preyD && predatesOn(c, o)) {
      prey = o;
      preyD = d;
    }
    if (o.speciesId === c.speciesId && d <= 8 && !o.alpha && !o.pack) kin++;
    if (!mate && c.satiety > 75 && d <= 1 && !o.alpha && !o.pack && o.satiety > 70 && canMate(c, o, "wild", tick).ok) mate = o;
    if (terr && !packmate(o) && d < intruderD && cheb(o.x, o.y, terr.x, terr.y) <= terr.radius) {
      intruder = o;
      intruderD = d;
    }
  }
  // brood: my own nest, else any developing clutch registered to my range
  let brood: Nest | null = null;
  const own = c.repro?.nestId ? state.nests[c.repro.nestId] : null;
  if (own && own.state === "active" && own.developmentIds.some((id) => state.developments[id]?.state === "developing")) brood = own;
  else if (terr) {
    for (const nid of terr.nestIds) {
      const n = state.nests[nid];
      if (n && n.state === "active" && n.developmentIds.some((id) => state.developments[id]?.state === "developing")) {
        brood = n;
        break;
      }
    }
  }
  let broodThreat: WildCreature | null = null;
  if (brood) {
    let bd = 4;
    for (const o of near) {
      if (o === c || !state.creatures[o.id] || packmate(o) || o.speciesId === c.speciesId) continue;
      const d = cheb(o.x, o.y, brood.x, brood.y);
      if (d <= 3 && d < bd) {
        broodThreat = o;
        bd = d;
      }
    }
  }
  return { threat, prey, mate, kin, intruder, brood, broodThreat };
}

/* --------------------------------- Migration ---------------------------------- */

/** Migration pressure a body must see before leaving its range (hysteresis). */
export const MIGRATION_PRESSURE = 0.55;
/** Ticks before the same body may settle again (no oscillation). */
export const MIGRATION_COOLDOWN = 576;
/** Ticks between settlement retries while still inside the old range's gravity. */
export const MIGRATION_RETRY = 48;

export interface MigrationIntent {
  active: boolean;
  tx: number;
  ty: number;
}

/**
 * Decides whether a body strikes out for new grounds. The decision is O(1) —
 * the caller's per-tick assessment cache does the heavy lifting — and
 * cooldown-gated so a settling body never oscillates; movement stays with the
 * sim.
 */
export function migrationIntent(gs: GameState, c: WildCreature, eco: TerritoryEcology | undefined, home: { x: number; y: number }, tick: number): MigrationIntent {
  const none: MigrationIntent = { active: false, tx: 0, ty: 0 };
  if (!eco || c.alpha) return none;
  if (c.migrateUntil !== undefined && tick < c.migrateUntil) return none;
  if (eco.migrationPressure < MIGRATION_PRESSURE) return none;
  const bearing = (hashString(c.id) % 628) / 100;
  return { active: true, tx: Math.round(home.x + Math.cos(bearing) * 22), ty: Math.round(home.y + Math.sin(bearing) * 22) };
}

/**
 * A migrating body that has cleared its old range settles through the Phase 6
 * system — joining a same-species range or founding its own. Returns true when
 * the body's home actually changed; otherwise a short retry cooldown prevents
 * per-tick churn (no abandon/re-enter oscillation).
 */
export function settleMigration(gs: GameState, c: WildCreature, oldTerritoryId: string | undefined, tick: number): boolean {
  delete c.territoryId;
  const t = ensureTerritory(gs, c, { x: c.x, y: c.y });
  if (t.id !== oldTerritoryId) {
    c.migrateUntil = tick + MIGRATION_COOLDOWN;
    return true;
  }
  c.migrateUntil = tick + MIGRATION_RETRY;
  return false;
}

/* --------------------------------- Dominance ---------------------------------- */

/**
 * Dominance transfer after a won challenge: the old alpha loses rank and
 * loyalty, the challenger takes the pack and the range's ownership. Ownership
 * stays with the territory system — this only writes the fields that system
 * already owns.
 */
export function seizeTerritory(gs: GameState, c: WildCreature, alpha: WildCreature, tick: number): void {
  const t = territoryOf(gs, alpha);
  const wasOwner = !!t && t.ownerId === alpha.id;
  releaseTerritoryOwner(gs, alpha.id);
  if (t && wasOwner) {
    t.ownerId = c.id;
    t.contested = false;
  }
  alpha.alpha = false;
  alpha.pack = undefined;
  alpha.disposition = "skittish";
  alpha.calmUntil = tick + 240;
  alpha.stalking = false;
  c.alpha = true;
  c.stalking = false;
  for (const o of Object.values(gs.creatures)) if (o.pack === alpha.id) o.pack = c.id;
}
