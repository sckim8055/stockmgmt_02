// 엑셀 업로드 화면의 종류별 정보. 권한은 서버 라우트 선언(src/app/api/import/*/route.ts)과 같다.
// 문구는 labels.text.ts 에 있다.
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './labels.text';

export type ImportKind = 'persons' | 'assets' | 'peripherals';
/** 화면의 업로드 선택지: 세 종류 + 통합 파일(직원·자산·주변기기 시트를 한 파일로) */
export type UploadKind = ImportKind | 'workbook';

export interface KindInfo {
  /** 업로드·양식 내려받기에 필요한 권한 */
  permission: [resource: string, operation: string];
  /** 반영한 뒤 보러 갈 목록과 그 목록의 조회 권한 */
  list: { href: string; permission: [resource: string, operation: string] };
}

export const IMPORT_KINDS: ImportKind[] = ['persons', 'assets', 'peripherals'];
export const UPLOAD_KINDS: UploadKind[] = [...IMPORT_KINDS, 'workbook'];

export const KIND_INFO: Record<UploadKind, KindInfo> = {
  persons: { permission: ['master.person', 'import'], list: { href: '/master/persons', permission: ['master.person', 'read'] } },
  assets: { permission: ['asset.item', 'import'], list: { href: '/assets', permission: ['asset.item', 'read'] } },
  peripherals: { permission: ['peripheral.receive', 'execute'], list: { href: '/peripherals', permission: ['peripheral.stock', 'read'] } },
  // 서버(src/app/api/import/workbook/route.ts)가 자산 업로드 권한을 선언하고, 시트마다의 권한은 업로드할 때 따로 확인한다.
  workbook: { permission: ['asset.item', 'import'], list: { href: '/assets', permission: ['asset.item', 'read'] } },
};

/** 종류별 문구(현재 언어): 제목, 목록 링크 이름, 양식 파일 이름, 안내 */
export interface KindText {
  title: string;
  listLabel: string;
  templateFile: string;
  intro: string;
}
// 사전의 키가 종류 코드와 다르면 여기서 타입 오류가 난다.
const KIND_TEXT: Record<Lang, Record<UploadKind, KindText>> = TEXT;

export function useKindText(): Record<UploadKind, KindText> {
  return KIND_TEXT[useLang()];
}

/** 통합 파일 업로드의 시트별 결과(src/lib/import/run.ts 의 WorkbookSheetResult) */
export interface SheetResult {
  kind: ImportKind;
  sheet: string;
  totalRows: number;
  skipped: boolean;
}

/** 서버가 미리보기·반영에 돌려주는 결과(src/lib/import/run.ts 의 ImportResult, WorkbookImportResult) */
export interface ImportResult {
  kind: UploadKind;
  committed: boolean;
  totalRows: number;
  /** sheet 는 통합 파일 업로드에서만 있다(파일 전체에 관한 오류에는 없다). */
  errors: { sheet?: string; row: number; message: string }[];
  created: { departments: string[]; categories: string[]; models: string[] };
  /** 통합 파일 업로드에서만 있다. */
  sheets?: SheetResult[];
}

/** 오류 응답(반영 422)의 본문이 업로드 결과 형식인지 확인한다. */
export function isImportResult(raw: unknown): raw is ImportResult {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Partial<ImportResult>;
  return typeof r.committed === 'boolean' && typeof r.totalRows === 'number' && Array.isArray(r.errors) && typeof r.created === 'object' && r.created !== null;
}

/** 서버의 파일 크기 한도(src/lib/import/xlsx.ts 의 XLSX_LIMITS.fileBytes)와 같다. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
