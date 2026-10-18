/** Two letters for a guild's rail tile: the first letter of its first two words. */
export function guildInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const [first, second] = words;
  return (first && second ? `${first[0]}${second[0]}` : name.slice(0, 2)).toUpperCase();
}
