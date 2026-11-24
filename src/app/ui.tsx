'use client';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { getActiveLang, useT } from './i18n';
import { TEXT } from './ui.text';

// 로그인 전 화면(로그인·비밀번호 변경)의 부품. 색과 모양은 globals.css 의 토큰·클래스가 정한다.
// 예전처럼 style 로도 쓸 수 있게 객체를 남겨 두되 색은 토큰(var(--…))만 쓴다.
export const card: CSSProperties = {
  maxWidth: 400, margin: '10vh auto', padding: 28, background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-modal)',
};
export const input: CSSProperties = {
  width: '100%', padding: '10px 12px', margin: '6px 0 14px', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box', fontSize: 15,
};
export const button: CSSProperties = {
  width: '100%', padding: '11px 12px', border: 0, borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(135deg, var(--accent-blue-strong), var(--accent-purple-strong))', color: 'var(--text-on-accent)',
  fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
/** 로그인 전 화면의 카드·입력·버튼 클래스(globals.css) */
export const authCardClass = 'auth-card';
export const authInputClass = 'auth-input';
export const authButtonClass = 'btn btn--primary btn--block';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="error-text">{children}</p>;
}

/**
 * 로그인 전 화면(로그인·비밀번호 변경)의 POST. api() 와 달리 401 에서 로그인 화면으로 보내지 않는다.
 * 실패하면 서버의 메시지를 돌려주고, 메시지가 없으면 null(화면이 자기 문구를 쓴다)이다.
 */
export async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: networkError() };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (res.ok) return { ok: true, data: raw as T };
  const e = readError(raw);
  return { ok: false, message: e && e.message !== fallbackError() ? e.message : null };
}

// ───────────────────────── 1단계 관리 화면 공용 부품 ─────────────────────────

export type UserType = 'SYSTEM_ADMIN' | 'COMPANY_ADMIN' | 'COMPANY_USER';

/** 계정 유형의 화면 이름(현재 언어) */
export function useUserTypeLabel(): Record<UserType, string> {
  return useT(TEXT).userType;
}

export interface ApiError {
  code: string;
  message: string;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      error: ApiError;
      redirected: boolean;
      /** 오류 응답 본문 전체. 오류와 함께 내려오는 추가 정보(예: 직원 퇴사 거부 시 보유 수량)를 읽을 때 쓴다. */
      raw?: unknown;
    };

// 서버가 메시지를 주지 않았을 때의 문구. 부를 때의 화면 언어로 만든다.
const fallbackError = () => TEXT[getActiveLang()].fallbackError;
const networkError = () => TEXT[getActiveLang()].network;

// 이 화면이 보고 있는 기업. 기업 데이터 API를 부를 때 확인용 헤더로 보낸다.
// 시스템 관리자가 다른 탭에서 기업을 바꾸면 서버가 409(COMPANY_CHANGED)로 거부해,
// 이 탭의 요청이 엉뚱한 기업에 적용되지 않는다. 기업 자체는 서버가 세션으로만 정한다.
let expectedCompany: string | null = null;
export function setExpectedCompany(companyId: string | null): void {
  expectedCompany = companyId;
}
// 기업과 무관한 API(내 정보, 인증, 시스템 관리)에는 헤더를 붙이지 않는다.
const COMPANY_NEUTRAL = ['/api/me', '/api/auth/', '/api/system/'];

function readError(raw: unknown): ApiError | null {
  if (typeof raw !== 'object' || raw === null || !('error' in raw)) return null;
  const e = (raw as { error: unknown }).error;
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  const message = (e as { message?: unknown }).message;
  return {
    code: typeof code === 'string' ? code : 'UNKNOWN',
    message: typeof message === 'string' && message ? message : fallbackError(),
  };
}

/**
 * 같은 출처의 JSON API 호출. 쿠키는 자동으로 실린다.
 * 401 은 로그인 화면으로, 비밀번호 변경 강제(403 PASSWORD_CHANGE_REQUIRED)는 변경 화면으로 보낸다.
 * 응답 형식은 서버가 정한 타입을 그대로 믿는다(서버가 유일한 판정자다).
 */
export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(expectedCompany && !COMPANY_NEUTRAL.some((p) => url.startsWith(p)) ? { 'x-expected-company': expectedCompany } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: networkError() }, redirected: false };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (res.ok) return { ok: true, status: res.status, data: raw as T };

  const error = readError(raw) ?? { code: 'HTTP_' + res.status, message: fallbackError() };
  if (res.status === 401) {
    window.location.href = '/login';
    return { ok: false, status: res.status, error, redirected: true };
  }
  if (res.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.location.href = '/change-password';
    return { ok: false, status: res.status, error, redirected: true };
  }
  return { ok: false, status: res.status, error, redirected: false, raw };
}

// ── 파일 올리기·내려받기 ──
// api() 와 같은 규칙(기업 확인 헤더, 401·비밀번호 변경 강제 이동, 오류 형식)을 따른다.

function companyHeader(url: string): Record<string, string> {
  return expectedCompany && !COMPANY_NEUTRAL.some((p) => url.startsWith(p)) ? { 'x-expected-company': expectedCompany } : {};
}

const networkFailure = () => ({ ok: false, status: 0, error: { code: 'NETWORK', message: networkError() }, redirected: false }) as const;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null; // 본문 없음
  }
}

/** 실패 응답을 api() 와 같은 형식으로 바꾼다. */
function failure(status: number, raw: unknown): Extract<ApiResult<never>, { ok: false }> {
  const error = readError(raw) ?? { code: 'HTTP_' + status, message: fallbackError() };
  if (status === 401) {
    window.location.href = '/login';
    return { ok: false, status, error, redirected: true };
  }
  if (status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.location.href = '/change-password';
    return { ok: false, status, error, redirected: true };
  }
  return { ok: false, status, error, redirected: false, raw };
}

/** 파일을 요청 본문 그대로(application/octet-stream) 보내고 JSON 응답을 받는다. */
export async function apiUpload<T>(url: string, file: Blob): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...companyHeader(url) },
      body: file,
      cache: 'no-store',
    });
  } catch {
    return networkFailure();
  }
  const raw = await readJson(res);
  return res.ok ? { ok: true, status: res.status, data: raw as T } : failure(res.status, raw);
}

/** GET 응답(파일)을 받아 브라우저에 fileName 으로 저장한다. */
export async function apiDownload(url: string, fileName: string): Promise<ApiResult<null>> {
  let res: Response;
  let blob: Blob;
  try {
    res = await fetch(url, { method: 'GET', headers: companyHeader(url), cache: 'no-store' });
    if (!res.ok) return failure(res.status, await readJson(res));
    blob = await res.blob();
  } catch {
    return networkFailure();
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 클릭으로 저장이 시작된 뒤에 주소를 풀어 준다.
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return { ok: true, status: res.status, data: null };
}

// ── 버튼 ──
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link';

// 모양은 globals.css 의 .btn 클래스가 정한다(hover·초점·사용 불가 상태 포함).
export function Button({
  variant = 'secondary',
  small,
  type = 'button',
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant;
  small?: boolean;
  type?: 'button' | 'submit';
}) {
  const cls = ['btn', `btn--${variant}`, small ? 'btn--small' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type={type} className={cls} {...rest} />;
}

// ── 입력 ──
// 크기·간격만 준다. 색·경계·hover·초점은 globals.css 의 input/select/textarea 기본 스타일이 정한다.
export const smallInput: CSSProperties = {
  width: '100%', padding: '7px 10px', margin: '4px 0 12px', borderRadius: 'var(--radius-sm)',
  boxSizing: 'border-box', fontSize: 14,
};

/** 입력과 라벨을 id 로 묶는다. children 은 id 를 받아 입력 요소를 그린다. */
export function LabeledField({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
}

export interface CheckOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 여러 개를 고르는 체크박스 목록. fieldset/legend 로 묶는다. */
export function CheckboxList({
  legend,
  options,
  selected,
  onChange,
  emptyText,
  hint,
}: {
  legend: string;
  options: CheckOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyText: string;
  hint?: string;
}) {
  const set = new Set(selected);
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      {hint ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{hint}</div> : null}
      {options.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{emptyText}</div>
      ) : (
        <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 4, padding: 2 }}>
          {options.map((o) => (
            <label key={o.value} className={o.disabled ? 'check-row is-disabled' : 'check-row'}>
              <input
                type="checkbox"
                checked={set.has(o.value)}
                disabled={o.disabled}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

// ── 표 ──
// 표의 테두리·바탕·행 hover·줄무늬는 globals.css 의 .table-wrap / .data-table 이 정한다.
export const table: CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 14,
};
export const th: CSSProperties = {
  textAlign: 'left', padding: '10px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
  fontWeight: 600, fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', letterSpacing: '0.02em',
};
export const td: CSSProperties = { padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' };

export function Table({ caption, head, children }: { caption?: string; head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="data-table" style={table}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', padding: 22 }}>{children}</td>
    </tr>
  );
}

// ── 표시 ──
// 상태 색은 화면 전체에서 같다: green=정상·완료, blue=사용 중·진행, amber=주의, red=위험·연체·부족, gray=비활성.
export type BadgeTone = 'green' | 'gray' | 'red' | 'amber' | 'blue';
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <h1 className="page-header__title">{title}</h1>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}

// ── 대화상자 ──
/**
 * 모달 대화상자. 닫기 버튼과 Esc 로 닫는다. 열릴 때 대화상자에 초점을 옮긴다.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const T = useT(TEXT);
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // 긴 대화상자가 열리자마자 아래로 밀려 제목이 가려지지 않게 스크롤하지 않고 초점만 옮긴다.
    boxRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="modal-overlay">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="modal"
        style={{ maxWidth: width }}
      >
        <div className="modal__header">
          <h2 id={titleId} className="modal__title">{title}</h2>
          <Button variant="link" small onClick={onClose} aria-label={T.close}>{T.close}</Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 확인 대화상자. onConfirm 이 오류 메시지를 돌려주면 대화상자 안에 보여 준다. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const T = useT(TEXT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              const err = await onConfirm();
              setBusy(false);
              if (err) setError(err);
            }}
          >
            {busy ? T.processing : confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 14 }}>{message}</div>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/**
 * 임시 비밀번호를 한 번만 보여 주는 대화상자.
 * 값은 부모 상태에만 있고, 닫으면 부모가 상태에서 지운다. 저장소(localStorage 등)에 남기지 않는다.
 */
export function TempPasswordDialog({
  title,
  loginId,
  extra,
  password,
  onClose,
}: {
  title: string;
  loginId: string;
  extra?: ReactNode;
  password: string;
  onClose: () => void;
}) {
  const T = useT(TEXT);
  const [copied, setCopied] = useState('');
  const pwId = useId();
  return (
    <Modal title={title} onClose={onClose} width={460} footer={<Button variant="primary" onClick={onClose}>{T.tempAck}</Button>}>
      {extra}
      <p style={{ fontSize: 14, margin: '0 0 6px' }}>{T.tempLoginId}: <strong>{loginId}</strong></p>
      <label htmlFor={pwId} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{T.tempPassword}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
        <input
          id={pwId}
          readOnly
          value={password}
          onFocus={(e) => e.currentTarget.select()}
          autoComplete="off"
          spellCheck={false}
          style={{ ...smallInput, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 16, letterSpacing: 1 }}
        />
        <Button
          small
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(T.copied);
            } catch {
              setCopied(T.copyFailed);
            }
          }}
        >
          {T.copy}
        </Button>
      </div>
      {copied ? <p role="status" style={{ fontSize: 13, color: 'var(--success-text)', margin: '0 0 8px' }}>{copied}</p> : null}
      <div role="note" className="callout callout--warning">
        {T.tempOnce}
        <br />
        {T.tempValidity}
      </div>
    </Modal>
  );
}
