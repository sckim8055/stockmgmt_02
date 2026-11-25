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
import type { AssetAction } from '@/lib/assets/transitions';
import { deferEvaluation, flushEvaluation } from '@/lib/alerts/thresholds';
import { writeAudit } from '@/lib/auth/audit';
import { actorPermissions, lockCompanyAdministration, permKey } from '@/lib/authz/grants';
import { loadDataAccess, type DataAccess } from '@/lib/authz/scope';
import { HttpError } from '@/lib/http/errors';
import type { Actor } from '@/lib/http/route';
import { createCategory } from '@/lib/master/categories';
import { lockMasterData } from '@/lib/master/common';
import { listCustomFields, type CustomDataType } from '@/lib/master/custom-fields';
import { createDepartment } from '@/lib/master/departments';
import { createModel } from '@/lib/master/models';
import { createPerson } from '@/lib/master/persons';
import { MAX_QTY, receiveStock } from '@/lib/peripherals/peripherals';
import { EMAIL_RE, hasControl, hasNul, isIsoDate } from '@/lib/validation';
import { serialToIsoDate, type Cell } from './xlsx';

export type ImportKind = 'persons' | 'assets' | 'peripherals';

interface Column {
  key: string;
  header: string;
  required?: boolean;
  type: 'text' | 'date' | 'number' | 'integer' | 'boolean';
  max?: number;
  /** 줄바꿈을 받는 자유 입력 칸 */
  multiline?: boolean;
  /** 화면 API 와 같은 형식 규칙 */
  pattern?: { re: RegExp; message: string };
  hint: string;
}

export const IMPORT_COLUMNS: Record<ImportKind, Column[]> = {
  persons: [
    { key: 'employeeNo', header: '사번', type: 'text', max: 40, hint: '있으면 기업 안에서 고유해야 합니다. 0으로 시작하는 사번은 셀 서식을 "텍스트"로 바꾼 뒤 입력하세요.' },
    { key: 'name', header: '이름', required: true, type: 'text', max: 100, hint: '필수' },
    { key: 'department', header: '부서', type: 'text', max: 80, hint: '없는 부서는 자동으로 만듭니다(부서 등록 권한 필요).' },
    { key: 'email', header: '이메일', type: 'text', max: 200, pattern: { re: EMAIL_RE, message: '이메일 형식이 올바르지 않습니다.' }, hint: '선택' },
  ],
  assets: [
    { key: 'assetTag', header: '자산태그', required: true, type: 'text', max: 64, hint: '필수. 기업 안에서 고유합니다.' },
    { key: 'category', header: '카테고리', required: true, type: 'text', max: 80, hint: '필수. 예: 노트북' },
    { key: 'manufacturer', header: '제조사', required: true, type: 'text', max: 100, hint: '필수. 예: Lenovo' },
    { key: 'model', header: '모델명', required: true, type: 'text', max: 100, hint: '필수. 예: ThinkPad X1' },
    { key: 'serialNumber', header: '시리얼번호', type: 'text', max: 100, hint: '같은 모델 안에서 고유합니다.' },
    { key: 'department', header: '관리부서', type: 'text', max: 80, hint: '비우면 기본 부서(IT).' },
    { key: 'location', header: '위치', type: 'text', max: 200, multiline: true, hint: '자유 입력' },
    { key: 'holderEmployeeNo', header: '보유자사번', type: 'text', max: 40, hint: '적으면 그 직원에게 배정된 상태로 등록합니다. 직원을 먼저 올려야 합니다.' },
    { key: 'purchaseDate', header: '구매일', type: 'date', hint: 'YYYY-MM-DD' },
    { key: 'purchasePrice', header: '구매가', type: 'number', hint: '숫자만. 입력 권한이 있어야 합니다.' },
    { key: 'supplier', header: '공급업체', type: 'text', max: 200, hint: '입력 권한이 있어야 합니다.' },
    { key: 'warrantyEnd', header: '보증만료일', type: 'date', hint: 'YYYY-MM-DD' },
    { key: 'status', header: '상태', type: 'text', max: 20, hint: '비우면 재고(보유자사번이 있으면 사용중). 재고·사용중·불량·수리중·분실·퇴역·폐기·매각·기증 중 하나. 등록한 뒤 그 상태로 바꾸며 이력이 남습니다. 불량·퇴역·폐기·매각·기증은 보유자사번과 함께 쓸 수 없습니다.' },
  ],
  peripherals: [
    { key: 'category', header: '카테고리', required: true, type: 'text', max: 80, hint: '필수. 예: 마우스' },
    { key: 'manufacturer', header: '제조사', required: true, type: 'text', max: 100, hint: '필수' },
    { key: 'model', header: '모델명', required: true, type: 'text', max: 100, hint: '필수' },
    { key: 'department', header: '관리부서', type: 'text', max: 80, hint: '비우면 기본 부서(IT).' },
    { key: 'qty', header: '수량', required: true, type: 'integer', hint: '필수. 1 이상의 정수. 현재 보유 수량에 더해집니다.' },
  ],
};

/** 업로드에 필요한 권한(라우트 선언과 같아야 한다). 주변기기 업로드는 입고와 같은 일이므로 입고 권한을 쓴다. */
export const IMPORT_RESOURCE: Record<ImportKind, string> = { persons: 'master.person', assets: 'asset.item', peripherals: 'peripheral.receive' };

/** 업로드 권한에 더해 필요한 등록(create) 권한. 주변기기는 입고 권한이 곧 등록 권한이다. */
const IMPORT_CREATE_RESOURCE: Record<ImportKind, string | null> = { persons: 'master.person', assets: 'asset.item', peripherals: null };

export const IMPORT_TITLES: Record<ImportKind, string> = { persons: '직원', assets: '자산', peripherals: '주변기기' };

/**
 * 자산 업로드의 "상태" 열. 등록(재고) 뒤에 화면에서 하는 것과 같은 처리를 차례로 적용한다.
 * 그래서 상태 전이 규칙·권한·이력이 그대로 적용된다(상태를 직접 써넣지 않는다).
 */
interface StatusPlan {
  /** 보유자가 필요하다 / 있으면 안 된다 / 상관없다 */
  holder: 'required' | 'forbidden' | 'any';
  steps: { action: AssetAction; disposal?: 'DISPOSED' | 'SOLD' | 'DONATED' }[];
}
const STATUS_PLANS: Record<string, StatusPlan> = {
  재고: { holder: 'forbidden', steps: [] },
  사용중: { holder: 'required', steps: [] },
  불량: { holder: 'forbidden', steps: [{ action: 'MARK_DEFECTIVE' }] },
  수리중: { holder: 'any', steps: [{ action: 'REPAIR_IN' }] },
  분실: { holder: 'any', steps: [{ action: 'MARK_MISSING' }] },
  퇴역: { holder: 'forbidden', steps: [{ action: 'RETIRE' }] },
  폐기: { holder: 'forbidden', steps: [{ action: 'RETIRE' }, { action: 'DISPOSE', disposal: 'DISPOSED' }] },
  매각: { holder: 'forbidden', steps: [{ action: 'RETIRE' }, { action: 'DISPOSE', disposal: 'SOLD' }] },
  기증: { holder: 'forbidden', steps: [{ action: 'RETIRE' }, { action: 'DISPOSE', disposal: 'DONATED' }] },
};
const STATUS_ALIASES: Record<string, string> = {
  in_stock: '재고', instock: '재고', in_use: '사용중', inuse: '사용중', defective: '불량', maintenance: '수리중',
  missing: '분실', retired: '퇴역', disposed: '폐기', sold: '매각', donated: '기증',
};
function statusPlan(value: string | null): { name: string; plan: StatusPlan } | null {
  if (!value) return null;
  const key = value.replace(/\s/g, '').toLowerCase();
  const name = STATUS_ALIASES[key] ?? key;
  const plan = STATUS_PLANS[name];
  if (!plan) throw new HttpError(400, 'BAD_REQUEST', `상태: 알 수 없는 값입니다 (${value.slice(0, 20)}). ${Object.keys(STATUS_PLANS).join('·')} 중 하나를 적으세요.`);
  return { name, plan };
}
/** 상태 처리에 필요한 권한 리소스(화면에서 그 처리를 할 때와 같다). */
const STATUS_STEP_RESOURCE: Partial<Record<AssetAction, string>> = {
  MARK_DEFECTIVE: 'asset.maintain', REPAIR_IN: 'asset.maintain', MARK_MISSING: 'asset.retire', RETIRE: 'asset.retire', DISPOSE: 'asset.retire',
};

/** 사용자 지정 필드 열. 머리글은 필드의 표시 이름 또는 키. 값 키는 `custom:<key>`. */
const CUSTOM_PREFIX = 'custom:';
export interface CustomColumnDef {
  key: string;
  label: string;
  data_type: CustomDataType;
}
function customColumns(defs: CustomColumnDef[]): (Column & { alt: string })[] {
  return defs.map((d) => ({
    key: CUSTOM_PREFIX + d.key,
    header: d.label,
    alt: d.key,
    type: d.data_type === 'text' ? 'text' : d.data_type === 'number' ? 'number' : d.data_type,
    max: 500,
    multiline: d.data_type === 'text',
    hint: '사용자 지정 필드',
  }));
}

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

type Values = Record<string, string | number | boolean | null>;

const headerKey = (v: Cell) => String(v ?? '').replace(/[\s*]/g, '').toLowerCase();

/** 머리글을 읽어 열 위치를 정하고, 자료 행을 값 객체로 바꾼다. 형식 오류는 행 오류로 모은다. */
function parseRows(kind: ImportKind, sheet: Cell[][], errors: RowError[], customDefs: CustomColumnDef[] = []): { row: number; values: Values }[] {
  // 기본 열이 먼저다. 사용자 지정 필드의 이름이 기본 열과 같으면 기본 열로 읽는다.
  const extra = customColumns(customDefs);
  const columns: Column[] = [...IMPORT_COLUMNS[kind], ...extra];
  const header = sheet[0] ?? [];
  const position = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    if (!key) return;
    const col = columns.find((c) => headerKey(c.header) === key) ?? extra.find((c) => headerKey(c.alt) === key);
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
        // 15자리를 넘는 숫자는 엑셀이 저장할 때 이미 값이 바뀌어 있다. 엉뚱한 사번·태그로 들어가지 않게 거부한다.
        if (typeof raw === 'number' && (text.includes('e') || !Number.isSafeInteger(Math.trunc(raw)))) fail(`${col.header}: 숫자가 너무 큽니다. 셀 서식을 "텍스트"로 바꾼 뒤 다시 입력하세요.`);
        // 이름·코드류는 한 줄이어야 한다. 자유 입력 칸(위치)은 화면 API 와 같이 줄바꿈을 받는다.
        else if (col.multiline ? hasNul(text) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) : hasControl(text)) fail(`${col.header}: 줄바꿈이나 제어 문자는 쓸 수 없습니다.`);
        else if (col.max && text.length > col.max) fail(`${col.header}: 너무 깁니다. (최대 ${col.max}자)`);
        else if (col.pattern && !col.pattern.re.test(text)) fail(`${col.header}: ${col.pattern.message}`);
        values[col.key] = text;
      } else if (col.type === 'date') {
        const iso = typeof raw === 'number' ? serialToIsoDate(raw) : typeof raw === 'string' ? raw.trim().replace(/[./]/g, '-').replace(/-(\d)(?=-|$)/g, '-0$1') : null;
        if (!isIsoDate(iso)) fail(`${col.header}: 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)`);
        values[col.key] = iso;
      } else if (col.type === 'boolean') {
        const word = String(raw).trim().toLowerCase();
        const yes = ['true', 'y', 'yes', '예', 'o', '1'].includes(word);
        if (!yes && !['false', 'n', 'no', '아니오', 'x', '0'].includes(word)) fail(`${col.header}: 예/아니오(Y/N)로 적으세요.`);
        values[col.key] = yes;
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

const text = (v: string | number | boolean | null | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);

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
    const person = await db.query<{ id: string }>('SELECT id FROM app.person WHERE company_id = $1 AND employee_no_key = lower($2)', [actor.companyId, holderNo]);
    holderId = person.rows[0]?.id ?? null;
    if (!holderId) throw new HttpError(400, 'BAD_REQUEST', `보유자사번: 등록되지 않은 사번입니다 (${holderNo}). 직원을 먼저 올려 주세요.`);
  }
  const status = statusPlan(text(v.status));
  if (status?.plan.holder === 'required' && !holderId) throw new HttpError(400, 'BAD_REQUEST', `상태: ${status.name}은(는) 보유자사번이 있어야 합니다.`);
  if (status?.plan.holder === 'forbidden' && holderId) throw new HttpError(400, 'BAD_REQUEST', `상태: ${status.name}은(는) 보유자사번과 함께 쓸 수 없습니다. 보유자사번을 비우세요.`);
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) if (key.startsWith(CUSTOM_PREFIX) && value !== null) custom[key.slice(CUSTOM_PREFIX.length)] = value;
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
    // 값이 있는 필드만 넣는다(제한 필드 권한이 없는 사람도 그 열을 비워 두면 올릴 수 있게).
    ...(Object.keys(custom).length ? { custom } : {}),
  });
  if (holderId) await actOnAsset(db, actor, access, assetId, 'ASSIGN', { holderPersonId: holderId, note: '엑셀 업로드' });
  for (const step of status?.plan.steps ?? []) {
    await actOnAsset(db, actor, access, assetId, step.action, { note: '엑셀 업로드', ...(step.disposal ? { disposal: step.disposal } : {}) });
  }
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
  // 자산은 그 기업의 사용자 지정 필드를 열로 받는다. 머리글을 읽으려면 정의가 먼저 필요하다.
  const customDefs: CustomColumnDef[] = kind === 'assets'
    ? (await tenant((db) => listCustomFields(db, actor))).filter((d) => d.is_active).map((d) => ({ key: d.key, label: d.label, data_type: d.data_type }))
    : [];
  const rows = parseRows(kind, sheet, errors, customDefs);
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
      // 같은 기업의 업로드는 한 번에 하나만. 기다리지 않고 바로 거절한다(기다리는 요청이 DB 연결을 붙잡고 쌓이지 않게).
      const free = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(727005, hashtext($1)) AS ok', [actor.companyId]);
      if (!free.rows[0]?.ok) throw new HttpError(409, 'IMPORT_BUSY', '이 기업의 다른 업로드가 처리 중입니다. 잠시 후 다시 시도하세요.');
      // 기준 정보를 만들 수 있으므로 두 잠금을 항상 같은 순서로 먼저 잡는다(교착 방지).
      await lockCompanyAdministration(db, actor.companyId);
      await lockMasterData(db, actor.companyId);
      const access = await loadDataAccess(db, actor);
      const perms = await actorPermissions(db, actor);
      // 업로드 권한은 "엑셀로 올릴 수 있다"는 것이고, 무엇을 만들 수 있는지는 등록 권한이 정한다. 둘 다 있어야 한다.
      const createResource = IMPORT_CREATE_RESOURCE[kind];
      if (createResource && perms !== null && !perms.has(permKey(createResource, 'create'))) {
        throw new HttpError(403, 'FORBIDDEN', `${IMPORT_TITLES[kind]} 등록 권한이 없어 엑셀로 올릴 수 없습니다.`);
      }
      if (kind === 'assets' && perms !== null && !perms.has(permKey('asset.assign', 'execute')) && rows.some((r) => r.values.holderEmployeeNo)) {
        errors.push({ row: 1, message: '보유자사번을 적으려면 자산 배정 권한이 필요합니다. 그 열을 비우고 올리거나 권한을 요청하세요.' });
        throw new RollbackImport();
      }
      if (kind === 'assets' && perms !== null) {
        // 상태 열은 화면에서 그 처리를 할 권한이 있어야 쓸 수 있다.
        const needed = new Set<string>();
        for (const r of rows) {
          let plan: StatusPlan | undefined;
          try {
            plan = statusPlan(text(r.values.status))?.plan;
          } catch {
            continue; // 알 수 없는 값은 행 오류로 보고된다.
          }
          for (const step of plan?.steps ?? []) needed.add(STATUS_STEP_RESOURCE[step.action]!);
        }
        for (const resource of needed) {
          if (!perms.has(permKey(resource, 'execute'))) {
            errors.push({ row: 1, message: `상태 열에 적은 처리를 할 권한이 없습니다 (${resource === 'asset.retire' ? '분실·퇴역·폐기' : '불량·수리'}). 그 값을 지우고 올리거나 권한을 요청하세요.` });
            throw new RollbackImport();
          }
        }
      }
      const master = new MasterData(db, actor, perms);
      // 한계 수량 판정은 행마다 하지 않고 끝에 한 번만 한다(행마다 하면 한계 수량 잠금을 업로드 내내 잡게 된다).
      deferEvaluation(db);
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
      await flushEvaluation(db, actor.companyId);
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
