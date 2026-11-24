// 엑셀 업로드: 직원, 자산, 주변기기 재고.
//
// 방식
//  - 미리보기와 실제 반영은 같은 코드를 탄다. 한 트랜잭션에서 모든 행을 실제로 처리해 보고,
//    미리보기이거나 오류가 한 건이라도 있으면 전부 되돌린다(전부 아니면 전무). 그래서 미리보기 결과와 반영 결과가 같다.
//  - 행 하나하나는 화면에서 등록할 때와 같은 함수(createAsset, createPerson, receiveStock …)로 처리한다.
//    권한·부서 범위·제한 필드·중복 규칙·이력·감사 로그가 그대로 적용된다.
//  - 없는 부서·카테고리·모델은 자동으로 만든다. 단, 올린 사람이 그 기준 정보의 등록 권한을 갖고 있을 때만.
//  - 이미 있는 자산 태그·사번은 오류로 처리한다(기존 자료를 덮어쓰지 않는다).
import type { Db } from '@/lib/db/context';
import { actOnAsset, createAsset } from '@/lib/assets/assets';
import { writeAudit } from '@/lib/auth/audit';
import { actorPermissions, lockCompanyAdministration, permKey } from '@/lib/authz/grants';
import { loadDataAccess, type DataAccess } from '@/lib/authz/scope';
import { HttpError } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { createCategory } from '@/lib/master/categories';
import { lockMasterData } from '@/lib/master/common';
import { createDepartment } from '@/lib/master/departments';
import { createModel } from '@/lib/master/models';
import { createPerson } from '@/lib/master/persons';
import { MAX_QTY, receiveStock } from '@/lib/peripherals/peripherals';
import { hasNul, isIsoDate } from '@/lib/validation';
import { serialToIsoDate, type Cell } from './xlsx';

export type ImportKind = 'persons' | 'assets' | 'peripherals';

interface Column {
  key: string;
  header: string;
  required?: boolean;
  type: 'text' | 'date' | 'number' | 'integer';
  max?: number;
  hint: string;
}

export const IMPORT_COLUMNS: Record<ImportKind, Column[]> = {
  persons: [
    { key: 'employeeNo', header: '사번', type: 'text', max: 50, hint: '있으면 기업 안에서 고유해야 합니다.' },
    { key: 'name', header: '이름', required: true, type: 'text', max: 100, hint: '필수' },
    { key: 'department', header: '부서', type: 'text', max: 80, hint: '없는 부서는 자동으로 만듭니다(부서 등록 권한 필요).' },
    { key: 'email', header: '이메일', type: 'text', max: 200, hint: '선택' },
  ],
  assets: [
    { key: 'assetTag', header: '자산태그', required: true, type: 'text', max: 64, hint: '필수. 기업 안에서 고유합니다.' },
    { key: 'category', header: '카테고리', required: true, type: 'text', max: 80, hint: '필수. 예: 노트북' },
    { key: 'manufacturer', header: '제조사', required: true, type: 'text', max: 80, hint: '필수. 예: Lenovo' },
    { key: 'model', header: '모델명', required: true, type: 'text', max: 120, hint: '필수. 예: ThinkPad X1' },
    { key: 'serialNumber', header: '시리얼번호', type: 'text', max: 100, hint: '같은 모델 안에서 고유합니다.' },
    { key: 'department', header: '관리부서', type: 'text', max: 80, hint: '비우면 기본 부서(IT).' },
    { key: 'location', header: '위치', type: 'text', max: 200, hint: '자유 입력' },
    { key: 'holderEmployeeNo', header: '보유자사번', type: 'text', max: 50, hint: '적으면 그 직원에게 배정된 상태로 등록합니다. 직원을 먼저 올려야 합니다.' },
    { key: 'purchaseDate', header: '구매일', type: 'date', hint: 'YYYY-MM-DD' },
    { key: 'purchasePrice', header: '구매가', type: 'number', hint: '숫자만. 입력 권한이 있어야 합니다.' },
    { key: 'supplier', header: '공급업체', type: 'text', max: 200, hint: '입력 권한이 있어야 합니다.' },
    { key: 'warrantyEnd', header: '보증만료일', type: 'date', hint: 'YYYY-MM-DD' },
  ],
  peripherals: [
    { key: 'category', header: '카테고리', required: true, type: 'text', max: 80, hint: '필수. 예: 마우스' },
    { key: 'manufacturer', header: '제조사', required: true, type: 'text', max: 80, hint: '필수' },
    { key: 'model', header: '모델명', required: true, type: 'text', max: 120, hint: '필수' },
    { key: 'department', header: '관리부서', type: 'text', max: 80, hint: '비우면 기본 부서(IT).' },
    { key: 'qty', header: '수량', required: true, type: 'integer', hint: '필수. 1 이상의 정수. 현재 보유 수량에 더해집니다.' },
  ],
};

/** 업로드에 필요한 권한(라우트 선언과 같아야 한다). 주변기기 업로드는 입고와 같은 일이므로 입고 권한을 쓴다. */
export const IMPORT_RESOURCE: Record<ImportKind, string> = { persons: 'master.person', assets: 'asset.item', peripherals: 'peripheral.receive' };

export const IMPORT_TITLES: Record<ImportKind, string> = { persons: '직원', assets: '자산', peripherals: '주변기기' };

export interface RowError {
  /** 엑셀의 행 번호(머리글이 1행) */
  row: number;
  message: string;
}

export interface ImportResult {
  kind: ImportKind;
  committed: boolean;
  totalRows: number;
  errors: RowError[];
  /** 자동으로 만든(미리보기에서는 만들게 될) 기준 정보 */
  created: { departments: string[]; categories: string[]; models: string[] };
}

type Values = Record<string, string | number | null>;

const headerKey = (v: Cell) => String(v ?? '').replace(/[\s*]/g, '').toLowerCase();

/** 머리글을 읽어 열 위치를 정하고, 자료 행을 값 객체로 바꾼다. 형식 오류는 행 오류로 모은다. */
function parseRows(kind: ImportKind, sheet: Cell[][], errors: RowError[]): { row: number; values: Values }[] {
  const columns = IMPORT_COLUMNS[kind];
  const header = sheet[0] ?? [];
  const position = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    if (!key) return;
    const col = columns.find((c) => headerKey(c.header) === key);
    if (!col) errors.push({ row: 1, message: `알 수 없는 열입니다: ${String(cell).slice(0, 40)}` });
    else if (position.has(col.key)) errors.push({ row: 1, message: `열이 중복되었습니다: ${col.header}` });
    else position.set(col.key, index);
  });
  for (const col of columns) if (col.required && !position.has(col.key)) errors.push({ row: 1, message: `필수 열이 없습니다: ${col.header}` });
  if (errors.length) return [];

  const out: { row: number; values: Values }[] = [];
  sheet.slice(1).forEach((cells, i) => {
    const row = i + 2;
    if (!cells || cells.every((c) => c === null || c === undefined)) return; // 빈 행
    const values: Values = {};
    let bad = false;
    const fail = (message: string) => {
      errors.push({ row, message });
      bad = true;
    };
    for (const col of columns) {
      const index = position.get(col.key);
      const raw = index === undefined ? null : (cells[index] ?? null);
      if (raw === null) {
        if (col.required) fail(`${col.header}: 필수 항목입니다.`);
        values[col.key] = null;
        continue;
      }
      if (col.type === 'text') {
        // 엑셀이 숫자로 저장한 사번·태그(예: 1001)는 글자로 바꾼다.
        const text = (typeof raw === 'number' ? String(raw) : typeof raw === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : raw).trim();
        if (hasNul(text)) fail(`${col.header}: 사용할 수 없는 문자가 들어 있습니다.`);
        else if (col.max && text.length > col.max) fail(`${col.header}: 너무 깁니다. (최대 ${col.max}자)`);
        values[col.key] = text;
      } else if (col.type === 'date') {
        const iso = typeof raw === 'number' ? serialToIsoDate(raw) : typeof raw === 'string' ? raw.trim().replace(/[./]/g, '-').replace(/-(\d)(?=-|$)/g, '-0$1') : null;
        if (!isIsoDate(iso)) fail(`${col.header}: 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)`);
        values[col.key] = iso;
      } else {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/,/g, '').trim()) : NaN;
        if (!Number.isFinite(n)) fail(`${col.header}: 숫자가 아닙니다.`);
        else if (col.type === 'integer' && !Number.isInteger(n)) fail(`${col.header}: 정수여야 합니다.`);
        values[col.key] = n;
      }
    }
    if (!bad) out.push({ row, values });
  });
  return out;
}

/** 이름으로 기준 정보를 찾고, 없으면(권한이 있을 때) 만든다. 한 업로드 안에서는 한 번만 조회·생성한다. */
class MasterData {
  private departments = new Map<string, string>();
  private categories = new Map<string, { id: string; kind: string }>();
  private models = new Map<string, { id: string; kind: string }>();
  readonly created = { departments: [] as string[], categories: [] as string[], models: [] as string[] };

  constructor(
    private db: Db,
    private actor: Actor,
    private perms: Set<string> | null,
  ) {}

  private can(resource: string): boolean {
    return this.perms === null || this.perms.has(permKey(resource, 'create'));
  }

  async department(name: string): Promise<string> {
    const key = name.toLowerCase();
    const cached = this.departments.get(key);
    if (cached) return cached;
    const found = await this.db.query<{ id: string }>('SELECT id FROM app.department WHERE company_id = $1 AND lower(name) = lower($2)', [this.actor.companyId, name]);
    let id = found.rows[0]?.id;
    if (!id) {
      if (!this.can('master.department')) throw new HttpError(403, 'FORBIDDEN', `없는 부서입니다: ${name} (부서 등록 권한이 없어 자동으로 만들 수 없습니다)`);
      id = await createDepartment(this.db, this.actor, { name });
      this.created.departments.push(name);
    }
    this.departments.set(key, id);
    return id;
  }

  async model(kind: 'ASSET' | 'PERIPHERAL', categoryName: string, manufacturer: string, name: string): Promise<string> {
    const label = `${manufacturer} ${name}`;
    const modelKey = `${manufacturer.toLowerCase()}\u0000${name.toLowerCase()}`;
    const kindName = kind === 'ASSET' ? '자산' : '주변기기';
    let model = this.models.get(modelKey);
    if (!model) {
      const found = await this.db.query<{ id: string; kind: string }>(
        'SELECT id, kind FROM app.item_model WHERE company_id = $1 AND lower(manufacturer) = lower($2) AND lower(name) = lower($3)',
        [this.actor.companyId, manufacturer, name],
      );
      model = found.rows[0];
    }
    if (model) {
      if (model.kind !== kind) throw new HttpError(400, 'BAD_REQUEST', `${label}: ${kindName}용 모델이 아닙니다.`);
      this.models.set(modelKey, model);
      return model.id; // 이미 있는 모델은 엑셀의 카테고리와 달라도 기존 분류를 따른다.
    }

    const categoryKey = categoryName.toLowerCase();
    let category = this.categories.get(categoryKey);
    if (!category) {
      const found = await this.db.query<{ id: string; kind: string }>(
        'SELECT id, kind FROM app.category WHERE company_id = $1 AND lower(name) = lower($2)',
        [this.actor.companyId, categoryName],
      );
      category = found.rows[0];
      if (!category) {
        if (!this.can('master.category')) throw new HttpError(403, 'FORBIDDEN', `없는 카테고리입니다: ${categoryName} (카테고리 등록 권한이 없어 자동으로 만들 수 없습니다)`);
        category = { id: await createCategory(this.db, this.actor, { kind, name: categoryName }), kind };
        this.created.categories.push(categoryName);
      }
      this.categories.set(categoryKey, category);
    }
    if (category.kind !== kind) throw new HttpError(400, 'BAD_REQUEST', `${categoryName}: ${kindName}용 카테고리가 아닙니다.`);
    if (!this.can('master.model')) throw new HttpError(403, 'FORBIDDEN', `없는 모델입니다: ${label} (모델 등록 권한이 없어 자동으로 만들 수 없습니다)`);
    model = { id: await createModel(this.db, this.actor, { categoryId: category.id, manufacturer, name }), kind };
    this.created.models.push(label);
    this.models.set(modelKey, model);
    return model.id;
  }
}

const text = (v: string | number | null | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);

async function importRow(db: Db, actor: Actor, access: DataAccess, master: MasterData, kind: ImportKind, v: Values): Promise<void> {
  const department = text(v.department);
  if (kind === 'persons') {
    await createPerson(db, actor, {
      employeeNo: text(v.employeeNo),
      name: v.name as string,
      departmentId: department ? await master.department(department) : null,
      email: text(v.email),
    });
    return;
  }
  const departmentId = department ? await master.department(department) : null;
  if (kind === 'peripherals') {
    const qty = v.qty as number;
    if (qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'BAD_REQUEST', '수량: 1 이상이어야 합니다.');
    const modelId = await master.model('PERIPHERAL', v.category as string, v.manufacturer as string, v.model as string);
    await receiveStock(db, actor, access, { modelId, departmentId, qty, initial: true, note: '엑셀 업로드' });
    return;
  }
  const price = v.purchasePrice as number | null;
  if (price !== null && (price < 0 || price > 999999999999)) throw new HttpError(400, 'BAD_REQUEST', '구매가: 범위를 벗어났습니다.');
  // 보유자는 등록 전에 확인한다(배정 권한도 함께).
  let holderId: string | null = null;
  const holderNo = text(v.holderEmployeeNo);
  if (holderNo) {
    const person = await db.query<{ id: string }>('SELECT id FROM app.person WHERE company_id = $1 AND lower(employee_no) = lower($2)', [actor.companyId, holderNo]);
    holderId = person.rows[0]?.id ?? null;
    if (!holderId) throw new HttpError(400, 'BAD_REQUEST', `보유자사번: 등록되지 않은 사번입니다 (${holderNo}). 직원을 먼저 올려 주세요.`);
  }
  const modelId = await master.model('ASSET', v.category as string, v.manufacturer as string, v.model as string);
  const supplier = text(v.supplier);
  const assetId = await createAsset(db, actor, access, {
    modelId,
    assetTag: v.assetTag as string,
    serialNumber: text(v.serialNumber),
    departmentId,
    location: text(v.location),
    purchaseDate: text(v.purchaseDate),
    // 값이 없으면 키를 넣지 않는다(제한 필드 권한이 없는 사람도 그 열을 비워 두면 올릴 수 있게).
    ...(price !== null ? { purchasePrice: price } : {}),
    ...(supplier !== null ? { supplier } : {}),
    warrantyEnd: text(v.warrantyEnd),
  });
  if (holderId) await actOnAsset(db, actor, access, assetId, 'ASSIGN', { holderPersonId: holderId, note: '엑셀 업로드' });
}

/** 되돌리기 위한 신호. 쿼리 오류가 아니다. */
class RollbackImport extends Error {}

const MAX_REPORTED_ERRORS = 200;

/**
 * 업로드를 실행한다. commit 이 false(미리보기)이거나 오류가 있으면 아무것도 남기지 않는다.
 * tenant 는 라우트 핸들러가 받은 것을 그대로 넘긴다.
 */
export async function runImport(
  tenant: <T>(fn: (db: Db) => Promise<T>) => Promise<T>,
  actor: Actor,
  kind: ImportKind,
  sheet: Cell[][],
  options: { commit: boolean },
): Promise<ImportResult> {
  const errors: RowError[] = [];
  const rows = parseRows(kind, sheet, errors);
  const result: ImportResult = { kind, committed: false, totalRows: rows.length, errors, created: { departments: [], categories: [], models: [] } };
  if (errors.length) {
    result.errors = errors.slice(0, MAX_REPORTED_ERRORS);
    return result;
  }
  if (rows.length === 0) {
    errors.push({ row: 2, message: '올릴 자료가 없습니다.' });
    return result;
  }

  try {
    await tenant(async (db) => {
      // 기준 정보를 만들 수 있으므로 두 잠금을 항상 같은 순서로 먼저 잡는다(교착 방지). 같은 기업의 업로드는 한 번에 하나씩 처리된다.
      await lockCompanyAdministration(db, actor.companyId);
      await lockMasterData(db, actor.companyId);
      const access = await loadDataAccess(db, actor);
      const perms = await actorPermissions(db, actor);
      if (kind === 'assets' && perms !== null && !perms.has(permKey('asset.assign', 'execute')) && rows.some((r) => r.values.holderEmployeeNo)) {
        errors.push({ row: 1, message: '보유자사번을 적으려면 자산 배정 권한이 필요합니다. 그 열을 비우고 올리거나 권한을 요청하세요.' });
        throw new RollbackImport();
      }
      const master = new MasterData(db, actor, perms);
      for (const { row, values } of rows) {
        try {
          await importRow(db, actor, access, master, kind, values);
        } catch (err) {
          // 업무 규칙 위반(HttpError)만 행 오류로 모은다. 쿼리 오류는 그대로 던져 전체를 실패시킨다.
          if (!(err instanceof HttpError)) throw err;
          errors.push({ row, message: err.message });
          if (errors.length >= MAX_REPORTED_ERRORS) break;
        }
      }
      result.created = master.created;
      if (errors.length > 0 || !options.commit) throw new RollbackImport();
      await writeAudit(db, {
        companyId: actor.companyId, actorId: actor.userId, action: 'IMPORT_COMMITTED', resource: IMPORT_RESOURCE[kind],
        after: { rows: rows.length, created: master.created }, ip: actor.auditIp,
      });
      result.committed = true;
    });
  } catch (err) {
    if (!(err instanceof RollbackImport)) throw err;
  }
  return result;
}
