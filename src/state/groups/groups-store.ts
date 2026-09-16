import { computed, Service } from '@angular/core';

import { spread } from '~/utils/object';

import { RecordStore } from '../store';
import { GroupState } from './group-state';

@Service()
export class GroupsStore extends RecordStore<GroupState> {
  /** Groups in stable id order, ignoring any which have lost all root items */
  readonly groups = computed(() => {
    const state = this.state();
    return Object.keys(state)
      .map((id) => state[id])
      .filter((g) => g.rootItemIds.length > 0)
      .sort((a, b) => Number(a.id) - Number(b.id));
  });

  /** Maps each root item to the id of the group which claims it */
  readonly groupIdByItemId = computed(() => {
    const result: Record<string, string> = {};
    for (const group of this.groups())
      for (const itemId of group.rootItemIds) result[itemId] ??= group.id;

    return result;
  });

  /**
   * Adds a group for the passed root items. A root item belongs to at most one
   * group, so it is removed from any group which already claims it.
   */
  add(rootItemIds: string[], name?: string): string {
    const state = this.state();
    let n = 1;
    while (state[n.toString()] != null) n++;
    const id = n.toString();
    const group: GroupState = { id, rootItemIds: [...rootItemIds] };
    if (name != null) group.name = name;

    this.reduce((state) =>
      spread(this._releaseItems(state, rootItemIds), { [id]: group }),
    );
    return id;
  }

  remove(id: string): void {
    this.reduce((state) => this._removeEntry(state, id));
  }

  setName(id: string, name: string | undefined): void {
    if (name != null) name = name.trim();
    this.updateRecordField(id, 'name', name ? name : undefined);
  }

  addRoot(id: string, itemId: string): void {
    this.reduce((state) => {
      const group = state[id];
      if (group == null || group.rootItemIds.includes(itemId)) return state;

      const next = this._releaseItems(state, [itemId]);
      const current = next[id];
      // istanbul ignore next: Group can only be released if it has no roots
      if (current == null) return next;

      return spread(next, {
        [id]: spread(current, {
          rootItemIds: [...current.rootItemIds, itemId],
        }),
      });
    });
  }

  /** Removes a root item, removing the group if it was the last one */
  removeRoot(id: string, itemId: string): void {
    this.reduce((state) => {
      const group = state[id];
      if (group == null) return state;

      const rootItemIds = group.rootItemIds.filter((i) => i !== itemId);
      if (rootItemIds.length === 0) return this._removeEntry(state, id);

      return spread(state, { [id]: spread(group, { rootItemIds }) });
    });
  }

  /** Removes the passed items from any group which claims them */
  private _releaseItems(
    state: Record<string, GroupState>,
    itemIds: string[],
  ): Record<string, GroupState> {
    let next = state;
    for (const group of Object.keys(state).map((id) => state[id])) {
      const rootItemIds = group.rootItemIds.filter((i) => !itemIds.includes(i));
      if (rootItemIds.length === group.rootItemIds.length) continue;

      if (rootItemIds.length === 0) next = this._removeEntry(next, group.id);
      else next = spread(next, { [group.id]: spread(group, { rootItemIds }) });
    }

    return next;
  }
}
