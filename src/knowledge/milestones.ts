import type { GameState } from '../game/state.js';

/**
 * Story knowledge: WHAT the next goal is and WHERE it is — nothing about how to press buttons.
 * Completion is verified from real in-game event flags / badges / items, never assumed.
 * The agent (Jev) still decides every action: where to walk, who to talk to, what to answer,
 * how to fight, when to heal/grind/catch.
 */
export interface Milestone {
  id: string;
  goal: string;          // plain-language objective handed to Jev
  maps: string[];        // map(s) where the objective happens
  done: (g: GameState) => boolean;
  level?: number;        // typical level of the toughest opponent here (guide knowledge)
  types?: string[];      // types of the objective's opponents (for team matchup facts)
}

const ev = (name: string) => (g: GameState) => g.event(name);
const badge = (bit: number) => (g: GameState) => !!(g.badges & (1 << bit));
const hasItem = (name: string) => (g: GameState) => g.bag().some((i) => i.name === name);

export const MILESTONES: Milestone[] = [
  { id: 'meet_oak', goal: 'Leave the house and walk north out of Pallet Town toward Route 1; Professor Oak will stop you and bring you to his lab.', maps: ['ROUTE_1'], done: ev('EVENT_FOLLOWED_OAK_INTO_LAB') },
  { id: 'starter', goal: "In Oak's lab, choose a starter Pokémon from the Poké Balls on the table.", maps: ['OAKS_LAB'], done: ev('EVENT_GOT_STARTER') },
  { id: 'rival1', goal: "Battle your rival in Oak's lab (he challenges you as you try to leave).", maps: ['OAKS_LAB'], done: ev('EVENT_BATTLED_RIVAL_IN_OAKS_LAB'), level: 5 },
  { id: 'parcel', goal: "Go north through Route 1 to Viridian City and enter the Poké Mart to receive Oak's Parcel.", maps: ['VIRIDIAN_MART'], done: ev('EVENT_GOT_OAKS_PARCEL'), level: 4 },
  { id: 'deliver_parcel', goal: "Bring Oak's Parcel back to Professor Oak in his lab in Pallet Town and talk to him.", maps: ['OAKS_LAB'], done: ev('EVENT_GOT_POKEDEX') },
  { id: 'viridian_forest', goal: 'Head north from Viridian City through Route 2 and Viridian Forest toward Pewter City.', maps: ['PEWTER_CITY'], done: (g) => g.badges > 0 || visitedPewter(g), level: 9 },
  { id: 'brock', goal: 'Defeat Brock, the Pewter City Gym Leader (Rock/Ground Pokémon, Lv12-14). Water, Grass and Fighting moves are strong against him; Fire and Normal moves are weak against Rock.', maps: ['PEWTER_GYM'], done: badge(0), level: 14, types: ['ROCK','GROUND'] },
  { id: 'mt_moon', goal: 'Travel east from Pewter City along Route 3 and through Mt. Moon to reach Route 4 and Cerulean City.', maps: ['CERULEAN_CITY'], done: (g) => g.badges > 1 || ceruleanReached(g), level: 14 },
  { id: 'misty', goal: 'Defeat Misty, the Cerulean City Gym Leader (Water type). Electric or Grass moves are strong against her; Fire moves are weak against Water. Her team: Staryu Lv18 and Starmie Lv21 (Water/Psychic).', maps: ['CERULEAN_GYM'], done: badge(1), level: 21, types: ['WATER'] },
  { id: 'bill', goal: "Go north across Nugget Bridge (Route 24) and east on Route 25 to Bill's house; help Bill and get the S.S. Ticket.", maps: ['BILLS_HOUSE'], done: ev('EVENT_GOT_SS_TICKET'), level: 20 },
  { id: 'ss_anne', goal: 'Go south from Cerulean through Route 5, the Underground Path and Route 6 to Vermilion City; board the S.S. Anne at the dock and get HM01 (Cut) from the captain.', maps: ['SS_ANNE_CAPTAINS_ROOM'], done: ev('EVENT_GOT_HM01'), level: 22 },
  { id: 'surge', goal: 'Defeat Lt. Surge at the Vermilion City Gym (Electric type; Ground moves are strong). A small tree blocks the gym entrance.', maps: ['VERMILION_GYM'], done: badge(2), level: 24, types: ['ELECTRIC'] },
  { id: 'rock_tunnel', goal: 'Go back to Cerulean, east via Route 9 to Rock Tunnel (Route 10), and through it south to Lavender Town.', maps: ['LAVENDER_TOWN'], done: (g) => g.badges > 3 || lavenderReached(g), level: 26 },
  { id: 'celadon', goal: 'Go west from Lavender Town via Route 8 and the Underground Path to Celadon City.', maps: ['CELADON_CITY'], done: (g) => g.badges > 3 || celadonReached(g), level: 28 },
  { id: 'erika', goal: 'Defeat Erika at the Celadon City Gym (Grass type; Fire, Ice, Flying moves are strong).', maps: ['CELADON_GYM'], done: badge(3), level: 29, types: ['GRASS'] },
  { id: 'rocket_hideout', goal: 'Find the Team Rocket Hideout under the Celadon Game Corner (poster switch), get the Lift Key, and defeat Giovanni to get the Silph Scope.', maps: ['ROCKET_HIDEOUT_B4F'], done: ev('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI'), level: 30 },
  { id: 'pokemon_tower', goal: 'In Lavender Town, climb Pokémon Tower with the Silph Scope, defeat the Marowak ghost and rescue Mr. Fuji at the top.', maps: ['POKEMON_TOWER_7F'], done: ev('EVENT_RESCUED_MR_FUJI'), level: 32 },
  { id: 'poke_flute', goal: "Talk to Mr. Fuji in his house in Lavender Town to receive the Poké Flute.", maps: ['MR_FUJIS_HOUSE'], done: ev('EVENT_GOT_POKE_FLUTE'), level: 32 },
  { id: 'fuchsia', goal: 'Travel to Fuchsia City (via Route 12-15 using the Poké Flute on Snorlax, or Cycling Road via Route 16-18).', maps: ['FUCHSIA_CITY'], done: (g) => g.badges > 4 || fuchsiaReached(g), level: 34 },
  { id: 'koga', goal: 'Defeat Koga at the Fuchsia City Gym (Poison type; Psychic and Ground moves are strong).', maps: ['FUCHSIA_GYM'], done: badge(4), level: 43, types: ['POISON'] },
  { id: 'surf', goal: 'In the Safari Zone (north of Fuchsia), reach the Secret House to get HM03 (Surf); also find the Gold Teeth and give them to the Warden for HM04 (Strength).', maps: ['SAFARI_ZONE_SECRET_HOUSE'], done: ev('EVENT_GOT_HM03'), level: 36 },
  { id: 'strength', goal: 'Give the Gold Teeth to the Safari Zone Warden in Fuchsia City to get HM04 (Strength).', maps: ['WARDENS_HOUSE'], done: ev('EVENT_GOT_HM04'), level: 36 },
  { id: 'silph', goal: 'Enter Silph Co. in Saffron City (give the guard a drink from the Celadon rooftop vending machine to pass), use the Card Key, and defeat Giovanni.', maps: ['SILPH_CO_11F'], done: ev('EVENT_BEAT_SILPH_CO_GIOVANNI'), level: 41 },
  { id: 'sabrina', goal: 'Defeat Sabrina at the Saffron City Gym (Psychic type; Bug moves are strong, teleport pads connect the rooms).', maps: ['SAFFRON_GYM'], done: badge(5), level: 43, types: ['PSYCHIC'] },
  { id: 'cinnabar', goal: 'Surf south from Pallet Town (Route 21) to Cinnabar Island. Explore the Pokémon Mansion to find the Secret Key.', maps: ['POKEMON_MANSION_B1F'], done: hasItem('SECRET KEY'), level: 40 },
  { id: 'blaine', goal: 'Defeat Blaine at the Cinnabar Island Gym (Fire type; Water and Ground moves are strong).', maps: ['CINNABAR_GYM'], done: badge(6), level: 47, types: ['FIRE'] },
  { id: 'giovanni', goal: 'Defeat Giovanni at the Viridian City Gym (Ground type; Water, Grass and Ice moves are strong).', maps: ['VIRIDIAN_GYM'], done: badge(7), level: 50, types: ['GROUND'] },
  { id: 'victory_road', goal: 'Go west from Viridian City along Route 22 and north on Route 23 through the badge gates to Victory Road; push boulders onto switches with Strength to reach Indigo Plateau.', maps: ['INDIGO_PLATEAU_LOBBY'], done: (g) => g.event('EVENT_BEAT_LORELEIS_ROOM_TRAINER_0') || indigoReached(g), level: 48 },
  { id: 'lorelei', goal: 'Elite Four: defeat Lorelei (Ice/Water). Inside the Elite Four the battles are back to back: no Pokémon Center until the end, and healing is only possible with items between and during battles.', maps: ['LORELEIS_ROOM'], done: ev('EVENT_BEAT_LORELEIS_ROOM_TRAINER_0'), level: 56, types: ['ICE','WATER'] },
  { id: 'bruno', goal: 'Elite Four: defeat Bruno (Fighting/Rock). Inside the Elite Four the battles are back to back: no Pokémon Center until the end, and healing is only possible with items between and during battles.', maps: ['BRUNOS_ROOM'], done: ev('EVENT_BEAT_BRUNOS_ROOM_TRAINER_0'), level: 58, types: ['FIGHTING','ROCK'] },
  { id: 'agatha', goal: 'Elite Four: defeat Agatha (Ghost/Poison). Inside the Elite Four the battles are back to back: no Pokémon Center until the end, and healing is only possible with items between and during battles.', maps: ['AGATHAS_ROOM'], done: ev('EVENT_BEAT_AGATHAS_ROOM_TRAINER_0'), level: 60, types: ['GHOST','POISON'] },
  { id: 'lance', goal: 'Elite Four: defeat Lance (Dragon/Flying). Inside the Elite Four the battles are back to back: no Pokémon Center until the end, and healing is only possible with items between and during battles.', maps: ['LANCES_ROOM'], done: ev('EVENT_BEAT_LANCE'), level: 62, types: ['DRAGON','FLYING'] },
  { id: 'champion', goal: 'Defeat your rival, the Champion, and enter the Hall of Fame. This battle directly follows the Elite Four, with no Pokémon Center in between.', maps: ['CHAMPIONS_ROOM'], done: ev('EVENT_BEAT_CHAMPION_RIVAL'), level: 65 },
];

// "Reached" milestones are tracked by the agent's visited-map memory.
const visited = new Set<string>();
export function markVisited(name: string) { visited.add(name); }
export function visitedMaps() { return [...visited]; }
export function restoreVisited(names: string[]) { visited.clear(); names.forEach((n) => visited.add(n)); }
const visitedPewter = (_g?: GameState) => visited.has('PEWTER_CITY');
const ceruleanReached = (_g?: GameState) => visited.has('CERULEAN_CITY');
const lavenderReached = (_g?: GameState) => visited.has('LAVENDER_TOWN');
const celadonReached = (_g?: GameState) => visited.has('CELADON_CITY');
const fuchsiaReached = (_g?: GameState) => visited.has('FUCHSIA_CITY');
const indigoReached = (_g?: GameState) => visited.has('INDIGO_PLATEAU_LOBBY');

export function currentMilestone(g: GameState): { index: number; m: Milestone | null } {
  for (let i = 0; i < MILESTONES.length; i++) if (!MILESTONES[i].done(g)) return { index: i, m: MILESTONES[i] };
  return { index: MILESTONES.length, m: null };
}
