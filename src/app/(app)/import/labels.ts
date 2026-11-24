// 엑셀 업로드 화면의 종류별 정보. 권한은 서버 라우트 선언(src/app/api/import/*/route.ts)과 같다.

export type ImportKind = 'persons' | 'assets' | 'peripherals';

export interface KindInfo {
  title: string;
  /** 업로드·양식 내려받기에 필요한 권한 */
  permission: [resource: string, operation: string];
  /** 반영한 뒤 보러 갈 목록과 그 목록의 조회 권한 */
  list: { href: string; label: string; permission: [resource: string, operation: string] };
  templateFile: string;
  intro: string;
}

export const IMPORT_KINDS: ImportKind[] = ['persons', 'assets', 'peripherals'];

export const KIND_INFO: Record<ImportKind, KindInfo> = {
  persons: {
    title: '직원',
    permission: ['master.person', 'import'],
    list: { href: '/master/persons', label: '직원 목록 보기', permission: ['master.person', 'read'] },
    templateFile: '직원_업로드_양식.xlsx',
    intro: '직원 명부를 한꺼번에 등록합니다. 없는 부서는 자동으로 만듭니다(부서 등록 권한 필요).',
  },
  assets: {
    title: '자산',
    permission: ['asset.item', 'import'],
    list: { href: '/assets', label: '자산 목록 보기', permission: ['asset.item', 'read'] },
    templateFile: '자산_업로드_양식.xlsx',
    intro: '자산을 한꺼번에 등록합니다. 보유자사번을 적으면 그 직원에게 배정된 상태로 등록합니다(자산 배정 권한 필요).',
  },
  peripherals: {
    title: '주변기기',
    permission: ['peripheral.receive', 'execute'],
    list: { href: '/peripherals', label: '주변기기 재고 보기', permission: ['peripheral.stock', 'read'] },
    templateFile: '주변기기_업로드_양식.xlsx',
    intro: '주변기기 재고 수량을 한꺼번에 입고합니다. 수량은 현재 보유 수량에 더해집니다.',
  },
};

/** 서버가 미리보기·반영에 돌려주는 결과(src/lib/import/run.ts 의 ImportResult) */
export interface ImportResult {
  kind: ImportKind;
  committed: boolean;
  totalRows: number;
  errors: { row: number; message: string }[];
  created: { departments: string[]; categories: string[]; models: string[] };
}

/** 오류 응답(반영 422)의 본문이 업로드 결과 형식인지 확인한다. */
export function isImportResult(raw: unknown): raw is ImportResult {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Partial<ImportResult>;
  return typeof r.committed === 'boolean' && typeof r.totalRows === 'number' && Array.isArray(r.errors) && typeof r.created === 'object' && r.created !== null;
}

/** 서버의 파일 크기 한도(src/lib/import/xlsx.ts 의 XLSX_LIMITS.fileBytes)와 같다. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
