import { TestBed } from '@angular/core/testing';

import { ItemId } from '~/tests/item-id';
import { TestModule } from '~/tests/test-module';

import { GroupsStore } from './groups-store';

describe('GroupsStore', () => {
  let service: GroupsStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TestModule] });
    service = TestBed.inject(GroupsStore);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('add', () => {
    it('should add a group and return its id', () => {
      const id = service.add([ItemId.IronPlate], 'Plates');

      expect(id).toEqual('1');
      expect(service.state()).toEqual({
        '1': { id: '1', name: 'Plates', rootItemIds: [ItemId.IronPlate] },
      });
    });

    it('should leave the name unset when none is passed', () => {
      service.add([ItemId.IronPlate]);

      expect(service.state()['1']).toEqual({
        id: '1',
        rootItemIds: [ItemId.IronPlate],
      });
    });

    it('should pick the first unused id', () => {
      service.add([ItemId.IronPlate]);
      const id = service.add([ItemId.CopperPlate]);

      expect(id).toEqual('2');
    });

    it('should take a root item away from the group which had it', () => {
      service.add([ItemId.IronPlate, ItemId.CopperPlate]);
      service.add([ItemId.CopperPlate]);

      expect(service.state()['1'].rootItemIds).toEqual([ItemId.IronPlate]);
      expect(service.state()['2'].rootItemIds).toEqual([ItemId.CopperPlate]);
    });

    it('should remove a group which loses its last root item', () => {
      service.add([ItemId.IronPlate]);
      service.add([ItemId.IronPlate]);

      expect(service.state()['1']).toBeUndefined();
      expect(service.state()['2'].rootItemIds).toEqual([ItemId.IronPlate]);
    });
  });

  describe('groups', () => {
    it('should sort groups by id and skip any without roots', () => {
      service.add([ItemId.IronPlate]);
      service.add([ItemId.CopperPlate]);
      service.updateRecord('1', { rootItemIds: [] });

      expect(service.groups().map((g) => g.id)).toEqual(['2']);
    });
  });

  describe('groupIdByItemId', () => {
    it('should map each root item to its group', () => {
      service.add([ItemId.IronPlate]);
      service.add([ItemId.CopperPlate]);

      expect(service.groupIdByItemId()).toEqual({
        [ItemId.IronPlate]: '1',
        [ItemId.CopperPlate]: '2',
      });
    });
  });

  describe('remove', () => {
    it('should remove a group', () => {
      service.add([ItemId.IronPlate]);
      service.remove('1');

      expect(service.state()).toEqual({});
    });
  });

  describe('setName', () => {
    it('should set a name', () => {
      service.add([ItemId.IronPlate]);
      service.setName('1', ' Plates ');

      expect(service.state()['1'].name).toEqual('Plates');
    });

    it('should unset a name which is empty', () => {
      service.add([ItemId.IronPlate], 'Plates');
      service.setName('1', '  ');

      expect(service.state()['1'].name).toBeUndefined();
    });
  });

  describe('addRoot', () => {
    it('should add a root item', () => {
      service.add([ItemId.IronPlate]);
      service.addRoot('1', ItemId.CopperPlate);

      expect(service.state()['1'].rootItemIds).toEqual([
        ItemId.IronPlate,
        ItemId.CopperPlate,
      ]);
    });

    it('should take the root item away from the group which had it', () => {
      service.add([ItemId.IronPlate, ItemId.CopperPlate]);
      service.add([ItemId.SteelChest]);
      service.addRoot('2', ItemId.CopperPlate);

      expect(service.state()['1'].rootItemIds).toEqual([ItemId.IronPlate]);
      expect(service.state()['2'].rootItemIds).toEqual([
        ItemId.SteelChest,
        ItemId.CopperPlate,
      ]);
    });

    it('should ignore a root item the group already has', () => {
      service.add([ItemId.IronPlate]);
      service.addRoot('1', ItemId.IronPlate);

      expect(service.state()['1'].rootItemIds).toEqual([ItemId.IronPlate]);
    });

    it('should ignore an unknown group', () => {
      service.addRoot('1', ItemId.IronPlate);

      expect(service.state()).toEqual({});
    });
  });

  describe('removeRoot', () => {
    it('should remove a root item', () => {
      service.add([ItemId.IronPlate, ItemId.CopperPlate]);
      service.removeRoot('1', ItemId.IronPlate);

      expect(service.state()['1'].rootItemIds).toEqual([ItemId.CopperPlate]);
    });

    it('should remove the group along with its last root item', () => {
      service.add([ItemId.IronPlate]);
      service.removeRoot('1', ItemId.IronPlate);

      expect(service.state()).toEqual({});
    });

    it('should ignore an unknown group', () => {
      service.removeRoot('1', ItemId.IronPlate);

      expect(service.state()).toEqual({});
    });
  });
});
