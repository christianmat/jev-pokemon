import gen from '../data/generated.json' with { type: 'json' };

type Gen = {
  maps: Record<string, { name: string; width: number; height: number }>;
  events: Record<string, number>;
  charmap: Record<string, string>;
  sym: Record<string, number>;
};
const G = gen as unknown as Gen;

export const MAPS = G.maps;
export const EVENTS = G.events;
export const CHARMAP = G.charmap;

/** Address of a pokered symbol. WRAM/HRAM = CPU address; ROM = flat file offset. */
export function sym(name: string): number {
  const a = G.sym[name];
  if (a === undefined) throw new Error(`unknown symbol ${name}`);
  return a;
}

export function mapName(id: number): string {
  return MAPS[id]?.name ?? `MAP_${id}`;
}

export function symbols(): Record<string, number> {
  return G.sym;
}
