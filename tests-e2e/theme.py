#!/usr/bin/env python3
"""Theme check: screenshots at 1280x800 and 390x844, text contrast, focus visibility, horizontal overflow,
modal scrolling, and the language-save wiring (PATCH /api/me only from the signed-in shell).
Run through run.sh (throwaway DB/role, seeded accounts, server lifecycle)."""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import smoke  # noqa: E402  (seed helpers; its main() is not run on import)

BASE = os.environ['SMOKE_BASE']
PW = os.environ['SMOKE_PW']
OWNER_URL = os.environ['OWNER_URL']
OUT = os.environ.get('E2E_OUT') or os.path.join(os.path.dirname(__file__), '.out')
SHOTS = os.path.join(OUT, 'shots')
os.makedirs(SHOTS, exist_ok=True)

passed, failed = [], []
page_errors = []
report = {}


def check(name, cond, detail=''):
    (passed if cond else failed).append(name if cond else f'{name} :: {detail}')
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {detail}'), flush=True)


def sql(q):
    return subprocess.run(['psql', OWNER_URL, '-qAtc', q], check=True, capture_output=True, text=True).stdout.strip()


# ── contrast: every visible text node against its composited background ──
CONTRAST_JS = r"""() => {
  const parse = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const stops = (img) => (img && img.includes('gradient') ? (img.match(/rgba?\([^)]+\)/g) || []).map(parse) : []);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
  // backgrounds behind el: walk up until an opaque layer; gradients give several candidate backgrounds
  const backgrounds = (el) => {
    const layers = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const g = stops(cs.backgroundImage);
      const c = parse(cs.backgroundColor);
      if (g.length || (c && c.a > 0)) layers.push({ c, g });
      if ((c && c.a >= 1) || (g.length && g.every((s) => s.a >= 1))) break;
    }
    let cands = [bodyBg];
    for (const l of layers.reverse()) {
      if (l.c && l.c.a > 0) cands = cands.map((b) => over(l.c, b));
      if (l.g.length) cands = cands.flatMap((b) => l.g.map((s) => over(s, b)));
    }
    return cands;
  };
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;  // sr-only
    for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).clip === 'rect(0px, 0px, 0px, 0px)') return false;
    return true;
  };
  const DISABLED = 'button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, [aria-disabled="true"], .check-row.is-disabled, option';
  const out = { checked: 0, skippedDisabled: 0, fails: [], min: 99, minAt: '' };
  const test = (el, label, fgColor) => {
    const cs = getComputedStyle(el);
    let fg = parse(fgColor || cs.color);
    if (!fg) return;
    fg = { ...fg, a: fg.a * opacity(el) };
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    for (const bg of backgrounds(el)) {
      const r = ratio(over(fg, bg), bg);
      out.checked++;
      if (r < out.min) { out.min = r; out.minAt = label; }
      if (r < need) out.fails.push({ text: label.slice(0, 60), ratio: Math.round(r * 100) / 100, need, fg: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, cls: el.className && String(el.className).slice(0, 40), tag: el.tagName });
    }
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    if (!visible(el)) continue;
    if (el.closest(DISABLED)) { out.skippedDisabled++; continue; }
    test(el, n.textContent.trim());
  }
  // values shown inside form controls
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (['checkbox', 'radio', 'hidden', 'file'].includes(el.type) || !visible(el)) continue;
    if (el.disabled) { out.skippedDisabled++; continue; }
    const v = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent : el.value;
    if (v && v.trim()) test(el, `[${el.tagName.toLowerCase()}] ${v.trim()}`);
  }
  // UI boundaries: control borders vs the background around the control (3:1)
  out.boundaryFails = [];
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, .btn--secondary')) {
    if (!visible(el) || el.disabled) continue;
    const b = parse(getComputedStyle(el).borderTopColor);
    for (const bg of backgrounds(el.parentElement)) {
      const r = ratio(over(b, bg), bg);
      if (r < 3) out.boundaryFails.push({ el: el.tagName + '.' + el.className, ratio: Math.round(r * 100) / 100 });
    }
  }
  out.min = Math.round(out.min * 100) / 100;
  return out;
}"""

OVERFLOW_JS = r"""() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const bad = [];
  const clipped = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o !== 'visible') return true; } return false; };
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > vw + 1 && !clipped(el)) bad.push(el.tagName + '.' + String(el.className).slice(0, 30) + ' right=' + Math.round(r.right));
  }
  return { scrollWidth: de.scrollWidth, clientWidth: vw, bad: bad.slice(0, 8) };
}"""

FOCUS_SNAPSHOT_JS = r"""(scope) => {
  const root = scope ? document.querySelector(scope) : document;
  window.__unf = new Map();
  for (const el of root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
    const cs = getComputedStyle(el);
    window.__unf.set(el, [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow].join('|'));
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return window.__unf.size;
}"""

FOCUS_ACTIVE_JS = r"""(scope) => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (scope && !el.closest(scope)) return { outside: true };
  const cs = getComputedStyle(el);
  const now = [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow].join('|');
  const before = window.__unf.get(el);
  const visibleOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
  return { id: el.tagName + ':' + (el.getAttribute('href') || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.type || ''),
           known: before !== undefined, changed: before !== undefined && before !== now, visibleOutline, now };
}"""


def focus_check(pg, label, scope=None, max_tabs=70):
    n = pg.evaluate(FOCUS_SNAPSHOT_JS, scope)
    if scope:
        pg.focus(scope)  # dialog box itself (tabIndex=-1) — Tab moves into its controls
    seen, bad, count = set(), [], 0
    for _ in range(max_tabs):
        pg.keyboard.press('Tab')
        info = pg.evaluate(FOCUS_ACTIVE_JS, scope)
        if info is None:
            continue
        if info.get('outside'):
            break
        if info['id'] in seen:
            break
        seen.add(info['id'])
        count += 1
        if not (info['changed'] and info['visibleOutline']):
            bad.append(info['id'])
    check(f'{label}: focus visible on every tabbed control ({count} of {n} focusable)', count > 0 and not bad, bad[:6])
    return count


def contrast_check(pg, label):
    r = pg.evaluate(CONTRAST_JS)
    report.setdefault('contrast', {})[label] = {'checked': r['checked'], 'min': r['min'], 'minAt': r['minAt'][:40], 'skippedDisabled': r['skippedDisabled']}
    check(f'{label}: text contrast ≥ AA ({r["checked"]} text/bg pairs, min {r["min"]} at "{r["minAt"][:30]}")', not r['fails'], r['fails'][:4])
    check(f'{label}: control boundaries ≥ 3:1', not r['boundaryFails'], r['boundaryFails'][:4])


def overflow_check(pg, label):
    r = pg.evaluate(OVERFLOW_JS)
    check(f'{label}: no horizontal page overflow (scrollWidth {r["scrollWidth"]} ≤ {r["clientWidth"]})', r['scrollWidth'] <= r['clientWidth'] + 1 and not r['bad'], r['bad'])


def modal_scroll_check(pg, label):
    r = pg.evaluate("""() => {
      const ov = document.querySelector('.modal-overlay'); const box = document.querySelector('[role=dialog]');
      ov.scrollTop = ov.scrollHeight;
      const b = box.getBoundingClientRect();
      return { bottom: Math.round(b.bottom), h: innerHeight, left: Math.round(b.left), right: Math.round(b.right), w: document.documentElement.clientWidth };
    }""")
    ok = r['bottom'] <= r['h'] + 1 and r['left'] >= 0 and r['right'] <= r['w'] + 1
    check(f'{label}: dialog fits width and its end is reachable by scrolling', ok, r)
    pg.evaluate("() => { document.querySelector('.modal-overlay').scrollTop = 0; }")


def settle(pg):
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(350)


def main():
    with sync_playwright() as p:
        if os.environ.get('SKIP_SMOKE') == '1':
            smoke.seed(p)
        # a mail schedule, so the edit dialog can be opened
        api = p.request.new_context(base_url=BASE)
        assert api.post('/api/auth/login', data={'companyCode': 'SMOKEA', 'loginId': 'admin', 'password': PW}).ok
        r = api.post('/api/mail/schedules', data={'name': 'Weekly low stock', 'frequency': 'DAILY', 'sendTime': '09:00', 'timezone': 'Asia/Seoul',
                                                  'contentType': 'LOW_STOCK', 'recipients': {'userIds': [], 'emails': ['ops@example.com']}})
        check('setup: mail schedule created', r.ok, r.text()[:200])
        api.dispose()
        a1 = sql("SELECT id FROM app.asset WHERE asset_tag = 'SM-001'")

        browser = p.chromium.launch(executable_path=os.environ.get('E2E_CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
        t = smoke.STR['en']
        for vw, vh in [(1280, 800), (390, 844)]:
            tag = f'{vw}x{vh}'
            ctx = browser.new_context(base_url=BASE, viewport={'width': vw, 'height': vh})
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: page_errors.append(str(e)))
            patches = []
            pg.on('request', lambda req: patches.append((req.method, req.url, req.post_data)) if req.url.endswith('/api/me') and req.method == 'PATCH' else None)

            def shot(name):
                pg.screenshot(path=os.path.join(SHOTS, f'{tag}-{name}.png'), full_page=True)

            def screen(name, path, dialog=None, after=None, focus=True):
                pg.goto(path)
                settle(pg)
                if after:
                    after()
                    settle(pg)
                label = f'{tag} {name}'
                if dialog:
                    dialog()
                    pg.wait_for_selector('[role=dialog]')
                    settle(pg)
                shot(name)
                contrast_check(pg, label)
                if vw < 500:
                    overflow_check(pg, label)
                if dialog:
                    if vw < 500:
                        modal_scroll_check(pg, label)
                    if focus:
                        focus_check(pg, label + ' (dialog)', '[role=dialog]')
                    pg.keyboard.press('Escape')
                    pg.wait_for_selector('[role=dialog]', state='detached')
                elif focus:
                    focus_check(pg, label)

            # login (English chosen on the login page: must NOT save to the account)
            pg.goto('/login')
            settle(pg)
            pg.select_option('[data-testid=lang-switcher]', 'en')
            settle(pg)
            shot('login')
            contrast_check(pg, f'{tag} login')
            if vw < 500:
                overflow_check(pg, f'{tag} login')
            focus_check(pg, f'{tag} login')
            check(f'{tag} login: language change does not call PATCH /api/me', not patches, patches)
            ins = pg.locator('main input')
            ins.nth(0).fill('SMOKEA')
            ins.nth(1).fill('admin')
            ins.nth(2).fill(PW)
            pg.locator('main button').click()
            pg.wait_for_url(BASE + '/')
            settle(pg)
            pg.wait_for_selector('[data-testid=dash-assets]')

            btn = lambda name: (lambda: pg.get_by_role('button', name=name, exact=True).first.click())
            screen('dashboard', '/')
            screen('assets', '/assets')
            screen('asset-register', '/assets', btn(t['register']))
            screen('asset-detail', f'/assets/{a1}')
            screen('asset-action', f'/assets/{a1}', btn(t['issue']))
            screen('peripherals', '/peripherals')
            screen('peripherals-receive', '/peripherals', btn(t['receive']), focus=False)
            screen('loans', '/peripherals/loans')
            screen('loan-return', '/peripherals/loans', btn(t['return']), focus=False)
            screen('import', '/import')
            screen('thresholds', '/thresholds')
            screen('threshold-add', '/thresholds', btn(t['thrAdd']), focus=False)
            screen('alerts', '/alerts')
            screen('mail-schedules', '/mail/schedules')
            screen('mail-schedule-edit', '/mail/schedules', btn(t['edit']))
            screen('mail-logs', '/mail/logs', focus=False)
            screen('users', '/admin/users')
            screen('user-add', '/admin/users', btn(t['userAdd']), focus=False)
            screen('roles', '/admin/roles')
            screen('role-edit', '/admin/roles', btn(t['edit']))
            screen('stock-history', '/history/stock')
            screen('audit-expanded', '/history/audit', after=lambda: pg.get_by_role('button', name=t['show']).first.click())
            screen('categories', '/master/categories')
            screen('persons', '/master/persons', focus=False)
            screen('custom-fields', '/master/custom-fields', focus=False)

            if vw < 500:
                # the sidebar is a drawer: closed (not focusable), opens from the menu button, closes on Esc
                pg.goto('/')
                settle(pg)
                hidden = pg.evaluate("() => getComputedStyle(document.querySelector('aside.sidebar')).visibility")
                check(f'{tag} drawer: closed by default (visibility hidden)', hidden == 'hidden', hidden)
                toggle = pg.locator('header .menu-toggle')
                check(f'{tag} drawer: menu button visible', toggle.is_visible())
                toggle.click()
                pg.wait_for_timeout(400)
                shot('drawer-open')
                check(f'{tag} drawer: opens, aria-expanded=true, focus on first link',
                      toggle.get_attribute('aria-expanded') == 'true' and pg.evaluate("() => document.activeElement.closest('aside') !== null"))
                contrast_check(pg, f'{tag} drawer')
                pg.keyboard.press('Escape')
                pg.wait_for_timeout(400)
                check(f'{tag} drawer: Esc closes', toggle.get_attribute('aria-expanded') == 'false')
                toggle.click()
                pg.wait_for_timeout(400)
                pg.locator('aside a[href="/assets"]').click()
                pg.wait_for_url(BASE + '/assets')
                pg.wait_for_timeout(400)
                check(f'{tag} drawer: navigating closes it', toggle.get_attribute('aria-expanded') == 'false')
            else:
                # language switch in the signed-in shell saves to the account (PATCH /api/me), UI changes immediately
                pg.goto('/')
                settle(pg)
                before = len(patches)
                pg.select_option('header [data-testid=lang-switcher]', 'zh')
                pg.wait_for_function("document.documentElement.lang === 'zh'")
                settle(pg)
                new = patches[before:]
                check(f'{tag} shell: language change calls PATCH /api/me once with {{"lang":"zh"}}',
                      len(new) == 1 and json.loads(new[0][2] or '{}') == {'lang': 'zh'}, new)
                saved = sql("SELECT lang FROM app.app_user u JOIN app.company c ON c.id = u.company_id WHERE c.code = 'SMOKEA' AND u.login_id = 'admin'")
                check(f'{tag} shell: account language saved (zh)', saved == 'zh', saved)
                pg.select_option('header [data-testid=lang-switcher]', 'en')
                pg.wait_for_function("document.documentElement.lang === 'en'")
                settle(pg)
            ctx.close()
        browser.close()

    check('no uncaught page errors', not page_errors, page_errors[:5])
    with open(os.path.join(OUT, 'theme-report.json'), 'w') as f:
        json.dump(report, f, indent=1, ensure_ascii=False)
    print(f'\nRESULT: {len(passed)} passed, {len(failed)} failed')
    for f in failed:
        print('  FAILED:', f)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
