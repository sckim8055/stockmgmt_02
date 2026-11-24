'use client';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { getActiveLang, useT } from './i18n';
import { TEXT } from './ui.text';

// 0단계의 임시 화면 부품. 화면 디자인은 5단계에서 기존 스타일로 교체한다.
export const card: CSSProperties = {
  maxWidth: 380, margin: '10vh auto', padding: 28, background: '#fff', borderRadius: 10,
  boxShadow: '0 1px 4px rgba(0,0,0,.12)',
};
export const input: CSSProperties = {
  width: '100%', padding: '10px 12px', margin: '6px 0 14px', border: '1px solid #c9ced6', borderRadius: 6,
  boxSizing: 'border-box', fontSize: 15,
};
export const button: CSSProperties = {
  width: '100%', padding: '11px 12px', border: 0, borderRadius: 6, background: '#2563eb', color: '#fff',
  fontSize: 15, cursor: 'pointer',
};

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 13, color: '#4b5563' }}>
      {label}
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" style={{ color: '#b91c1c', fontSize: 14 }}>{children}</p>;
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

const BUTTON_VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: { background: '#2563eb', color: '#fff', border: '1px solid #2563eb' },
  secondary: { background: '#fff', color: '#1c1f23', border: '1px solid #c9ced6' },
  danger: { background: '#fff', color: '#b91c1c', border: '1px solid #f1b4b4' },
  link: { background: 'transparent', color: '#2563eb', border: '1px solid transparent' },
};

export function Button({
  variant = 'secondary',
  small,
  type = 'button',
  style,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant;
  small?: boolean;
  type?: 'button' | 'submit';
}) {
  const disabled = rest.disabled;
  return (
    <button
      type={type}
      style={{
        padding: small ? '4px 9px' : '8px 14px',
        fontSize: small ? 13 : 14,
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
        ...BUTTON_VARIANTS[variant],
        ...style,
      }}
      {...rest}
    />
  );
}

// ── 입력 ──
export const smallInput: CSSProperties = {
  width: '100%', padding: '7px 10px', margin: '4px 0 12px', border: '1px solid #c9ced6', borderRadius: 6,
  boxSizing: 'border-box', fontSize: 14, background: '#fff',
};

/** 입력과 라벨을 id 로 묶는다. children 은 id 를 받아 입력 요소를 그린다. */
export function LabeledField({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ fontSize: 13, color: '#4b5563' }}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <div style={{ fontSize: 12, color: '#6b7280', marginTop: -8, marginBottom: 12 }}>{hint}</div> : null}
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
    <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
      <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>{legend}</legend>
      {hint ? <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{hint}</div> : null}
      {options.length === 0 ? (
        <div style={{ fontSize: 13, color: '#6b7280' }}>{emptyText}</div>
      ) : (
        <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 4 }}>
          {options.map((o) => (
            <label key={o.value} style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', color: o.disabled ? '#9ca3af' : undefined }}>
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
export const table: CSSProperties = {
  width: '100%', borderCollapse: 'collapse', background: '#fff', fontSize: 14,
  border: '1px solid #e2e5ea',
};
export const th: CSSProperties = {
  textAlign: 'left', padding: '9px 10px', background: '#f0f2f5', borderBottom: '1px solid #e2e5ea',
  fontWeight: 600, fontSize: 13, color: '#374151', whiteSpace: 'nowrap',
};
export const td: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #eef0f3', verticalAlign: 'top' };

export function Table({ caption, head, children }: { caption?: string; head: ReactNode[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={table}>
        {caption ? <caption style={{ textAlign: 'left', padding: '0 0 6px', fontSize: 13, color: '#6b7280' }}>{caption}</caption> : null}
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
      <td colSpan={colSpan} style={{ ...td, textAlign: 'center', color: '#6b7280', padding: 20 }}>{children}</td>
    </tr>
  );
}

// ── 표시 ──
type BadgeTone = 'green' | 'gray' | 'red' | 'amber' | 'blue';
const BADGE_TONES: Record<BadgeTone, CSSProperties> = {
  green: { background: '#e7f6ec', color: '#166534' },
  gray: { background: '#eef0f3', color: '#4b5563' },
  red: { background: '#fdecec', color: '#991b1b' },
  amber: { background: '#fef6e4', color: '#92400e' },
  blue: { background: '#e8f0fe', color: '#1e40af' },
};
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 12, marginRight: 4, whiteSpace: 'nowrap', ...BADGE_TONES[tone] }}>
      {children}
    </span>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 6, padding: '12px 14px', fontSize: 14, color: '#374151' }}>
      {children}
    </p>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>{title}</h1>
      {actions ? <div style={{ display: 'flex', gap: 8 }}>{actions}</div> : null}
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
    boxRef.current?.focus();
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
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(17,24,39,.45)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto', zIndex: 50,
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ background: '#fff', borderRadius: 10, width: '100%', maxWidth: width, boxShadow: '0 8px 30px rgba(0,0,0,.2)', outline: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #eef0f3' }}>
          <h2 id={titleId} style={{ fontSize: 17, margin: 0 }}>{title}</h2>
          <Button variant="link" small onClick={onClose} aria-label={T.close}>{T.close}</Button>
        </div>
        <div style={{ padding: '14px 18px' }}>{children}</div>
        {footer ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid #eef0f3' }}>{footer}</div>
        ) : null}
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
      <label htmlFor={pwId} style={{ fontSize: 13, color: '#4b5563' }}>{T.tempPassword}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 12px' }}>
        <input
          id={pwId}
          readOnly
          value={password}
          onFocus={(e) => e.currentTarget.select()}
          autoComplete="off"
          spellCheck={false}
          style={{ ...smallInput, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 16, letterSpacing: 1 }}
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
      {copied ? <p role="status" style={{ fontSize: 13, color: '#166534', margin: '0 0 8px' }}>{copied}</p> : null}
      <div role="note" style={{ background: '#fef6e4', color: '#92400e', borderRadius: 6, padding: '10px 12px', fontSize: 13, lineHeight: 1.5 }}>
        {T.tempOnce}
        <br />
        {T.tempValidity}
      </div>
    </Modal>
  );
}
