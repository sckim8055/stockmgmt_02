-- 0002_rls_grants.sql
-- 앱 역할(stock_app)의 권한과 행 수준 보안(RLS).
--
-- 원칙
--  1) 앱 서버는 stock_app 으로만 접속한다. stock_app 은 테이블 소유자가 아니므로 RLS가 항상 적용된다.
--  2) 요청마다 트랜잭션 안에서 app.company_id (또는 app.system=on) 를 설정한다. 설정이 없으면 아무 행도 보이지 않는다.
--  3) 이력성 테이블은 INSERT/SELECT 만 준다. UPDATE/DELETE 권한 자체가 없다.
--
-- 한계: RLS는 서버 코드의 실수(기업 조건 누락)를 막는 2차 안전망이다.
--       서버 자체가 탈취되어 app.system=on 을 설정하는 경우까지 막지는 못한다.

-- ─────────────────────────── 기본 권한 정리 ───────────────────────────

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Supabase가 만들어 두는 브라우저용 역할이 있으면 명시적으로 회수한다.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────── stock_app 권한 ───────────────────────────

GRANT USAGE ON SCHEMA app TO stock_app;
GRANT EXECUTE ON FUNCTION app.ctx_company_id(), app.ctx_is_system() TO stock_app;

-- 읽기 전용 (시스템 정의 데이터)
GRANT SELECT ON app.sys_resource, app.sys_resource_operation TO stock_app;

-- 삭제 없음 (비활성화만)
GRANT SELECT, INSERT, UPDATE ON app.company, app.app_user, app.asset, app.person TO stock_app;

-- 추가만 가능 (이력·감사)
GRANT SELECT, INSERT ON app.asset_txn, app.peripheral_txn, app.audit_log, app.mail_log TO stock_app;

-- 일반
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.user_session, app.role, app.role_acl, app.user_role, app.user_department_scope,
  app.department, app.category, app.item_model, app.custom_field_def,
  app.peripheral_stock, app.peripheral_loan, app.stock_threshold, app.notification,
  app.mail_schedule, app.mail_recipient, app.mail_job
TO stock_app;

-- schema_migration 테이블은 stock_app 에게 주지 않는다.

-- ─────────────────────────── RLS ───────────────────────────

-- company_id 가 필수인 일반 테넌트 테이블
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'department', 'user_role', 'user_department_scope', 'person', 'category', 'item_model', 'custom_field_def',
    'asset', 'asset_txn', 'peripheral_stock', 'peripheral_loan', 'peripheral_txn',
    'stock_threshold', 'notification', 'mail_schedule', 'mail_recipient', 'mail_job', 'mail_log']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I FOR ALL TO stock_app
         USING (app.ctx_is_system() OR company_id = app.ctx_company_id())
         WITH CHECK (app.ctx_is_system() OR company_id = app.ctx_company_id())', t);
  END LOOP;
END $$;

-- company: 자기 기업 행만. 생성·수정은 시스템 문맥에서만.
ALTER TABLE app.company ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_read ON app.company FOR SELECT TO stock_app
  USING (app.ctx_is_system() OR id = app.ctx_company_id());
CREATE POLICY company_insert ON app.company FOR INSERT TO stock_app
  WITH CHECK (app.ctx_is_system());
CREATE POLICY company_update ON app.company FOR UPDATE TO stock_app
  USING (app.ctx_is_system()) WITH CHECK (app.ctx_is_system());

-- app_user: 자기 기업 계정만. 시스템 관리자(company_id NULL)는 시스템 문맥에서만 보인다.
ALTER TABLE app.app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.app_user FOR ALL TO stock_app
  USING (app.ctx_is_system() OR company_id = app.ctx_company_id())
  WITH CHECK (app.ctx_is_system() OR company_id = app.ctx_company_id());

-- user_session: 인증 모듈(시스템 문맥)에서만 접근한다.
ALTER TABLE app.user_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_only ON app.user_session FOR ALL TO stock_app
  USING (app.ctx_is_system()) WITH CHECK (app.ctx_is_system());

-- role: 자기 기업 역할은 읽기·쓰기, 시스템 템플릿(company_id NULL)은 읽기만.
ALTER TABLE app.role ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.role FOR ALL TO stock_app
  USING (app.ctx_is_system() OR company_id = app.ctx_company_id())
  WITH CHECK (app.ctx_is_system() OR company_id = app.ctx_company_id());
CREATE POLICY template_read ON app.role FOR SELECT TO stock_app
  USING (company_id IS NULL);

-- role_acl: 소속 역할을 따라간다.
ALTER TABLE app.role_acl ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.role_acl FOR ALL TO stock_app
  USING (app.ctx_is_system() OR EXISTS (
           SELECT 1 FROM app.role r WHERE r.id = role_acl.role_id AND r.company_id = app.ctx_company_id()))
  WITH CHECK (app.ctx_is_system() OR EXISTS (
           SELECT 1 FROM app.role r WHERE r.id = role_acl.role_id AND r.company_id = app.ctx_company_id()));
CREATE POLICY template_read ON app.role_acl FOR SELECT TO stock_app
  USING (EXISTS (SELECT 1 FROM app.role r WHERE r.id = role_acl.role_id AND r.company_id IS NULL));

-- audit_log: 자기 기업 로그만 읽고 쓴다. 수정·삭제 권한은 없다.
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON app.audit_log FOR SELECT TO stock_app
  USING (app.ctx_is_system() OR company_id = app.ctx_company_id());
CREATE POLICY audit_insert ON app.audit_log FOR INSERT TO stock_app
  WITH CHECK (app.ctx_is_system() OR company_id = app.ctx_company_id());

-- sys_resource / sys_resource_operation: 기업 데이터가 아니므로 RLS 없이 SELECT 권한만 준다.
