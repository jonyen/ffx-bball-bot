const IN_EMOJI = new Set(['basketball', '+1', 'white_check_mark']);
const OUT_EMOJI = new Set(['x', '-1', 'nope']);

export function categorize(reactions, botUserId) {
  const byUser = new Map();

  for (const { name, users } of reactions) {
    const slot = IN_EMOJI.has(name) ? 'in' : OUT_EMOJI.has(name) ? 'out' : 'maybe';
    for (const user of users) {
      if (user === botUserId) continue;
      const current = byUser.get(user);
      if (!current) {
        byUser.set(user, slot);
        continue;
      }
      if (current === 'in') continue;
      if (current === 'out' && slot === 'in') byUser.set(user, 'in');
      if (current === 'maybe' && (slot === 'in' || slot === 'out')) {
        byUser.set(user, slot);
      }
    }
  }

  const result = { in: [], out: [], maybe: [] };
  for (const [user, slot] of byUser) result[slot].push(user);
  return result;
}
