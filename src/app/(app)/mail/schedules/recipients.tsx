'use client';
// 메일 받는 사람 고르기: 기업 계정(이메일이 있는 활성 계정) + 직접 적은 이메일 주소.
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, CheckboxList, ErrorText, Notice, smallInput } from '../../../ui';
import type { Loaded } from '../../assets/shared';
import { EMAIL_RE, MAX_EMAIL, MAX_RECIPIENTS, type ScheduleRecipient } from '../labels';

const T = {
  legend: '받는 사람',
  count: (n: number) => `${n} / ${MAX_RECIPIENTS}명`,
  accounts: '계정',
  accountsHint: '이메일이 등록된 활성 계정만 고를 수 있습니다.',
  accountsEmpty: '고를 수 있는 계정이 없습니다.',
  accountsLoading: '계정 목록을 불러오는 중…',
  accountsDenied: '계정 목록을 볼 권한(사용자 관리 조회)이 없어 계정을 새로 고를 수 없습니다. 이메일 주소를 직접 입력하세요.',
  accountUnavailable: '(지금은 고를 수 없음: 비활성이거나 이메일 없음)',
  filter: '계정 찾기',
  filterPlaceholder: '이름·로그인 ID·이메일',
  current: '지금 받는 계정',
  emails: '이메일 주소 직접 입력',
  emailPlaceholder: 'name@example.com',
  add: '추가',
  remove: (v: string) => `${v} 빼기`,
  emailInvalid: '이메일 주소 형식이 올바르지 않습니다.',
  emailTooLong: `이메일 주소는 ${MAX_EMAIL}자까지입니다.`,
  emailDup: '이미 추가한 주소입니다.',
  tooMany: `받는 사람은 최대 ${MAX_RECIPIENTS}명입니다.`,
};

export interface AccountOption {
  id: string;
  login_id: string;
  display_name: string;
  email: string | null;
  is_active: boolean;
}

export interface RecipientDraft {
  userIds: string[];
  emails: string[];
}

export function draftFromRecipients(list: ScheduleRecipient[]): RecipientDraft {
  return {
    userIds: list.flatMap((r) => (r.userId ? [r.userId] : [])),
    emails: list.flatMap((r) => (!r.userId && r.email ? [r.email] : [])),
  };
}

const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 9px', borderRadius: 12, background: '#eef0f3', fontSize: 13, margin: '0 6px 6px 0' } as const;

export function RecipientsField({
  accounts,
  initial,
  value,
  onChange,
}: {
  accounts: Loaded<AccountOption>;
  /** 수정할 때 원래 받는 사람(계정 이름 표시용) */
  initial: ScheduleRecipient[];
  value: RecipientDraft;
  onChange: (next: RecipientDraft) => void;
}) {
  const emailId = useId();
  const filterId = useId();
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState('');
  const [filter, setFilter] = useState('');
  const total = value.userIds.length + value.emails.length;
  const full = total >= MAX_RECIPIENTS;
  const selected = new Set(value.userIds);

  function addEmail() {
    const v = emailInput.trim().toLowerCase();
    if (!v) return;
    if (v.length > MAX_EMAIL) return setEmailError(T.emailTooLong);
    if (!EMAIL_RE.test(v)) return setEmailError(T.emailInvalid);
    if (value.emails.includes(v)) return setEmailError(T.emailDup);
    if (full) return setEmailError(T.tooMany);
    onChange({ ...value, emails: [...value.emails, v] });
    setEmailInput('');
    setEmailError('');
  }
  function onEmailKey(e: KeyboardEvent<HTMLInputElement>) {
    // Enter 로 폼이 제출되지 않게 하고 주소를 추가한다.
    if (e.key === 'Enter') {
      e.preventDefault();
      addEmail();
    }
  }

  const initialName = new Map(initial.flatMap((r) => (r.userId ? [[r.userId, `${r.name ?? r.userId}${r.email ? ` <${r.email}>` : ''}`] as const] : [])));

  let accountPart: ReactNode;
  if (accounts === 'denied') {
    // 고를 수는 없지만, 이미 받는 계정은 보여 주고 뺄 수 있게 한다(저장할 때 그대로 보낸다).
    accountPart = (
      <>
        <Notice>{T.accountsDenied}</Notice>
        {value.userIds.length > 0 ? (
          <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 8 }}>
            <div style={{ marginBottom: 4 }}>{T.current}</div>
            {value.userIds.map((id) => (
              <span key={id} style={chip}>
                {initialName.get(id) ?? id}
                <Button small variant="link" aria-label={T.remove(initialName.get(id) ?? id)} onClick={() => onChange({ ...value, userIds: value.userIds.filter((u) => u !== id) })}>×</Button>
              </span>
            ))}
          </div>
        ) : null}
      </>
    );
  } else if (accounts === null) {
    accountPart = <p style={{ fontSize: 13, color: '#6b7280' }}>{T.accountsLoading}</p>;
  } else {
    const eligible = accounts.filter((a) => a.is_active && a.email);
    const eligibleIds = new Set(eligible.map((a) => a.id));
    const f = filter.trim().toLowerCase();
    const match = (a: AccountOption) => !f || `${a.display_name} ${a.login_id} ${a.email ?? ''}`.toLowerCase().includes(f);
    const options = [
      ...eligible.filter((a) => selected.has(a.id) || match(a)).map((a) => ({
        value: a.id,
        label: `${a.display_name} (${a.login_id}) <${a.email}>`,
        disabled: full && !selected.has(a.id),
      })),
      // 이미 받는 계정이 그사이 비활성이 되었거나 이메일이 지워졌으면, 빼기만 할 수 있게 남겨 둔다.
      ...value.userIds.filter((id) => !eligibleIds.has(id)).map((id) => ({ value: id, label: `${initialName.get(id) ?? id} ${T.accountUnavailable}` })),
    ];
    accountPart = (
      <>
        {eligible.length > 8 ? (
          <div style={{ fontSize: 13, color: '#4b5563' }}>
            <label htmlFor={filterId}>{T.filter}</label>
            <input id={filterId} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={T.filterPlaceholder} autoComplete="off" style={{ ...smallInput, margin: '4px 0 4px' }} />
          </div>
        ) : null}
        <CheckboxList
          legend={T.accounts}
          hint={T.accountsHint}
          options={options}
          selected={value.userIds}
          onChange={(userIds) => onChange({ ...value, userIds })}
          emptyText={T.accountsEmpty}
        />
      </>
    );
  }

  return (
    <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
      <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>
        {T.legend} <span style={{ color: full ? '#b91c1c' : '#6b7280' }}>({T.count(total)})</span>
      </legend>
      {accountPart}
      <div style={{ fontSize: 13, color: '#4b5563' }}>
        <label htmlFor={emailId}>{T.emails}</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 6px' }}>
          <input
            id={emailId}
            type="text"
            inputMode="email"
            autoComplete="off"
            value={emailInput}
            maxLength={MAX_EMAIL}
            placeholder={T.emailPlaceholder}
            onChange={(e) => { setEmailInput(e.target.value); setEmailError(''); }}
            onKeyDown={onEmailKey}
            style={{ ...smallInput, margin: 0 }}
            aria-invalid={emailError ? true : undefined}
          />
          <Button small onClick={addEmail} disabled={full || !emailInput.trim()}>{T.add}</Button>
        </div>
        <ErrorText>{emailError}</ErrorText>
        <div>
          {value.emails.map((m) => (
            <span key={m} style={chip}>
              {m}
              <Button small variant="link" aria-label={T.remove(m)} onClick={() => onChange({ ...value, emails: value.emails.filter((x) => x !== m) })}>×</Button>
            </span>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
