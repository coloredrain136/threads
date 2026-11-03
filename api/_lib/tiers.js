// Tiers (threads-16): Building → Shipped → On Hold → Backlog → Archived.
// Old names from before threads-16 still read correctly: active → building, parked → hold.
export const TIERS = ['building', 'shipped', 'hold', 'backlog', 'archived'];
export const normTier = (v) => (v === 'active' ? 'building' : v === 'parked' ? 'hold' : TIERS.includes(v) ? v : 'hold');
