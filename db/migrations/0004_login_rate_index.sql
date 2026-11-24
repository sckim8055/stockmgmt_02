-- 0004_login_rate_index.sql
-- 로그인 실패 횟수 제한(IP 기준)을 감사 로그에서 세기 위한 인덱스.
CREATE INDEX audit_log_login_failed_ip_idx ON app.audit_log (ip, created_at DESC) WHERE action = 'LOGIN_FAILED';
