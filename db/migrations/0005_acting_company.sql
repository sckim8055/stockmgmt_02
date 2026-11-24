-- 0005_acting_company.sql
-- 시스템 관리자는 어느 기업에도 속하지 않는다. 기업의 데이터를 보려면 세션에서 기업을 하나 고른다.
-- 고른 기업은 세션에 저장되고, 그 접근은 해당 기업의 감사 로그에 남는다.
ALTER TABLE app.user_session ADD COLUMN acting_company_id uuid REFERENCES app.company (id);

-- 세션 폐기 함수.
-- user_session 은 시스템 문맥에서만 보이므로, 기업 문맥의 관리 기능(비활성화, 임시 비밀번호 발급)에서는
-- 대상 계정의 세션을 직접 끊을 수 없다. 이 함수는 "자기 기업 계정의 세션 폐기"만 기업 문맥에 허용한다.
-- 다른 기업 계정이나 시스템 관리자를 지정하면 아무것도 하지 않는다.
CREATE FUNCTION app.revoke_user_sessions(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE n integer;
BEGIN
  IF NOT app.ctx_is_system() AND NOT EXISTS (
       SELECT 1 FROM app.app_user u
        WHERE u.id = p_user_id AND u.company_id IS NOT NULL AND u.company_id = app.ctx_company_id()) THEN
    RETURN 0;
  END IF;
  UPDATE app.user_session SET revoked_at = now() WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.revoke_user_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_user_sessions(uuid) TO stock_app;
