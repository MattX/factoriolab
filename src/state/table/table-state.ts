import { LabParams } from '../router/lab-params';

export interface TableState {
  filter?: string;
  /** Id of the selected group, or undefined for the whole factory */
  group?: string;
  sort?: string;
  asc: boolean;
  page: number;
  rows: number;
}

export const initialTableState: TableState = {
  asc: false,
  page: 0,
  rows: 100,
};

export const resetTableParams: Partial<LabParams> = {
  tfi: undefined,
  tso: undefined,
  tas: undefined,
  tpg: undefined,
  tro: undefined,
  tgr: undefined,
};
