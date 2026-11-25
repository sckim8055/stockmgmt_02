// 자산 API 응답 형식. 서버(src/lib/assets/assets.ts)가 정한 컬럼을 그대로 옮겼다.
import type { AssetState } from '@/lib/assets/transitions';
import type { Substate } from './labels';

export interface AssetRow {
  id: string;
  asset_tag: string;
  serial_number: string | null;
  state: AssetState;
  substate: Substate | null;
  location: string | null;
  due_date: string | null;
  purchase_date: string | null;
  /** 읽기 권한이 없으면 서버가 키 자체를 뺀다. */
  purchase_price?: number | null;
  /** 읽기 권한이 없으면 서버가 키 자체를 뺀다. */
  supplier?: string | null;
  warranty_end: string | null;
  /** 읽을 수 없는 제한 필드와 비활성 필드는 서버가 뺀다. */
  custom: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  model_id: string;
  manufacturer: string;
  model_name: string;
  category_id: string;
  category_name: string;
  department_id: string;
  department_name: string;
  holder_person_id: string | null;
  holder_name: string | null;
  holder_employee_no: string | null;
}

/** 상태별 건수(상태 조건만 빼고 나머지 조건은 목록과 같다) */
export interface AssetSummary {
  total: number;
  byState: Partial<Record<AssetState, number>>;
  inStock: Partial<Record<Substate, number>>;
}

/** 이 사용자가 볼 수 있는 열. 제한 필드는 읽을 수 없으면 키 자체가 없다. */
export interface AssetListFields {
  supplier?: true;
  purchasePrice?: true;
  custom: { key: string; label: string; data_type: CustomDataType }[];
}

export interface AssetPage {
  total: number;
  page: number;
  pageSize: number;
  items: AssetRow[];
  summary: AssetSummary;
  fields: AssetListFields;
}

export interface HistoryRow {
  id: string;
  type: string;
  from_state: string | null;
  to_state: string | null;
  from_substate: string | null;
  to_substate: string | null;
  from_location: string | null;
  to_location: string | null;
  note: string | null;
  created_at: string;
  from_holder_name: string | null;
  to_holder_name: string | null;
  from_department_name: string | null;
  to_department_name: string | null;
  actor_name: string | null;
}

export interface ModelOption {
  id: string;
  category_id: string;
  category_name: string;
  kind: 'ASSET' | 'PERIPHERAL';
  manufacturer: string;
  name: string;
  is_active: boolean;
}

export interface CategoryOption {
  id: string;
  name: string;
  is_active: boolean;
}

export interface DepartmentOption {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

export type CustomDataType = 'text' | 'number' | 'date' | 'boolean';

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  data_type: CustomDataType;
  is_restricted: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface PersonOption {
  id: string;
  name: string;
  employee_no: string | null;
  department_name: string | null;
  is_active: boolean;
}

/**
 * 서버가 받는 정렬 기준. src/lib/assets/assets.ts 의 ASSET_SORT_KEYS 와 같아야 한다.
 * (assets.ts 는 DB·감사 로그 모듈을 import 하므로 화면에서 직접 가져올 수 없다)
 */
export const SORT_KEYS = [
  'asset_tag', 'state', 'model', 'category', 'manufacturer', 'serial', 'department', 'holder', 'employee_no', 'location',
  'warranty_end', 'purchase_date', 'due_date', 'created_at', 'updated_at', 'purchase_price', 'supplier',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
