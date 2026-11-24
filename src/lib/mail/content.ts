// 정기 메일의 본문 만들기. tenant() 트랜잭션 안에서 호출한다.
//
//  - 일정에 부서가 정해져 있으면 그 부서의 자료만 담는다. 기업 전체 일정은 전부 담는다.
//  - 구매가·공급업체 같은 제한 필드는 메일에 싣지 않는다(받는 사람의 권한을 따질 수 없으므로).
//  - HTML 에 넣는 모든 값은 이스케이프한다.
import type { Db } from '@/lib/db/context';
import { companyToday } from '@/lib/alerts/today';
import type { ContentType } from './schedules';

type Lang = 'ko' | 'en' | 'zh';
const MAX_ROWS = 200;
// 재고 현황은 수량이 없는 카테고리를 뺀 뒤에 줄 수를 자른다. 그래서 카테고리는 넉넉히 읽는다.
const MAX_CATEGORIES = 2000;

const L = {
  ko: {
    LOW_STOCK: '재고 부족 현황', STOCK_SUMMARY: '재고 현황', OPEN_LOANS: '미반납 대여 현황',
    all: '전체', empty: '해당하는 항목이 없습니다.', more: '일부만 실었습니다. 나머지는 시스템에서 확인하세요.',
    target: '대상', department: '부서', qty: '현재 수량', min: '한계 수량',
    category: '카테고리', kind: '구분', asset: '자산', peripheral: '주변기기', available: '사용 가능', inUse: '사용·대여 중', total: '합계',
    item: '품목', holder: '보유자', due: '반납 기한', overdue: '연체', none: '-',
  },
  en: {
    LOW_STOCK: 'Low stock', STOCK_SUMMARY: 'Stock summary', OPEN_LOANS: 'Open loans',
    all: 'All', empty: 'Nothing to report.', more: 'Only part of the list is shown. See the system for the rest.',
    target: 'Item', department: 'Department', qty: 'Quantity', min: 'Minimum',
    category: 'Category', kind: 'Type', asset: 'Asset', peripheral: 'Peripheral', available: 'Available', inUse: 'In use / on loan', total: 'Total',
    item: 'Item', holder: 'Holder', due: 'Due', overdue: 'Overdue', none: '-',
  },
  zh: {
    LOW_STOCK: '库存不足', STOCK_SUMMARY: '库存概况', OPEN_LOANS: '未归还借用',
    all: '全部', empty: '没有相关项目。', more: '仅显示部分内容，其余请在系统中查看。',
    target: '对象', department: '部门', qty: '当前数量', min: '最低数量',
    category: '类别', kind: '类型', asset: '资产', peripheral: '外设', available: '可用', inUse: '使用/借出中', total: '合计',
    item: '物品', holder: '持有人', due: '归还期限', overdue: '逾期', none: '-',
  },
} as const;

const escapeHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

export interface MailContent {
  subject: string;
  text: string;
  html: string;
  /** 보낼 내용이 없다(일정의 "내용이 없으면 건너뛰기"가 이것을 본다). */
  empty: boolean;
  rows: number;
}

// $1 기업, $2 부서(NULL = 전체), $3 최대 행 수
const SQL_MAIL_LOW_STOCK =
  'SELECT coalesce(c.name, m.manufacturer || chr(32) || m.name) AS target, d.name AS department, t.min_qty,' +
  ' (SELECT count(*)::int FROM app.asset a JOIN app.item_model am ON am.id = a.model_id AND am.company_id = a.company_id' +
  '   WHERE a.company_id = t.company_id AND a.state = $4 AND a.substate = $5 AND (a.model_id = t.model_id OR am.category_id = t.category_id)' +
  '     AND (t.department_id IS NULL OR a.department_id = t.department_id))' +
  ' + (SELECT coalesce(sum(s.on_hand_qty), 0)::int FROM app.peripheral_stock s JOIN app.item_model sm ON sm.id = s.model_id AND sm.company_id = s.company_id' +
  '   WHERE s.company_id = t.company_id AND (s.model_id = t.model_id OR sm.category_id = t.category_id)' +
  '     AND (t.department_id IS NULL OR s.department_id = t.department_id)) AS qty' +
  ' FROM app.stock_threshold t' +
  ' LEFT JOIN app.category c ON c.id = t.category_id AND c.company_id = t.company_id' +
  ' LEFT JOIN app.item_model m ON m.id = t.model_id AND m.company_id = t.company_id' +
  ' LEFT JOIN app.department d ON d.id = t.department_id AND d.company_id = t.company_id' +
  ' WHERE t.company_id = $1 AND t.is_active AND t.state = $6 AND ($2::uuid IS NULL OR t.department_id = $2)' +
  ' ORDER BY 1, 2 NULLS FIRST LIMIT $3';

const SQL_MAIL_SUMMARY =
  'SELECT c.name AS category, c.kind,' +
  ' CASE WHEN c.kind = $4 THEN (SELECT count(*)::int FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  '      WHERE a.company_id = $1 AND m.category_id = c.id AND a.state = $5 AND a.substate = $6 AND ($2::uuid IS NULL OR a.department_id = $2))' +
  '  ELSE (SELECT coalesce(sum(s.on_hand_qty), 0)::int FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  '      WHERE s.company_id = $1 AND m.category_id = c.id AND ($2::uuid IS NULL OR s.department_id = $2)) END AS available,' +
  ' CASE WHEN c.kind = $4 THEN (SELECT count(*)::int FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  '      WHERE a.company_id = $1 AND m.category_id = c.id AND a.state = $7 AND ($2::uuid IS NULL OR a.department_id = $2))' +
  '  ELSE (SELECT coalesce(sum(s.on_loan_qty), 0)::int FROM app.peripheral_stock s JOIN app.item_model m ON m.id = s.model_id AND m.company_id = s.company_id' +
  '      WHERE s.company_id = $1 AND m.category_id = c.id AND ($2::uuid IS NULL OR s.department_id = $2)) END AS in_use' +
  ' FROM app.category c WHERE c.company_id = $1 AND c.is_active ORDER BY c.kind, lower(c.name) LIMIT $3';

const SQL_MAIL_OPEN_LOANS =
  'SELECT x.item, x.holder, x.qty, x.due_date::text AS due_date, x.department, (x.due_date < $6::date) AS overdue FROM (' +
  '  SELECT a.asset_tag || chr(32) || m.manufacturer || chr(32) || m.name AS item, p.name AS holder, 1 AS qty, a.due_date, d.name AS department' +
  '    FROM app.asset a JOIN app.item_model m ON m.id = a.model_id AND m.company_id = a.company_id' +
  '    JOIN app.department d ON d.id = a.department_id AND d.company_id = a.company_id' +
  '    LEFT JOIN app.person p ON p.id = a.holder_person_id AND p.company_id = a.company_id' +
  '   WHERE a.company_id = $1 AND a.state = $4 AND a.due_date IS NOT NULL AND ($2::uuid IS NULL OR a.department_id = $2)' +
  '  UNION ALL' +
  '  SELECT m.manufacturer || chr(32) || m.name, p.name, l.qty - l.returned_qty - l.lost_qty, l.due_date, d.name' +
  '    FROM app.peripheral_loan l JOIN app.peripheral_stock s ON s.id = l.stock_id AND s.company_id = l.company_id' +
  '    JOIN app.item_model m ON m.id = s.model_id AND m.company_id = l.company_id' +
  '    JOIN app.department d ON d.id = s.department_id AND d.company_id = l.company_id' +
  '    JOIN app.person p ON p.id = l.person_id AND p.company_id = l.company_id' +
  '   WHERE l.company_id = $1 AND l.status = $5 AND ($2::uuid IS NULL OR s.department_id = $2)' +
  ') x ORDER BY x.due_date NULLS LAST, x.item LIMIT $3';

function render(title: string, scope: string, headers: string[], rows: (string | number)[][], emptyText: string, moreText: string | null): { text: string; html: string } {
  const lines = [`${title} — ${scope}`, ''];
  if (rows.length === 0) lines.push(emptyText);
  else {
    lines.push(headers.join(' | '));
    for (const r of rows) lines.push(r.join(' | '));
  }
  if (moreText) lines.push('', moreText);
  const cell = (tag: string, v: string | number) => `<${tag} style="border:1px solid #d1d5db;padding:4px 8px;text-align:left">${escapeHtml(v)}</${tag}>`;
  const table = rows.length === 0
    ? `<p>${escapeHtml(emptyText)}</p>`
    : `<table style="border-collapse:collapse;font-size:14px"><thead><tr>${headers.map((h) => cell('th', h)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => cell('td', v)).join('')}</tr>`).join('')}</tbody></table>`;
  const html = `<div style="font-family:sans-serif"><h2 style="font-size:16px">${escapeHtml(title)} — ${escapeHtml(scope)}</h2>${table}${moreText ? `<p>${escapeHtml(moreText)}</p>` : ''}</div>`;
  return { text: lines.join('\n'), html };
}

export async function buildMailContent(
  db: Db,
  companyId: string,
  schedule: { content_type: ContentType; department_id: string | null; lang: Lang },
): Promise<MailContent> {
  const t = L[schedule.lang] ?? L.ko;
  const dept = schedule.department_id
    ? (await db.query<{ name: string }>('SELECT name FROM app.department WHERE id = $1 AND company_id = $2', [schedule.department_id, companyId])).rows[0]?.name ?? t.none
    : t.all;
  const base = [companyId, schedule.department_id, MAX_ROWS + 1];
  let headers: string[];
  let rows: (string | number)[][];
  if (schedule.content_type === 'LOW_STOCK') {
    const r = await db.query<{ target: string; department: string | null; min_qty: number; qty: number }>(SQL_MAIL_LOW_STOCK, [...base, 'IN_STOCK', 'AVAILABLE', 'LOW']);
    headers = [t.target, t.department, t.qty, t.min];
    rows = r.rows.map((x) => [x.target, x.department ?? t.all, x.qty, x.min_qty]);
  } else if (schedule.content_type === 'STOCK_SUMMARY') {
    const r = await db.query<{ category: string; kind: string; available: number; in_use: number }>(SQL_MAIL_SUMMARY, [companyId, schedule.department_id, MAX_CATEGORIES, 'ASSET', 'IN_STOCK', 'AVAILABLE', 'IN_USE']);
    headers = [t.category, t.kind, t.available, t.inUse];
    // 수량이 전혀 없는 카테고리는 뺀다.
    rows = r.rows.filter((x) => x.available + x.in_use > 0).map((x) => [x.category, x.kind === 'ASSET' ? t.asset : t.peripheral, x.available, x.in_use]);
  } else {
    const r = await db.query<{ item: string; holder: string | null; qty: number; due_date: string | null; department: string; overdue: boolean | null }>(SQL_MAIL_OPEN_LOANS, [...base, 'IN_USE', 'OPEN', await companyToday(db, companyId)]);
    headers = [t.item, t.holder, t.qty, t.due, t.department];
    rows = r.rows.map((x) => [x.item, x.holder ?? t.none, x.qty, x.due_date ? (x.overdue ? `${x.due_date} (${t.overdue})` : x.due_date) : t.none, x.department]);
  }
  // 한 건 더 읽어 와서 "더 있는지"만 안다(정확한 수는 세지 않는다).
  const hasMore = rows.length > MAX_ROWS;
  const shown = rows.slice(0, MAX_ROWS);
  const title = t[schedule.content_type];
  const { text, html } = render(title, dept, headers, shown, t.empty, hasMore ? t.more : null);
  // 제목에는 줄바꿈·제어 문자를 넣지 않는다(메일 헤더 끼워 넣기 방지). 이름 입력에서도 막지만 여기서 한 번 더 지운다.
  const subject = `[${title}] ${dept}`.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return { subject, text, html, empty: shown.length === 0, rows: shown.length };
}
