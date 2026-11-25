#!/usr/bin/env python3
"""Headless browser smoke test: Part 1 screens (dashboard, stock history, audit log) + ko/en/zh UI.
Run through run.sh (it creates the throwaway DB/role, seeds accounts, starts the server and cleans up)."""
import datetime
import json
import os
import re
import subprocess
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ['SMOKE_BASE']
PW = os.environ['SMOKE_PW']
OWNER_URL = os.environ['OWNER_URL']
S = json.loads(os.environ['SMOKE_SEED'])
HANGUL = re.compile('[ᄀ-ᇿ㄰-㆏가-힯]+')
XSS = '<img src=x onerror=alert(1)>'
# Server-originated Korean that may legitimately appear in an en/zh screen:
#  - '한국어' is the language's own name in the language pickers (endonym, same in every UI language)
#  - role template descriptions are data seeded by db/migrations/0003 (Korean only)
WHITELIST = ['한국어', '조회 전용', '재고 담당: 배정·지급·입고 가능', '재고 관리자: 폐기·보정·기준 정보·한계수량·메일 설정 포함']

passed, failed = [], []
API_HISTORY = []
page_errors = []


def check(name, cond, detail=''):
    (passed if cond else failed).append(name if cond else f'{name} :: {detail}')
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {detail}'), flush=True)


def sql(q):
    subprocess.run(['psql', OWNER_URL, '-qAtc', q], check=True, capture_output=True, text=True)


def day(n):
    return (datetime.date.today() + datetime.timedelta(days=n)).isoformat()


# ───────────────────────── data through the real API (admin of company A) ─────────────────────────
def seed(p):
    api = p.request.new_context(base_url=BASE)
    r = api.post('/api/auth/login', data={'companyCode': 'SMOKEA', 'loginId': 'admin', 'password': PW})
    assert r.ok, r.text()

    def post(path, body):
        r = api.post(path, data=body)
        assert r.ok, (path, r.status, r.text())
        return r.json()

    ids = {}
    ids['catLaptop'] = post('/api/master/categories', {'kind': 'ASSET', 'name': 'Laptop'})['categoryId']
    ids['catMouse'] = post('/api/master/categories', {'kind': 'PERIPHERAL', 'name': 'Mouse'})['categoryId']
    post('/api/master/categories', {'kind': 'ASSET', 'name': XSS})
    ids['laptop'] = post('/api/master/models', {'categoryId': ids['catLaptop'], 'manufacturer': 'Lenovo', 'name': 'X1'})['modelId']
    ids['mouse'] = post('/api/master/models', {'categoryId': ids['catMouse'], 'manufacturer': 'Logi', 'name': 'M1'})['modelId']
    ids['a1'] = post('/api/assets', {'modelId': ids['laptop'], 'assetTag': 'SM-001'})['assetId']
    ids['a2'] = post('/api/assets', {'modelId': ids['laptop'], 'assetTag': 'SM-002'})['assetId']
    ids['a3'] = post('/api/assets', {'modelId': ids['laptop'], 'assetTag': 'SM-003'})['assetId']
    ids['a4'] = post('/api/assets', {'modelId': ids['laptop'], 'assetTag': 'SM-004', 'departmentId': S['hr'], 'warrantyEnd': day(7)})['assetId']
    post(f"/api/assets/{ids['a2']}/assign", {'action': 'ASSIGN', 'holderPersonId': S['kim'], 'note': 'it note'})
    post(f"/api/assets/{ids['a3']}/assign", {'action': 'LOAN', 'holderPersonId': S['lee'], 'dueDate': day(10)})
    sql(f"UPDATE app.asset SET due_date = current_date - 5 WHERE id = '{ids['a3']}'")
    hr_stock = post('/api/peripherals/receive', {'modelId': ids['mouse'], 'departmentId': S['hr'], 'qty': 5})['stockId']
    loan = post('/api/peripherals/issue', {'action': 'LOAN', 'stockId': hr_stock, 'personId': S['kim'], 'qty': 2, 'dueDate': day(10)})['loanId']
    sql(f"UPDATE app.peripheral_loan SET due_date = current_date - 5 WHERE id = '{loan}'")
    it_stock = post('/api/peripherals/receive', {'modelId': ids['mouse'], 'qty': 4})['stockId']
    post('/api/peripherals/issue', {'action': 'ISSUE', 'stockId': it_stock, 'personId': S['lee'], 'qty': 1, 'note': 'it issue'})
    for _ in range(50):  # enough stock-history rows for a second page (page size 50)
        post('/api/peripherals/receive', {'modelId': ids['mouse'], 'qty': 1})
    post('/api/thresholds', {'modelId': ids['mouse'], 'minQty': 100})  # company-wide, LOW
    post('/api/thresholds', {'modelId': ids['mouse'], 'departmentId': S['hr'], 'minQty': 1})  # HR, OK
    global API_HISTORY
    API_HISTORY = api.get('/api/history/stock?pageSize=200').json()['items']
    api.dispose()
    return ids


def new_page(browser, init_script=None):
    ctx = browser.new_context(base_url=BASE, viewport={'width': 1400, 'height': 1000})
    if init_script:
        ctx.add_init_script(init_script)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: page_errors.append(str(e)))
    pg.on('dialog', lambda d: (page_errors.append('unexpected JS dialog: ' + d.message), d.dismiss()))
    return ctx, pg


def login(pg, code, login_id, lang=None):
    pg.goto('/login')
    pg.wait_for_load_state('networkidle')
    if lang:
        pg.select_option('[data-testid=lang-switcher]', lang)
    ins = pg.locator('main input')
    ins.nth(0).fill(code)
    ins.nth(1).fill(login_id)
    ins.nth(2).fill(PW)
    pg.locator('main button').click()
    pg.wait_for_url(BASE + '/')
    pg.wait_for_load_state('networkidle')


def settle(pg, lang=None):
    pg.wait_for_load_state('networkidle')
    if lang:
        pg.wait_for_function(f"document.documentElement.lang === '{lang}'")
    pg.wait_for_timeout(250)


def dl(pg, testid):
    return pg.eval_on_selector(
        f'[data-testid={testid}]',
        "el => Object.fromEntries([...el.querySelectorAll('dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim()]))",
    )


def rows(pg):
    return pg.locator('table tbody tr')


VISIBLE_TEXT_JS = """() => {
  const out = [document.title, document.body.innerText];
  for (const el of document.querySelectorAll('*')) {
    for (const a of ['placeholder', 'aria-label', 'title', 'alt']) { const v = el.getAttribute(a); if (v) out.push(v); }
  }
  for (const o of document.querySelectorAll('option')) out.push(o.textContent);
  return out.join('\\n');
}"""


def no_hangul(pg, label, extra_whitelist=()):
    text = pg.evaluate(VISIBLE_TEXT_JS)
    for w in list(WHITELIST) + list(extra_whitelist):
        text = text.replace(w, '')
    bad = sorted({line.strip() for line in text.split('\n') if HANGUL.search(line)})
    check(label, not bad, bad[:5])


# ───────────────────────── Part 1: dashboard ─────────────────────────
def test_dashboard(browser):
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'admin')
    pg.wait_for_selector('[data-testid=dash-assets]')
    check('dash/admin: nav starts with 대시보드', pg.locator('nav[aria-label="주 메뉴"] a').first.inner_text().strip() == '대시보드')
    check('dash/admin: nav has 이력 group (재고 이력, 감사 로그)', pg.locator('nav a[href="/history/stock"]').count() == 1 and pg.locator('nav a[href="/history/audit"]').count() == 1)
    check('dash/admin: total assets = 4', pg.inner_text('[data-testid=dash-assets] [data-testid=big-value]') == '4')
    a = dl(pg, 'dash-assets')
    check('dash/admin: overdue 1, warranty soon 1', a.get('반납 기한 지남') == '1' and a.get('보증 만료 임박') == '1', a)
    chips = pg.inner_text('[data-testid=dash-assets] ul')
    check('dash/admin: by-state chips (재고 · 사용 가능 2, 사용 중 2)', '재고 · 사용 가능 2' in chips and '사용 중 2' in chips, chips)
    check('dash/admin: overdue links to /assets?overdue=true', pg.locator('[data-testid=dash-assets] a[href="/assets?overdue=true"]').count() == 1)
    check('dash/admin: peripherals 56 on hand / 2 on loan', dl(pg, 'dash-peripherals') == {'보유 수량': '56', '대여 중 수량': '2'}, dl(pg, 'dash-peripherals'))
    check('dash/admin: loans 1 open / 1 overdue', dl(pg, 'dash-loans') == {'미반납': '1', '반납 기한 지남': '1'}, dl(pg, 'dash-loans'))
    check('dash/admin: loan links', pg.locator('[data-testid=dash-loans] a[href="/peripherals/loans"]').count() == 1 and pg.locator('[data-testid=dash-loans] a[href="/peripherals/loans?overdue=true"]').count() == 1)
    check('dash/admin: thresholds 2 active / 1 low (+ link)', dl(pg, 'dash-thresholds') == {'사용 중': '2', '부족': '1'} and pg.locator('[data-testid=dash-thresholds] a[href="/thresholds"]').count() == 1, dl(pg, 'dash-thresholds'))
    bars = pg.locator('[data-testid=dash-categories] li')
    check('dash/admin: one category bar (Laptop 2/2/4)', bars.count() == 1 and bars.first.get_attribute('aria-label') == 'Laptop: 사용 가능 2, 사용 중 2, 전체 4', bars.first.get_attribute('aria-label'))
    check('dash/admin: no scoped note', pg.get_by_text('내 부서 범위의 수치만').count() == 0)
    # negative control: the Hangul detector used by the language sweeps does find Hangul on a Korean screen
    ctl = pg.evaluate(VISIBLE_TEXT_JS)
    check('control: Hangul detector finds Hangul on the Korean dashboard', bool(HANGUL.search(ctl)))
    ctx.close()

    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'hrmanager')
    pg.wait_for_selector('[data-testid=dash-assets]')
    check('dash/scoped: scoped note shown', pg.get_by_text('내 부서 범위의 수치만 집계했습니다.').count() == 1)
    check('dash/scoped: total assets = 1', pg.inner_text('[data-testid=dash-assets] [data-testid=big-value]') == '1')
    a = dl(pg, 'dash-assets')
    check('dash/scoped: overdue 0, warranty 1', a.get('반납 기한 지남') == '0' and a.get('보증 만료 임박') == '1', a)
    check('dash/scoped: no overdue link when 0', pg.locator('[data-testid=dash-assets] a').count() == 0)
    check('dash/scoped: peripherals 3 / 2', dl(pg, 'dash-peripherals') == {'보유 수량': '3', '대여 중 수량': '2'}, dl(pg, 'dash-peripherals'))
    check('dash/scoped: thresholds 1 / 0', dl(pg, 'dash-thresholds') == {'사용 중': '1', '부족': '0'}, dl(pg, 'dash-thresholds'))
    ctx.close()

    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'dashonly')
    settle(pg)
    check('dash/dashonly: no cards', pg.locator('[data-testid^=dash-]').count() == 0)
    check('dash/dashonly: neutral notice', pg.get_by_text('대시보드에 표시할 수 있는 항목이 없습니다.').count() == 1)
    check('dash/dashonly: no 이력 menu', pg.locator('nav a[href^="/history"]').count() == 0)
    ctx.close()

    ctx, pg = new_page(browser)
    login(pg, 'SMOKEB', 'admin')
    pg.wait_for_selector('[data-testid=dash-assets]')
    check('dash/other company: 0 assets', pg.inner_text('[data-testid=dash-assets] [data-testid=big-value]') == '0')
    ctx.close()


# ───────────────────────── assets list: toolbar, status chips, sorting, column filters, reset ─────────────────────────
def tags_shown(pg):
    return [t.strip() for t in pg.locator('[data-testid=assets-table] tbody tr td:first-child').all_inner_texts()]


def wait_list(pg):
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(300)


def test_assets_toolbar(browser):
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'admin')
    pg.goto('/assets')
    pg.wait_for_selector('[data-testid=assets-table]')
    wait_list(pg)
    check('assets/toolbar: 4 rows, total shown', len(tags_shown(pg)) == 4 and '4' in pg.inner_text('[data-testid=list-total]'), tags_shown(pg))
    chip_n = lambda k: pg.inner_text(f'[data-testid=chip-{k}] .status-chip__n').strip()
    check('assets/chips: counts (all 4, in stock 2, in use 2, available 2)', [chip_n('all'), chip_n('IN_STOCK'), chip_n('IN_USE'), chip_n('IN_STOCK-AVAILABLE')] == ['4', '2', '2', '2'],
          [chip_n('all'), chip_n('IN_STOCK'), chip_n('IN_USE')])
    heads = pg.locator('[data-testid=assets-table] thead tr').first.inner_text()
    check('assets/headers: REQ/OPT marks (필수·선택)', '필수' in heads and '선택' in heads, heads)
    check('assets/headers: admin sees supplier column', pg.locator('th[data-col=supplier]').count() == 1)

    # search one field
    pg.select_option('[data-testid=search-field]', 'asset_tag')
    pg.fill('[data-testid=search-text]', 'SM-004')
    pg.get_by_role('button', name='검색', exact=True).click()
    wait_list(pg)
    check('assets/search: asset_tag=SM-004 → 1 row, in URL', tags_shown(pg) == ['SM-004'] and 'qField=asset_tag' in pg.url and 'q=SM-004' in pg.url, (tags_shown(pg), pg.url))
    pg.reload()
    pg.wait_for_selector('[data-testid=assets-table]')
    wait_list(pg)
    check('assets/search: survives reload', tags_shown(pg) == ['SM-004'] and pg.input_value('[data-testid=search-text]') == 'SM-004')
    pg.click('[data-testid=list-reset]')
    wait_list(pg)
    check('assets/reset: back to 4 rows, empty search, clean URL', len(tags_shown(pg)) == 4 and pg.input_value('[data-testid=search-text]') == '' and pg.url.rstrip('/').endswith('/assets'), pg.url)

    # status chip
    pg.click('[data-testid=chip-IN_USE]')
    wait_list(pg)
    check('assets/chip: IN_USE → 2 rows, chip pressed, state in URL', sorted(tags_shown(pg)) == ['SM-002', 'SM-003'] and pg.get_attribute('[data-testid=chip-IN_USE]', 'aria-pressed') == 'true' and 'state=IN_USE' in pg.url, (tags_shown(pg), pg.url))
    check('assets/chip: other chips keep their counts', chip_n('IN_STOCK') == '2' and chip_n('all') == '4')

    # sort by clicking the header twice
    pg.locator('th[data-col=asset_tag] button').click()
    wait_list(pg)
    check('assets/sort: asset tag desc', tags_shown(pg) == ['SM-003', 'SM-002'] and 'order=desc' in pg.url, (tags_shown(pg), pg.url))
    pg.locator('th[data-col=asset_tag] button').click()
    wait_list(pg)
    check('assets/sort: asset tag asc again', tags_shown(pg) == ['SM-002', 'SM-003'], tags_shown(pg))
    pg.locator('th[data-col=holder] button').click()
    wait_list(pg)
    check('assets/sort: holder asc (Kim, Lee)', tags_shown(pg) == ['SM-002', 'SM-003'] and 'sort=holder' in pg.url, (tags_shown(pg), pg.url))

    # column filter box (debounced)
    pg.get_by_label('보유자 거르기', exact=True).fill('Lee')
    pg.wait_for_timeout(900)
    wait_list(pg)
    check('assets/column filter: holder contains Lee → SM-003, f_holder in URL', tags_shown(pg) == ['SM-003'] and 'f_holder=Lee' in pg.url, (tags_shown(pg), pg.url))

    # page size
    pg.select_option('[data-testid=page-size]', '20')
    wait_list(pg)
    check('assets/page size: 20 in URL', 'pageSize=20' in pg.url, pg.url)

    pg.click('[data-testid=list-reset]')
    wait_list(pg)
    check('assets/reset: everything cleared (rows, chip, filter box, URL)', len(tags_shown(pg)) == 4 and pg.get_attribute('[data-testid=chip-all]', 'aria-pressed') == 'true'
          and pg.get_by_label('보유자 거르기', exact=True).input_value() == '' and pg.url.rstrip('/').endswith('/assets'), (tags_shown(pg), pg.url))
    check('assets/link: asset tag links to detail', pg.locator('[data-testid=assets-table] tbody tr td:first-child a').first.get_attribute('href').startswith('/assets/'))
    # password change entry point in the user menu
    link = pg.locator('[data-testid=change-password-link]')
    check('shell: change-password link in the top bar', link.count() == 1 and link.get_attribute('href') == '/change-password' and link.inner_text().strip() == '비밀번호 변경')
    link.click()
    pg.wait_for_url(BASE + '/change-password')
    check('shell: change-password link opens the page', pg.locator('h1').count() >= 1)
    ctx.close()

    # a viewer has no supplier/price permission: no header, no filter box, no sort control, no field option
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'viewer')
    pg.goto('/assets')
    pg.wait_for_selector('[data-testid=assets-table]')
    wait_list(pg)
    opts = pg.locator('[data-testid=search-field] option').all_inner_texts()
    check('assets/viewer: no supplier/price column, filter or search option',
          pg.locator('th[data-col=supplier]').count() == 0 and pg.locator('th[data-col=purchase_price]').count() == 0 and '공급업체' not in opts and len(tags_shown(pg)) == 4, opts)
    ctx.close()

    # peripherals list: toolbar + sortable headers + quantities
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'admin')
    pg.goto('/peripherals')
    pg.wait_for_selector('[data-testid=stock-table]')
    wait_list(pg)
    n = pg.locator('[data-testid=stock-table] tbody tr').count()
    pg.locator('th[data-col=on_hand] button').click()
    wait_list(pg)
    pg.locator('th[data-col=on_hand] button').click()
    wait_list(pg)
    qty = [int(x.replace(',', '')) for x in pg.locator('[data-testid=stock-table] tbody tr td:nth-child(5)').all_inner_texts()]
    check('peripherals/sort: on hand desc', qty == sorted(qty, reverse=True) and 'sort=on_hand' in pg.url and 'order=desc' in pg.url, (qty, pg.url))
    pg.select_option('[data-testid=search-field]', 'department')
    pg.fill('[data-testid=search-text]', 'HR')
    pg.get_by_role('button', name='검색', exact=True).click()
    wait_list(pg)
    depts = pg.locator('[data-testid=stock-table] tbody tr td:nth-child(4)').all_inner_texts()
    check('peripherals/search: department HR only', depts and all(d.strip() == 'HR' for d in depts), depts)
    check('peripherals/threshold column visible to admin', pg.locator('th[data-col=threshold]').count() == 1)
    pg.click('[data-testid=list-reset]')
    wait_list(pg)
    check('peripherals/reset: all rows back', pg.locator('[data-testid=stock-table] tbody tr').count() == n)
    ctx.close()


# ───────────────────────── Part 1: stock history ─────────────────────────
def test_stock_history(browser, ids):
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'admin')
    pg.goto('/history/stock')
    settle(pg)
    check('stock: first page has 50 rows', rows(pg).count() == 50, rows(pg).count())
    nxt = pg.get_by_role('button', name='다음')
    check('stock: next enabled (hasMore)', nxt.is_enabled())
    check('stock: prev disabled on page 1', pg.get_by_role('button', name='이전').is_disabled())
    nxt.click()
    pg.wait_for_url(re.compile(r'page=2'))
    settle(pg)
    total = len(API_HISTORY)
    check(f'stock: page 2 has the remaining {total - 50} rows, next disabled', rows(pg).count() == total - 50 and pg.get_by_role('button', name='다음').is_disabled(), (rows(pg).count(), total))
    check('stock: pager label without total', pg.get_by_text('2 쪽', exact=True).count() >= 1)
    pg.get_by_role('button', name='이전').click()
    pg.wait_for_url(re.compile(r'page=1'))
    settle(pg)
    check('stock: back to page 1 (50 rows)', rows(pg).count() == 50)
    settle(pg)

    pg.get_by_label('구분', exact=True).select_option('PERIPHERAL')
    pg.wait_for_url(re.compile('kind=PERIPHERAL'))
    settle(pg)
    kinds = set(pg.locator('table tbody tr td:nth-child(2)').all_inner_texts())
    check('stock: kind=PERIPHERAL shows only peripherals', kinds == {'주변기기'}, kinds)
    opts = pg.get_by_label('종류', exact=True).locator('option').all_inner_texts()
    check('stock: type options for peripherals', '최초 등록' in opts and '실사 조정' in opts and '배정' not in opts, opts)
    pg.get_by_label('구분', exact=True).select_option('ASSET')
    pg.wait_for_url(re.compile('kind=ASSET'))
    settle(pg)
    opts = pg.get_by_label('종류', exact=True).locator('option').all_inner_texts()
    check('stock: type options for assets', '배정' in opts and '등록' in opts and '최초 등록' not in opts, opts)
    link = pg.locator('table tbody a', has_text='SM-002')
    check('stock: asset tag is a link to the asset', link.count() >= 1 and link.first.get_attribute('href') == f"/assets/{ids['a2']}")

    pg.goto('/history/stock?type=LOAN')
    settle(pg)
    kinds = sorted(pg.locator('table tbody tr td:nth-child(2)').all_inner_texts())
    check('stock: type=LOAN covers both kinds', kinds == ['자산', '주변기기'], kinds)

    pg.goto('/history/stock')
    settle(pg)
    pg.get_by_label('직원', exact=True).fill('Lee')
    pg.locator('li button', has_text='Lee').first.click()
    pg.wait_for_url(re.compile('personId='))
    settle(pg)
    check('stock: person filter (Lee) → 2 rows', rows(pg).count() == 2, rows(pg).count())

    pg.goto('/history/stock')
    settle(pg)
    pg.get_by_label('검색', exact=True).fill('logi')
    pg.wait_for_url(re.compile('q=logi'))
    settle(pg)
    kinds = set(pg.locator('table tbody tr td:nth-child(2)').all_inner_texts())
    check('stock: search "logi" → peripherals only', kinds == {'주변기기'}, kinds)

    pg.goto(f'/history/stock?from={day(2)}')
    settle(pg)
    check('stock: from=future → empty', pg.get_by_text('조건에 맞는 이력이 없습니다.').count() == 1)
    check('stock: time-zone hint shown', pg.get_by_text('날짜는 기업의 시간대 기준입니다.', exact=False).count() == 1)
    pg.goto(f'/history/stock?from={day(2)}&to={day(0)}')
    settle(pg)
    check('stock: from > to → validation message, no table', pg.get_by_text('시작일이 종료일보다 늦습니다.').count() == 1 and pg.locator('table').count() == 0)

    pg.goto('/history/stock?kind=ASSET&type=ASSIGN')
    settle(pg)
    pg.locator('table tbody a', has_text='SM-002').first.click()
    pg.wait_for_url(BASE + f"/assets/{ids['a2']}")
    settle(pg)
    check('stock: asset link opens the asset detail', pg.locator('h1', has_text='SM-002').count() == 1)
    ctx.close()


# ───────────────────────── Part 1: audit log ─────────────────────────
def test_audit(browser):
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'admin')
    pg.goto('/history/audit')
    settle(pg)
    check('audit: rows listed', rows(pg).count() > 5, rows(pg).count())
    pg.get_by_label('행위', exact=True).fill('category')
    pg.wait_for_url(re.compile('action=CATEGORY'))
    settle(pg)
    codes = pg.locator('table tbody tr td:nth-child(2) div').all_inner_texts()
    check('audit: action prefix (typed lowercase, sent uppercase) → only CATEGORY_*', len(codes) == 3 and all(c.startswith('CATEGORY_') for c in codes), codes)
    check('audit: Korean label shown with code', pg.locator('table tbody tr td:nth-child(2)', has_text='카테고리 추가').count() == 3)
    pg.get_by_label('행위', exact=True).fill('ASSET-X')
    pg.wait_for_timeout(700)
    check('audit: invalid action prefix → message, not sent', pg.get_by_text('행위는 영문 대문자와 _ 만 입력하세요.', exact=False).count() == 1 and 'ASSET-X' not in pg.url and 'action=CATEGORY' in pg.url, pg.url)

    pg.goto('/history/audit?resource=threshold')
    settle(pg)
    check('audit: resource=threshold → 2 rows', rows(pg).count() == 2, rows(pg).count())
    sel = pg.get_by_label('리소스', exact=True)
    check('audit: resource select uses resource names', '한계 수량 (threshold)' in sel.locator('option').all_inner_texts())
    actor = pg.get_by_label('처리자', exact=True)
    check('audit: actor select (admin.user:read) lists accounts', 'Admin (admin)' in actor.locator('option').all_inner_texts())
    actor.select_option(label='Admin (admin)')
    pg.wait_for_url(re.compile('actorId='))
    settle(pg)
    actors = set(t.split('\n')[0] for t in pg.locator('table tbody tr td:nth-child(5)').all_inner_texts())
    check('audit: actor filter → only Admin', actors == {'Admin'}, actors)

    pg.goto('/history/audit?action=CATEGORY_CREATED')
    settle(pg)
    while pg.get_by_role('button', name='변경 내용 보기').count():
        pg.get_by_role('button', name='변경 내용 보기').first.click()
    pres = pg.locator('table pre').all_inner_texts()
    check('audit: expanded JSON is pretty-printed text', any('"name": "Laptop"' in t for t in pres), pres[:2])
    check('audit: XSS payload shown literally as text', any(f'"name": "{XSS}"' in t for t in pres), pres)
    check('audit: no <img> injected', pg.locator('table img').count() == 0)
    pg.get_by_role('button', name='접기').first.click()
    check('audit: row collapses', pg.locator('table pre').count() == len(pres) - 2)
    pg.goto(f'/history/audit?from={day(2)}')
    settle(pg)
    check('audit: from=future → empty', pg.get_by_text('조건에 맞는 기록이 없습니다.').count() == 1)
    ctx.close()

    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'hraudit')
    pg.goto('/history/audit')
    settle(pg)
    check('audit/scoped: server 403 message shown', pg.get_by_text('감사 로그는 부서 범위 제한이 없는 사용자만 볼 수 있습니다.').count() == 1)
    check('audit/scoped: no table, no filters', pg.locator('table').count() == 0 and pg.locator('select').count() == 1)  # 1 = language switcher
    ctx.close()

    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'viewer')
    check('nav/viewer: 재고 이력 yes, 감사 로그 no', pg.locator('nav a[href="/history/stock"]').count() == 1 and pg.locator('nav a[href="/history/audit"]').count() == 0)
    ctx.close()


# ───────────────────────── Part 2: languages ─────────────────────────
STR = {
    'en': {'login': 'Sign in to StockMgmt', 'dash': 'Dashboard', 'assets': 'Assets', 'register': 'Register asset', 'issue': 'Issue',
           'periph': 'Peripheral stock', 'receive': 'Receive', 'loans': 'Peripheral loans', 'return': 'Return', 'import': 'Excel import',
           'thr': 'Minimum stock', 'thrAdd': 'Add minimum stock', 'inbox': 'Inbox', 'mail': 'Mail schedules', 'mailAdd': 'Add schedule',
           'logs': 'Delivery log', 'users': 'Users', 'userAdd': 'Add user', 'roles': 'Roles', 'edit': 'Edit', 'stock': 'Stock history',
           'audit': 'Audit log', 'show': 'Show changes', 'cats': 'Categories', 'models': 'Models', 'depts': 'Departments', 'persons': 'Employees',
           'cf': 'Custom fields', 'pw': 'Change password', 'history': 'History', 'resource': 'Asset list', 'alert': 'below the minimum stock of 100',
           'scoped': 'These figures cover only the departments in your scope.'},
    'zh': {'login': '登录 StockMgmt', 'dash': '仪表板', 'assets': '资产', 'register': '登记资产', 'issue': '发放',
           'periph': '外设库存', 'receive': '入库', 'loans': '外设借用情况', 'return': '归还', 'import': 'Excel 导入',
           'thr': '最低库存', 'thrAdd': '添加最低库存', 'inbox': '提醒箱', 'mail': '邮件计划', 'mailAdd': '添加计划',
           'logs': '发送记录', 'users': '用户管理', 'userAdd': '添加用户', 'roles': '角色管理', 'edit': '编辑', 'stock': '库存记录',
           'audit': '审计日志', 'show': '查看变更内容', 'cats': '类别', 'models': '型号', 'depts': '部门', 'persons': '员工',
           'cf': '自定义字段', 'pw': '修改密码', 'history': '记录', 'resource': '资产列表', 'alert': '低于最低库存 100 个',
           'scoped': '仅统计您部门范围内的数据'},
}


def heading(pg, text):
    return pg.locator('h1', has_text=text).count() >= 1


def sweep(browser, lang, ids):
    t = STR[lang]
    ctx, pg = new_page(browser)
    pg.goto('/login')
    settle(pg)
    pg.select_option('[data-testid=lang-switcher]', lang)
    settle(pg, lang)
    check(f'{lang}: login page translated', heading(pg, t['login']))
    no_hangul(pg, f'{lang}: [1] login — no Hangul')
    pg.reload()
    settle(pg, lang)
    check(f'{lang}: choice survives reload (login, <html lang>={lang})', heading(pg, t['login']) and pg.evaluate('document.documentElement.lang') == lang)
    login(pg, 'SMOKEA', 'admin')
    settle(pg, lang)
    pg.wait_for_selector('[data-testid=dash-assets]')
    check(f'{lang}: stored choice wins over user lang after sign-in', heading(pg, t['dash']))
    no_hangul(pg, f'{lang}: [2] dashboard — no Hangul')
    count = 2

    def visit(path, h, label, action=None, dialog_text=None, extra=()):
        nonlocal count
        pg.goto(path)
        settle(pg, lang)
        ok = heading(pg, h) if h else True
        check(f'{lang}: {path} heading "{h}"', ok)
        count += 1
        no_hangul(pg, f'{lang}: [{count}] {label} — no Hangul', extra)
        if action:
            action()
            pg.wait_for_selector('[role=dialog]')
            settle(pg)
            if dialog_text:
                check(f'{lang}: {label} dialog contains "{dialog_text}"', pg.locator('[role=dialog]', has_text=dialog_text).count() == 1)
            count += 1
            no_hangul(pg, f'{lang}: [{count}] {label} dialog — no Hangul', extra)
            pg.keyboard.press('Escape')
            pg.wait_for_selector('[role=dialog]', state='detached')

    btn = lambda name: (lambda: pg.get_by_role('button', name=name, exact=True).first.click())
    visit('/assets', t['assets'], 'assets list', btn(t['register']), t['register'])
    visit(f"/assets/{ids['a1']}", 'SM-001', 'asset detail', btn(t['issue']))
    visit('/peripherals', t['periph'], 'peripheral stock', btn(t['receive']))
    visit('/peripherals', t['periph'], 'peripheral history', btn(t['history']))
    visit('/peripherals/loans', t['loans'], 'loans', btn(t['return']))
    visit('/import', t['import'], 'import')
    visit('/thresholds', t['thr'], 'thresholds', btn(t['thrAdd']))
    visit('/alerts', t['inbox'], 'alerts inbox')
    check(f'{lang}: alert sentence built in {lang}', pg.get_by_text(t['alert'], exact=False).count() >= 1)
    visit('/mail/schedules', t['mail'], 'mail schedules', btn(t['mailAdd']))
    visit('/mail/logs', t['logs'], 'mail logs')
    visit('/admin/users', t['users'], 'users', btn(t['userAdd']))
    visit('/admin/roles', t['roles'], 'roles', btn(t['edit']), t['resource'])
    visit('/history/stock', t['stock'], 'stock history')
    visit('/history/audit', t['audit'], 'audit log', None)
    pg.get_by_role('button', name=t['show']).first.click()
    no_hangul(pg, f'{lang}: audit expanded row — no Hangul')
    for path, key in [('/master/categories', 'cats'), ('/master/models', 'models'), ('/master/departments', 'depts'), ('/master/persons', 'persons'), ('/master/custom-fields', 'cf')]:
        visit(path, t[key], path)
    visit('/change-password', t['pw'], 'change password')
    check(f'{lang}: ≥12 pages/dialogs checked ({count})', count >= 12)

    # switch back to Korean in the shell, then reload: Korean stays and <html lang> follows
    pg.goto('/')
    settle(pg, lang)
    pg.select_option('header [data-testid=lang-switcher]', 'ko')
    settle(pg, 'ko')
    check(f'{lang}→ko: shell switcher changes UI immediately', heading(pg, '대시보드'))
    pg.reload()
    settle(pg, 'ko')
    check(f'{lang}→ko: survives reload, <html lang>=ko', heading(pg, '대시보드') and pg.evaluate('document.documentElement.lang') == 'ko')
    ctx.close()

    # scoped user in this language: the scoped note is translated
    ctx, pg = new_page(browser)
    pg.goto('/login')
    settle(pg)
    pg.select_option('[data-testid=lang-switcher]', lang)
    login(pg, 'SMOKEA', 'hrmanager')
    settle(pg, lang)
    pg.wait_for_selector('[data-testid=dash-assets]')
    check(f'{lang}: scoped note translated', pg.get_by_text(t['scoped'], exact=False).count() == 1)
    no_hangul(pg, f'{lang}: scoped dashboard — no Hangul')
    pg.goto('/history/audit')
    ctx.close()


def test_user_default_and_storage(browser):
    # user lang (zh) is the default when nothing is stored in this browser
    ctx, pg = new_page(browser)
    login(pg, 'SMOKEA', 'zhuser')
    settle(pg, 'zh')
    check('default: user lang zh applied after sign-in (no stored choice)', heading(pg, '仪表板') and pg.evaluate('document.documentElement.lang') == 'zh')
    check('default: nothing stored in localStorage', pg.evaluate("localStorage.getItem('stockmgmt.lang')") is None)
    ctx.close()
    # localStorage throws → switcher still works in memory, no page error
    ctx, pg = new_page(browser, "Storage.prototype.setItem = function () { throw new DOMException('blocked', 'SecurityError'); }; Storage.prototype.getItem = function () { throw new DOMException('blocked', 'SecurityError'); };")
    before = len(page_errors)
    pg.goto('/login')
    settle(pg)
    pg.select_option('[data-testid=lang-switcher]', 'en')
    settle(pg, 'en')
    check('storage blocked: switch still works (memory fallback), no page error', heading(pg, 'Sign in to StockMgmt') and len(page_errors) == before, page_errors[before:])
    ctx.close()


def main():
    with sync_playwright() as p:
        ids = seed(p)
        print('seeded business data', flush=True)
        browser = p.chromium.launch(executable_path=os.environ.get('E2E_CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
        test_dashboard(browser)
        test_assets_toolbar(browser)
        test_stock_history(browser, ids)
        test_audit(browser)
        sweep(browser, 'en', ids)
        sweep(browser, 'zh', ids)
        test_user_default_and_storage(browser)
        browser.close()
    check('no uncaught page errors / unexpected JS dialogs', not page_errors, page_errors[:5])
    print(f'\nRESULT: {len(passed)} passed, {len(failed)} failed')
    for f in failed:
        print('  FAILED:', f)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
