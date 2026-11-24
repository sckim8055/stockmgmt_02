-- 0003_seed_permissions.sql
-- 권한 대상(리소스)과 동작, 그리고 기본 역할 템플릿 3개.
-- 리소스 코드는 서버 코드(src/lib/auth/resources.ts)와 반드시 일치해야 한다.

INSERT INTO app.sys_resource (code, parent_code, type, sort_order) VALUES
  ('menu.dashboard',   NULL, 'MENU', 10),
  ('menu.asset',       NULL, 'MENU', 20),
  ('menu.peripheral',  NULL, 'MENU', 30),
  ('menu.master',      NULL, 'MENU', 40),
  ('menu.alert',       NULL, 'MENU', 50),
  ('menu.mail',        NULL, 'MENU', 60),
  ('menu.history',     NULL, 'MENU', 70),
  ('menu.admin',       NULL, 'MENU', 80);

INSERT INTO app.sys_resource (code, parent_code, type, sort_order) VALUES
  ('dashboard',            'menu.dashboard',  'PAGE', 10),
  ('asset.item',           'menu.asset',      'PAGE', 10),
  ('asset.assign',         'menu.asset',      'PAGE', 20),
  ('asset.maintain',       'menu.asset',      'PAGE', 30),
  ('asset.retire',         'menu.asset',      'PAGE', 40),
  ('peripheral.stock',     'menu.peripheral', 'PAGE', 10),
  ('peripheral.receive',   'menu.peripheral', 'PAGE', 20),
  ('peripheral.issue',     'menu.peripheral', 'PAGE', 30),
  ('peripheral.adjust',    'menu.peripheral', 'PAGE', 40),
  ('peripheral.loan',      'menu.peripheral', 'PAGE', 50),
  ('master.category',      'menu.master',     'PAGE', 10),
  ('master.model',         'menu.master',     'PAGE', 20),
  ('master.department',    'menu.master',     'PAGE', 30),
  ('master.person',        'menu.master',     'PAGE', 40),
  ('master.custom_field',  'menu.master',     'PAGE', 50),
  ('threshold',            'menu.alert',      'PAGE', 10),
  ('alert.inbox',          'menu.alert',      'PAGE', 20),
  ('mail.schedule',        'menu.mail',       'PAGE', 10),
  ('mail.log',             'menu.mail',       'PAGE', 20),
  ('history.stock',        'menu.history',    'PAGE', 10),
  ('history.audit',        'menu.history',    'PAGE', 20),
  ('admin.user',           'menu.admin',      'PAGE', 10),
  ('admin.user.password',  'menu.admin',      'PAGE', 20),
  ('admin.role',           'menu.admin',      'PAGE', 30);

-- 제한 필드
INSERT INTO app.sys_resource (code, parent_code, type, sort_order) VALUES
  ('asset.item.purchase_price', 'asset.item', 'FIELD', 10),
  ('asset.item.supplier',       'asset.item', 'FIELD', 20),
  ('asset.item.custom_restricted', 'asset.item', 'FIELD', 30);

INSERT INTO app.sys_resource_operation (resource_code, operation)
SELECT v.code, op
FROM (VALUES
  ('dashboard',            ARRAY['read']),
  ('asset.item',           ARRAY['read', 'create', 'update', 'import', 'export']),
  ('asset.assign',         ARRAY['execute']),
  ('asset.maintain',       ARRAY['execute']),
  ('asset.retire',         ARRAY['execute']),
  ('peripheral.stock',     ARRAY['read', 'export']),
  ('peripheral.receive',   ARRAY['execute']),
  ('peripheral.issue',     ARRAY['execute']),
  ('peripheral.adjust',    ARRAY['execute']),
  ('peripheral.loan',      ARRAY['read', 'export']),
  ('master.category',      ARRAY['read', 'create', 'update', 'delete', 'activate', 'deactivate']),
  ('master.model',         ARRAY['read', 'create', 'update', 'delete', 'activate', 'deactivate']),
  ('master.department',    ARRAY['read', 'create', 'update', 'delete', 'activate', 'deactivate']),
  ('master.person',        ARRAY['read', 'create', 'update', 'activate', 'deactivate', 'import']),
  ('master.custom_field',  ARRAY['read', 'create', 'update', 'delete']),
  ('threshold',            ARRAY['read', 'create', 'update', 'delete']),
  ('alert.inbox',          ARRAY['read']),
  ('mail.schedule',        ARRAY['read', 'create', 'update', 'delete', 'activate', 'deactivate']),
  ('mail.log',             ARRAY['read']),
  ('history.stock',        ARRAY['read', 'export']),
  ('history.audit',        ARRAY['read', 'export']),
  ('admin.user',           ARRAY['read', 'create', 'update', 'activate', 'deactivate']),
  ('admin.user.password',  ARRAY['execute']),
  ('admin.role',           ARRAY['read', 'create', 'update', 'delete']),
  ('asset.item.purchase_price',    ARRAY['read', 'update']),
  ('asset.item.supplier',          ARRAY['read', 'update']),
  ('asset.item.custom_restricted', ARRAY['read', 'update'])
) AS v(code, ops), unnest(v.ops) AS op;

-- ─────────────────────────── 역할 템플릿 (company_id NULL) ───────────────────────────
-- 기업을 만들 때 이 템플릿을 그 기업의 역할로 복사한다. 템플릿을 고쳐도 기존 기업의 역할은 바뀌지 않는다.

INSERT INTO app.role (id, company_id, name, description) VALUES
  ('00000000-0000-4000-8000-000000000001', NULL, 'Viewer',          '조회 전용'),
  ('00000000-0000-4000-8000-000000000002', NULL, 'Stock Operator',  '재고 담당: 배정·지급·입고 가능'),
  ('00000000-0000-4000-8000-000000000003', NULL, 'Stock Manager',   '재고 관리자: 폐기·보정·기준 정보·한계수량·메일 설정 포함');

-- 조회 전용: 제한 필드를 뺀 모든 조회
INSERT INTO app.role_acl (role_id, resource_code, operation)
SELECT '00000000-0000-4000-8000-000000000001', o.resource_code, o.operation
FROM app.sys_resource_operation o
JOIN app.sys_resource r ON r.code = o.resource_code
WHERE o.operation = 'read' AND r.type = 'PAGE'
  AND o.resource_code NOT IN ('history.audit', 'admin.user', 'admin.role', 'mail.schedule', 'mail.log');

-- 재고 담당: 조회 전용 + 자산 등록·수정, 배정, 주변기기 입고·지급, 직원 등록
INSERT INTO app.role_acl (role_id, resource_code, operation)
SELECT '00000000-0000-4000-8000-000000000002', resource_code, operation
FROM app.role_acl WHERE role_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO app.role_acl (role_id, resource_code, operation) VALUES
  ('00000000-0000-4000-8000-000000000002', 'asset.item', 'create'),
  ('00000000-0000-4000-8000-000000000002', 'asset.item', 'update'),
  ('00000000-0000-4000-8000-000000000002', 'asset.item', 'export'),
  ('00000000-0000-4000-8000-000000000002', 'asset.assign', 'execute'),
  ('00000000-0000-4000-8000-000000000002', 'asset.maintain', 'execute'),
  ('00000000-0000-4000-8000-000000000002', 'peripheral.stock', 'export'),
  ('00000000-0000-4000-8000-000000000002', 'peripheral.receive', 'execute'),
  ('00000000-0000-4000-8000-000000000002', 'peripheral.issue', 'execute'),
  ('00000000-0000-4000-8000-000000000002', 'peripheral.loan', 'export'),
  ('00000000-0000-4000-8000-000000000002', 'master.person', 'create'),
  ('00000000-0000-4000-8000-000000000002', 'master.person', 'update');

-- 재고 관리자: 사용자·역할 관리와 감사 로그를 뺀 전부(제한 필드 포함)
INSERT INTO app.role_acl (role_id, resource_code, operation)
SELECT '00000000-0000-4000-8000-000000000003', o.resource_code, o.operation
FROM app.sys_resource_operation o
WHERE o.resource_code NOT IN ('admin.user', 'admin.user.password', 'admin.role', 'history.audit');
