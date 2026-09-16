/**
 * A sub-factory: a named set of "root" items whose entire production is
 * attributed to the group, along with the share of every upstream step which
 * feeds that production.
 */
export interface GroupState {
  id: string;
  /** Optional label, falls back to the name of the first root item */
  name?: string;
  /** Items whose production belongs to this group */
  rootItemIds: string[];
}
