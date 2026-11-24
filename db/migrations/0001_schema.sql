-- 0001_schema.sql
-- 전체 테이블(26개)과 공통 함수. 모든 객체는 app 스키마에 둔다.
-- (Supabase 데이터 API가 기본으로 노출하는 public 스키마를 쓰지 않는다.)

-- 앱 서버 전용 역할. 로그인 비밀번호는 scripts/set-app-password.mjs 로 따로 설정한다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stock_app') THEN
    CREATE ROLE stock_app NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ─────────────────────────── 공통 함수 ───────────────────────────

-- 요청 트랜잭션에 설정된 기업 ID. 설정되지 않았으면 NULL (= 어떤 행도 일치하지 않음).
CREATE FUNCTION app.ctx_company_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

-- 시스템 문맥 여부. 인증 처리와 시스템 관리자 작업에서만 켠다.
CREATE FUNCTION app.ctx_is_system() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'on' $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ─────────────────────────── 기업·계정 ───────────────────────────

CREATE TABLE app.company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  timezone    text NOT NULL DEFAULT 'Asia/Seoul',
  locale      text NOT NULL DEFAULT 'ko' CHECK (locale IN ('ko', 'en', 'zh')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_code_key UNIQUE (code)
);

CREATE TABLE app.app_user (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid REFERENCES app.company (id),
  login_id                  text NOT NULL CHECK (login_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$'),
  password_hash             text NOT NULL,
  email                     text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name              text NOT NULL CHECK (length(btrim(display_name)) > 0),
  user_type                 text NOT NULL CHECK (user_type IN ('SYSTEM_ADMIN', 'COMPANY_ADMIN', 'COMPANY_USER')),
  lang                      text NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko', 'en', 'zh')),
  is_active                 boolean NOT NULL DEFAULT true,
  must_change_password      boolean NOT NULL DEFAULT true,
  temp_password_expires_at  timestamptz,
  failed_count              integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until              timestamptz,
  password_changed_at       timestamptz,
  created_by                uuid REFERENCES app.app_user (id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- 시스템 관리자만 기업이 없다.
  CONSTRAINT app_user_type_company_chk CHECK ((user_type = 'SYSTEM_ADMIN') = (company_id IS NULL)),
  CONSTRAINT app_user_id_company_key UNIQUE (id, company_id)
);
-- 로그인 ID는 기업 안에서 고유하다(대소문자 무시). 비활성 계정도 포함하므로 재사용할 수 없다.
CREATE UNIQUE INDEX app_user_company_login_key ON app.app_user (company_id, lower(login_id)) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX app_user_system_login_key ON app.app_user (lower(login_id)) WHERE company_id IS NULL;

-- 비밀번호 해시는 인증 처리(시스템 문맥)에서만 읽을 수 있다.
-- 앱 역할에는 password_hash 컬럼의 SELECT 권한을 주지 않고(0002), 이 함수로만 읽게 한다.
CREATE FUNCTION app.auth_password_hash(p_user_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN app.ctx_is_system()
              THEN (SELECT u.password_hash FROM app.app_user u WHERE u.id = p_user_id)
         END
$$;

CREATE TABLE app.user_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app.app_user (id) ON DELETE CASCADE,
  token_hash    text NOT NULL,           -- 세션 토큰의 SHA-256. 토큰 원문은 저장하지 않는다.
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text,
  CONSTRAINT user_session_token_key UNIQUE (token_hash)
);
CREATE INDEX user_session_user_idx ON app.user_session (user_id) WHERE revoked_at IS NULL;

-- ─────────────────────────── 권한 ───────────────────────────

CREATE TABLE app.sys_resource (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_.]*$'),
  parent_code  text REFERENCES app.sys_resource (code),
  type         text NOT NULL CHECK (type IN ('MENU', 'PAGE', 'FIELD')),
  sort_order   integer NOT NULL DEFAULT 0
);

CREATE TABLE app.sys_resource_operation (
  resource_code  text NOT NULL REFERENCES app.sys_resource (code) ON DELETE CASCADE,
  operation      text NOT NULL CHECK (operation IN
                   ('read', 'create', 'update', 'delete', 'activate', 'deactivate', 'import', 'export', 'execute')),
  PRIMARY KEY (resource_code, operation)
);

CREATE TABLE app.role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES app.company (id),   -- NULL = 시스템 템플릿
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_id_company_key UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX role_company_name_key ON app.role (company_id, lower(name)) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX role_template_name_key ON app.role (lower(name)) WHERE company_id IS NULL;

CREATE TABLE app.role_acl (
  role_id        uuid NOT NULL REFERENCES app.role (id) ON DELETE CASCADE,
  resource_code  text NOT NULL,
  operation      text NOT NULL,
  PRIMARY KEY (role_id, resource_code, operation),
  -- 그 리소스에 정의된 동작만 허용 목록에 넣을 수 있다.
  FOREIGN KEY (resource_code, operation) REFERENCES app.sys_resource_operation (resource_code, operation) ON DELETE CASCADE
);

-- ─────────────────────────── 기준 정보 ───────────────────────────

CREATE TABLE app.department (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES app.company (id),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT department_id_company_key UNIQUE (id, company_id),
  -- 기본 부서(IT)는 비활성화할 수 없다.
  CONSTRAINT department_default_active_chk CHECK (NOT is_default OR is_active)
);
CREATE UNIQUE INDEX department_company_name_key ON app.department (company_id, lower(name));
CREATE UNIQUE INDEX department_one_default_key ON app.department (company_id) WHERE is_default;

-- 기본 부서(IT)는 기본 지정을 해제하거나 삭제할 수 없다. (관리 부서 기본값이 사라지는 것을 막는다)
CREATE FUNCTION app.protect_default_department() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_default AND (TG_OP = 'DELETE' OR NOT NEW.is_default) THEN
    RAISE EXCEPTION '기본 부서는 삭제하거나 기본 지정을 해제할 수 없습니다.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER department_protect_default BEFORE UPDATE OR DELETE ON app.department
  FOR EACH ROW EXECUTE FUNCTION app.protect_default_department();

-- 계정에 배정된 역할. 계정과 역할이 같은 기업이어야 한다(복합 외래키로 강제).
CREATE TABLE app.user_role (
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  company_id  uuid NOT NULL REFERENCES app.company (id),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id, company_id) REFERENCES app.app_user (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, company_id) REFERENCES app.role (id, company_id)
);

-- 계정의 부서 범위. 행이 없으면 전체 부서.
CREATE TABLE app.user_department_scope (
  user_id        uuid NOT NULL,
  department_id  uuid NOT NULL,
  company_id     uuid NOT NULL REFERENCES app.company (id),
  PRIMARY KEY (user_id, department_id),
  FOREIGN KEY (user_id, company_id) REFERENCES app.app_user (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id)
);

CREATE TABLE app.person (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  employee_no    text,
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  department_id  uuid,
  email          text,
  is_active      boolean NOT NULL DEFAULT true,
  anonymized_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_id_company_key UNIQUE (id, company_id),
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id)
);
CREATE UNIQUE INDEX person_company_empno_key ON app.person (company_id, lower(employee_no)) WHERE employee_no IS NOT NULL;
CREATE INDEX person_company_name_idx ON app.person (company_id, lower(name));

CREATE TABLE app.category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES app.company (id),
  kind        text NOT NULL CHECK (kind IN ('ASSET', 'PERIPHERAL')),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  name_ko     text,
  name_zh     text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_id_company_key UNIQUE (id, company_id),
  CONSTRAINT category_id_company_kind_key UNIQUE (id, company_id, kind)
);
CREATE UNIQUE INDEX category_company_name_key ON app.category (company_id, lower(name));

CREATE TABLE app.item_model (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES app.company (id),
  category_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ASSET', 'PERIPHERAL')),  -- 카테고리의 kind와 같아야 한다
  manufacturer  text NOT NULL CHECK (length(btrim(manufacturer)) > 0),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_model_id_company_key UNIQUE (id, company_id),
  CONSTRAINT item_model_id_company_kind_key UNIQUE (id, company_id, kind),
  FOREIGN KEY (category_id, company_id, kind) REFERENCES app.category (id, company_id, kind)
);
CREATE UNIQUE INDEX item_model_company_name_key ON app.item_model (company_id, lower(manufacturer), lower(name));
CREATE INDEX item_model_category_idx ON app.item_model (category_id);

CREATE TABLE app.custom_field_def (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label          text NOT NULL,
  data_type      text NOT NULL DEFAULT 'text' CHECK (data_type IN ('text', 'number', 'date', 'boolean')),
  is_restricted  boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_field_def_company_key UNIQUE (company_id, key)
);

-- 관리 부서가 비어 있으면 그 기업의 기본 부서(IT)를 넣는다.
CREATE FUNCTION app.fill_default_department() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.department_id IS NULL THEN
    SELECT d.id INTO NEW.department_id
      FROM app.department d
     WHERE d.company_id = NEW.company_id AND d.is_default;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────── 자산 ───────────────────────────

CREATE TABLE app.asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES app.company (id),
  model_id          uuid NOT NULL,
  model_kind        text NOT NULL DEFAULT 'ASSET' CHECK (model_kind = 'ASSET'),
  asset_tag         text NOT NULL CHECK (length(btrim(asset_tag)) > 0),
  serial_number     text,
  state             text NOT NULL,
  substate          text,
  department_id     uuid NOT NULL,
  location          text,
  holder_person_id  uuid,
  due_date          date,
  purchase_date     date,
  purchase_price    numeric(14, 2) CHECK (purchase_price IS NULL OR purchase_price >= 0),
  supplier          text,
  warranty_end      date,
  custom            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom) = 'object'),
  created_by        uuid REFERENCES app.app_user (id),
  updated_by        uuid REFERENCES app.app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_id_company_key UNIQUE (id, company_id),
  -- ASSET 카테고리의 모델만 참조할 수 있다.
  FOREIGN KEY (model_id, company_id, model_kind) REFERENCES app.item_model (id, company_id, kind),
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id),
  FOREIGN KEY (holder_person_id, company_id) REFERENCES app.person (id, company_id),
  -- 주의: CHECK 는 결과가 NULL 이어도 통과한다. substate 가 NULL 일 때 IN (...) 이 NULL 이 되지 않도록
  --       IS NOT NULL 을 함께 건다.
  CONSTRAINT asset_state_chk CHECK (
       (state = 'ON_ORDER'    AND substate IS NULL)
    OR (state = 'IN_STOCK'    AND substate IS NOT NULL AND substate IN ('AVAILABLE', 'RESERVED', 'DEFECTIVE'))
    OR (state = 'IN_USE'      AND substate IS NULL)
    OR (state = 'MAINTENANCE' AND substate IS NULL)
    OR (state = 'MISSING'     AND substate IS NULL)
    OR (state = 'RETIRED'     AND substate IS NOT NULL AND substate IN ('PENDING_DISPOSAL', 'DISPOSED', 'SOLD', 'DONATED'))
    OR (state = 'VOID'        AND substate IS NULL)
  ),
  -- 사용 중이면 보유자가 있어야 하고, 재고면 보유자가 없어야 한다.
  CONSTRAINT asset_holder_chk CHECK (
        (state <> 'IN_USE'   OR holder_person_id IS NOT NULL)
    AND (state <> 'IN_STOCK' OR holder_person_id IS NULL)
  )
);
-- 자산 태그는 기업 안에서 고유하다. 폐기·등록 취소된 자산의 태그도 재사용할 수 없다.
CREATE UNIQUE INDEX asset_company_tag_key ON app.asset (company_id, lower(asset_tag));
-- 시리얼 번호는 같은 모델 안에서만 고유하다.
CREATE UNIQUE INDEX asset_model_serial_key ON app.asset (company_id, model_id, lower(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX asset_company_state_idx ON app.asset (company_id, state, substate);
CREATE INDEX asset_company_dept_idx ON app.asset (company_id, department_id);
CREATE INDEX asset_holder_idx ON app.asset (holder_person_id) WHERE holder_person_id IS NOT NULL;

CREATE TRIGGER asset_fill_department BEFORE INSERT ON app.asset
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_department();

CREATE TABLE app.asset_txn (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES app.company (id),
  asset_id            uuid NOT NULL,
  type                text NOT NULL CHECK (type IN (
                        'REGISTER', 'RECEIVE', 'ASSIGN', 'LOAN', 'RETURN', 'RESERVE', 'UNRESERVE', 'MARK_DEFECTIVE',
                        'REPAIR_IN', 'REPAIR_OUT', 'MARK_MISSING', 'FOUND', 'RETIRE', 'DISPOSE', 'VOID',
                        'UPDATE', 'CHANGE_DEPARTMENT', 'IMPORT_UPDATE')),
  from_state          text,
  to_state            text,
  from_substate       text,
  to_substate         text,
  from_holder_id      uuid,
  to_holder_id        uuid,
  from_location       text,
  to_location         text,
  from_department_id  uuid,
  to_department_id    uuid,
  note                text,
  actor_id            uuid REFERENCES app.app_user (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, company_id) REFERENCES app.asset (id, company_id),
  FOREIGN KEY (from_holder_id, company_id) REFERENCES app.person (id, company_id),
  FOREIGN KEY (to_holder_id, company_id) REFERENCES app.person (id, company_id),
  FOREIGN KEY (from_department_id, company_id) REFERENCES app.department (id, company_id),
  FOREIGN KEY (to_department_id, company_id) REFERENCES app.department (id, company_id)
  -- actor_id 는 복합 외래키로 묶지 않는다: 시스템 관리자(company_id NULL)도 기업 안에서 작업한다.
  -- 대신 서버는 actor_id 를 항상 세션에서 가져오고 입력값으로 받지 않는다.
);
CREATE INDEX asset_txn_asset_idx ON app.asset_txn (asset_id, created_at DESC);
CREATE INDEX asset_txn_company_time_idx ON app.asset_txn (company_id, created_at DESC);

-- ─────────────────────────── 주변기기 ───────────────────────────

CREATE TABLE app.peripheral_stock (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  model_id       uuid NOT NULL,
  model_kind     text NOT NULL DEFAULT 'PERIPHERAL' CHECK (model_kind = 'PERIPHERAL'),
  department_id  uuid NOT NULL,
  on_hand_qty    integer NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
  on_loan_qty    integer NOT NULL DEFAULT 0 CHECK (on_loan_qty >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peripheral_stock_id_company_key UNIQUE (id, company_id),
  CONSTRAINT peripheral_stock_model_dept_key UNIQUE (company_id, model_id, department_id),
  FOREIGN KEY (model_id, company_id, model_kind) REFERENCES app.item_model (id, company_id, kind),
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id)
);

CREATE TRIGGER peripheral_stock_fill_department BEFORE INSERT ON app.peripheral_stock
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_department();

CREATE TABLE app.peripheral_loan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES app.company (id),
  stock_id      uuid NOT NULL,
  person_id     uuid NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  returned_qty  integer NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  lost_qty      integer NOT NULL DEFAULT 0 CHECK (lost_qty >= 0),
  due_date      date,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  loaned_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  CONSTRAINT peripheral_loan_id_company_key UNIQUE (id, company_id),
  FOREIGN KEY (stock_id, company_id) REFERENCES app.peripheral_stock (id, company_id),
  FOREIGN KEY (person_id, company_id) REFERENCES app.person (id, company_id),
  CONSTRAINT peripheral_loan_qty_chk CHECK (returned_qty + lost_qty <= qty),
  CONSTRAINT peripheral_loan_status_chk CHECK ((status = 'CLOSED') = (returned_qty + lost_qty = qty))
);
CREATE INDEX peripheral_loan_open_idx ON app.peripheral_loan (company_id, person_id) WHERE status = 'OPEN';

CREATE TABLE app.peripheral_txn (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  stock_id       uuid NOT NULL,
  type           text NOT NULL CHECK (type IN
                   ('INITIAL', 'RECEIVE', 'ISSUE', 'LOAN', 'RETURN', 'LOAN_LOSS', 'DISPOSE', 'ADJUST')),
  qty            integer NOT NULL CHECK (qty <> 0),
  person_id      uuid,
  loan_id        uuid,
  location_note  text,
  note           text,
  actor_id       uuid REFERENCES app.app_user (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (stock_id, company_id) REFERENCES app.peripheral_stock (id, company_id),
  FOREIGN KEY (person_id, company_id) REFERENCES app.person (id, company_id),
  FOREIGN KEY (loan_id, company_id) REFERENCES app.peripheral_loan (id, company_id)
);
CREATE INDEX peripheral_txn_stock_idx ON app.peripheral_txn (stock_id, created_at DESC);
CREATE INDEX peripheral_txn_company_time_idx ON app.peripheral_txn (company_id, created_at DESC);

-- ─────────────────────────── 한계수량·알림·메일 ───────────────────────────

CREATE TABLE app.stock_threshold (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  category_id    uuid,
  model_id       uuid,
  department_id  uuid,                     -- NULL = 기업 전체
  min_qty        integer NOT NULL CHECK (min_qty >= 0),
  warn_ratio     numeric(5, 2) NOT NULL DEFAULT 1.00 CHECK (warn_ratio >= 1.00),
  state          text NOT NULL DEFAULT 'OK' CHECK (state IN ('OK', 'LOW')),
  last_alert_at  timestamptz,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- 대상은 카테고리 또는 모델 중 정확히 하나다.
  CONSTRAINT stock_threshold_target_chk CHECK ((category_id IS NULL) <> (model_id IS NULL)),
  FOREIGN KEY (category_id, company_id) REFERENCES app.category (id, company_id),
  FOREIGN KEY (model_id, company_id) REFERENCES app.item_model (id, company_id),
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id)
);
CREATE UNIQUE INDEX stock_threshold_target_key ON app.stock_threshold
  (company_id, coalesce(category_id, model_id), coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE app.notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES app.company (id),
  user_id     uuid NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, company_id) REFERENCES app.app_user (id, company_id) ON DELETE CASCADE
);
CREATE INDEX notification_user_idx ON app.notification (user_id, created_at DESC);

CREATE TABLE app.mail_schedule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  frequency      text NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  days           integer[] NOT NULL DEFAULT '{}',
  send_time      time NOT NULL DEFAULT '09:00',
  timezone       text NOT NULL DEFAULT 'Asia/Seoul',
  content_type   text NOT NULL CHECK (content_type IN ('LOW_STOCK', 'STOCK_SUMMARY', 'OPEN_LOANS')),
  department_id  uuid,                     -- NULL = 기업 전체
  skip_if_empty  boolean NOT NULL DEFAULT true,
  lang           text NOT NULL DEFAULT 'ko' CHECK (lang IN ('ko', 'en', 'zh')),
  is_active      boolean NOT NULL DEFAULT false,
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_schedule_id_company_key UNIQUE (id, company_id),
  FOREIGN KEY (department_id, company_id) REFERENCES app.department (id, company_id)
);
CREATE INDEX mail_schedule_due_idx ON app.mail_schedule (next_run_at) WHERE is_active;

CREATE TABLE app.mail_recipient (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES app.company (id),
  schedule_id  uuid NOT NULL,
  user_id      uuid,
  email        text,
  CONSTRAINT mail_recipient_one_chk CHECK ((user_id IS NULL) <> (email IS NULL)),
  FOREIGN KEY (schedule_id, company_id) REFERENCES app.mail_schedule (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, company_id) REFERENCES app.app_user (id, company_id) ON DELETE CASCADE
);

CREATE TABLE app.mail_job (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES app.company (id),
  schedule_id    uuid NOT NULL,
  scheduled_for  timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
  attempts       integer NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  CONSTRAINT mail_job_id_company_key UNIQUE (id, company_id),
  -- 같은 스케줄의 같은 회차는 한 번만 만들어진다(중복 발송 방지).
  CONSTRAINT mail_job_once_key UNIQUE (schedule_id, scheduled_for),
  -- 발송 기록이 있는 스케줄은 지워지지 않는다(이력 보존). 스케줄 삭제 기능은 비활성화로 구현한다.
  FOREIGN KEY (schedule_id, company_id) REFERENCES app.mail_schedule (id, company_id)
);

CREATE TABLE app.mail_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES app.company (id),
  job_id      uuid,
  recipient   text NOT NULL,
  subject     text,
  status      text NOT NULL CHECK (status IN ('SENT', 'FAILED')),
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, company_id) REFERENCES app.mail_job (id, company_id)
);
CREATE INDEX mail_log_company_time_idx ON app.mail_log (company_id, sent_at DESC);

-- ─────────────────────────── 감사 ───────────────────────────

CREATE TABLE app.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  uuid REFERENCES app.company (id),   -- NULL = 시스템 수준 사건
  actor_id    uuid REFERENCES app.app_user (id),
  action      text NOT NULL,
  resource    text,
  target_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_company_time_idx ON app.audit_log (company_id, created_at DESC);

-- ─────────────────────────── updated_at 트리거 ───────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company', 'app_user', 'role', 'department', 'person', 'category', 'item_model',
                           'asset', 'peripheral_stock', 'stock_threshold', 'mail_schedule']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
                   t || '_touch', t);
  END LOOP;
END $$;
