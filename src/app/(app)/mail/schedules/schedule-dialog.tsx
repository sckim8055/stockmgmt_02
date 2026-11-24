'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../../ui';
import { listOf, useList } from '../../assets/shared';
import type { DepartmentOption } from '../../assets/types';
import {
  CONTENT_HINT, CONTENT_LABEL, DEFAULT_TIMEZONE, FREQUENCY_LABEL, LANG_LABEL, MAX_NAME, MAX_RECIPIENTS, TIME_RE, TIMEZONE_LABEL, WEEKDAY_LABEL,
  type ContentType, type Frequency, type MailLang, type ScheduleRow,
} from '../labels';
import { draftFromRecipients, RecipientsField, type AccountOption, type RecipientDraft } from './recipients';

const T = {
  createTitle: '메일 일정 추가',
  editTitle: (n: string) => `메일 일정 수정 — ${n}`,
  fName: '이름',
  fContent: '내용',
  fDept: '부서',
  deptAll: '전체 (기업 전체 자료)',
  deptChoose: '선택하세요',
  deptScopedHint: '내 부서 범위 안의 부서만 고를 수 있습니다. 기업 전체 일정은 부서 범위 제한이 없는 사용자만 만들 수 있습니다.',
  deptHint: '정한 부서의 자료만 보냅니다. 만든 뒤에는 바꿀 수 없습니다.',
  deptUnavailableAll: '부서 목록을 볼 권한이 없어 기업 전체 일정만 만들 수 있습니다.',
  deptUnavailableScoped: '부서 목록을 볼 권한이 없고 기업 전체 일정도 만들 수 없어, 메일 일정을 추가할 수 없습니다.',
  deptFixed: (d: string) => `${d} — 부서는 만든 뒤에 바꿀 수 없습니다. 다른 부서로 보내려면 새 일정을 만드세요.`,
  all: '전체',
  fFrequency: '주기',
  fWeekdays: '요일',
  fMonthDays: '날짜',
  monthDaysHint: '29·30·31일처럼 그 날짜가 없는 달에는 보내지 않고 건너뜁니다.',
  fTime: '보내는 시각',
  fTimezone: '시간대',
  fLang: '메일 언어',
  fSkip: '보낼 내용이 없으면 보내지 않기',
  fSkipHint: '끄면 내용이 없어도 "해당하는 항목이 없습니다" 메일을 보냅니다.',
  nameRequired: '이름을 입력하세요.',
  daysRequiredWeekly: '요일을 하나 이상 고르세요.',
  daysRequiredMonthly: '날짜를 하나 이상 고르세요.',
  timeInvalid: '보내는 시각을 HH:MM 형식으로 입력하세요.',
  deptRequired: '부서를 고르세요.',
  tooMany: `받는 사람은 최대 ${MAX_RECIPIENTS}명입니다.`,
  createdOff: '일정은 꺼진 상태로 만들어집니다. 받는 사람을 정한 뒤 목록에서 켜세요.',
  nothingChanged: '바뀐 내용이 없습니다.',
  cancel: '취소',
  create: '추가',
  save: '저장',
  saving: '저장 중…',
};

const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[];
const CONTENTS = Object.keys(CONTENT_LABEL) as ContentType[];
const LANGS = Object.keys(LANG_LABEL) as MailLang[];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

const sameSet = (a: readonly (string | number)[], b: readonly (string | number)[]) => {
  const s = new Set(a);
  return new Set(b).size === s.size && b.every((v) => s.has(v));
};

function DayGrid({ legend, hint, values, labelOf, selected, onChange, columns }: {
  legend: string;
  hint?: string;
  values: number[];
  labelOf: (d: number) => string;
  selected: number[];
  onChange: (next: number[]) => void;
  columns: number;
}) {
  const set = new Set(selected);
  return (
    <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
      <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>{legend}</legend>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 4 }}>
        {values.map((d) => (
          <label key={d} style={{ fontSize: 14, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={set.has(d)}
              onChange={(e) => onChange(e.target.checked ? [...selected, d].sort((a, b) => a - b) : selected.filter((v) => v !== d))}
            />
            {labelOf(d)}
          </label>
        ))}
      </div>
      {hint ? <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{hint}</div> : null}
    </fieldset>
  );
}

export function ScheduleDialog({ schedule, onClose, onDone }: { schedule: ScheduleRow | null; onClose: () => void; onDone: () => void }) {
  const { can, perms } = useShell();
  const creating = schedule === null;
  const departments = useList<DepartmentOption>(creating && can('master.department', 'read') ? '/api/departments' : null, 'departments');
  const accounts = useList<AccountOption>(can('admin.user', 'read') ? '/api/admin/users' : null, 'users');
  const scope = perms.departmentScope;
  const allowAll = scope === null;
  const deptOptions = listOf(departments).filter((d) => d.is_active && (scope === null || scope.includes(d.id)));

  const [name, setName] = useState(schedule?.name ?? '');
  const [contentType, setContentType] = useState<ContentType>(schedule?.content_type ?? 'LOW_STOCK');
  const [departmentId, setDepartmentId] = useState('');
  const [frequency, setFrequency] = useState<Frequency>(schedule?.frequency ?? 'DAILY');
  // 주기를 바꿔도 각 주기에서 고른 값은 따로 기억한다(요일과 날짜는 뜻이 다르다).
  const [weekdays, setWeekdays] = useState<number[]>(schedule?.frequency === 'WEEKLY' ? schedule.days : [1]);
  const [monthDays, setMonthDays] = useState<number[]>(schedule?.frequency === 'MONTHLY' ? schedule.days : [1]);
  const [sendTime, setSendTime] = useState(schedule?.send_time ?? '09:00');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? DEFAULT_TIMEZONE);
  const [lang, setLang] = useState<MailLang>(schedule?.lang ?? 'ko');
  const [skipIfEmpty, setSkipIfEmpty] = useState(schedule?.skip_if_empty ?? true);
  const initialRecipients = schedule ? draftFromRecipients(schedule.recipients) : { userIds: [], emails: [] };
  const [recipients, setRecipients] = useState<RecipientDraft>(initialRecipients);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 시간대는 짧은 목록에서 고른다. 이 일정에 이미 다른 값이 있으면 그 값도 남겨 둔다.
  const timezones = Object.keys(TIMEZONE_LABEL);
  if (schedule && !timezones.includes(schedule.timezone)) timezones.push(schedule.timezone);

  const days = frequency === 'WEEKLY' ? weekdays : frequency === 'MONTHLY' ? monthDays : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const trimmed = name.trim();
    if (!trimmed) return setError(T.nameRequired);
    if (frequency === 'WEEKLY' && days.length === 0) return setError(T.daysRequiredWeekly);
    if (frequency === 'MONTHLY' && days.length === 0) return setError(T.daysRequiredMonthly);
    if (!TIME_RE.test(sendTime)) return setError(T.timeInvalid);
    if (recipients.userIds.length + recipients.emails.length > MAX_RECIPIENTS) return setError(T.tooMany);
    if (creating && !departmentId && !allowAll) return setError(T.deptRequired);

    let r;
    if (creating) {
      const body: Record<string, unknown> = {
        name: trimmed, frequency, sendTime, timezone, contentType, skipIfEmpty, lang, recipients,
        ...(frequency === 'DAILY' ? {} : { days }),
        ...(departmentId ? { departmentId } : {}),
      };
      setBusy(true);
      r = await api<{ scheduleId: string }>('POST', '/api/mail/schedules', body);
    } else {
      // 바뀐 것만 보낸다(감사 로그에 바뀐 값만 남도록). 주기나 요일·날짜가 바뀌면 둘을 함께 보낸다.
      const body: Record<string, unknown> = {};
      if (trimmed !== schedule.name) body.name = trimmed;
      if (contentType !== schedule.content_type) body.contentType = contentType;
      if (frequency !== schedule.frequency || !sameSet(days, schedule.days)) {
        body.frequency = frequency;
        if (frequency !== 'DAILY') body.days = days;
      }
      if (sendTime !== schedule.send_time) body.sendTime = sendTime;
      if (timezone !== schedule.timezone) body.timezone = timezone;
      if (lang !== schedule.lang) body.lang = lang;
      if (skipIfEmpty !== schedule.skip_if_empty) body.skipIfEmpty = skipIfEmpty;
      if (!sameSet(recipients.userIds, initialRecipients.userIds) || !sameSet(recipients.emails, initialRecipients.emails)) body.recipients = recipients;
      if (Object.keys(body).length === 0) return setError(T.nothingChanged);
      setBusy(true);
      r = await api<{ ok: true }>('PATCH', `/api/mail/schedules/${encodeURIComponent(schedule.id)}`, body);
    }
    setBusy(false);
    if (r.ok) onDone();
    else if (!r.redirected) setError(r.error.message);
  }

  if (creating && departments === 'denied' && !allowAll) {
    return (
      <Modal title={T.createTitle} onClose={onClose} width={480}>
        <Notice>{T.deptUnavailableScoped}</Notice>
      </Modal>
    );
  }

  return (
    <Modal title={creating ? T.createTitle : T.editTitle(schedule.name)} onClose={onClose} width={620}>
      <form onSubmit={submit}>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={MAX_NAME} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fContent} hint={CONTENT_HINT[contentType]}>
          {(id) => (
            <select id={id} style={smallInput} value={contentType} onChange={(e) => setContentType(e.target.value as ContentType)}>
              {CONTENTS.map((c) => <option key={c} value={c}>{CONTENT_LABEL[c]}</option>)}
            </select>
          )}
        </LabeledField>
        {creating ? (
          departments === 'denied' ? <Notice>{T.deptUnavailableAll}</Notice> : (
            <LabeledField label={T.fDept} hint={allowAll ? T.deptHint : `${T.deptScopedHint} ${T.deptHint}`}>
              {(id) => (
                <select id={id} style={smallInput} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required={!allowAll}>
                  {allowAll ? <option value="">{T.deptAll}</option> : <option value="" disabled>{T.deptChoose}</option>}
                  {deptOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}
            </LabeledField>
          )
        ) : (
          <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 12 }}>
            {T.fDept}
            <div style={{ fontSize: 14, color: '#1f2937', marginTop: 4 }}>{T.deptFixed(schedule.department_name ?? T.all)}</div>
          </div>
        )}

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 8px', fontSize: 14 }}>
          <legend style={{ fontSize: 13, color: '#4b5563', padding: 0, marginBottom: 4 }}>{T.fFrequency}</legend>
          {FREQUENCIES.map((f) => (
            <label key={f} style={{ marginRight: 16 }}>
              <input type="radio" name="frequency" value={f} checked={frequency === f} onChange={() => setFrequency(f)} /> {FREQUENCY_LABEL[f]}
            </label>
          ))}
        </fieldset>
        {frequency === 'WEEKLY' ? (
          <DayGrid legend={T.fWeekdays} values={WEEKDAYS} labelOf={(d) => WEEKDAY_LABEL[d] ?? String(d)} selected={weekdays} onChange={setWeekdays} columns={7} />
        ) : null}
        {frequency === 'MONTHLY' ? (
          <DayGrid legend={T.fMonthDays} hint={T.monthDaysHint} values={MONTH_DAYS} labelOf={(d) => `${d}일`} selected={monthDays} onChange={setMonthDays} columns={7} />
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <LabeledField label={T.fTime}>
            {(id) => <input id={id} type="time" step={60} style={smallInput} value={sendTime} onChange={(e) => setSendTime(e.target.value)} required />}
          </LabeledField>
          <LabeledField label={T.fTimezone}>
            {(id) => (
              <select id={id} style={smallInput} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones.map((z) => <option key={z} value={z}>{TIMEZONE_LABEL[z] ?? z}</option>)}
              </select>
            )}
          </LabeledField>
          <LabeledField label={T.fLang}>
            {(id) => (
              <select id={id} style={smallInput} value={lang} onChange={(e) => setLang(e.target.value as MailLang)}>
                {LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
            )}
          </LabeledField>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={skipIfEmpty} onChange={(e) => setSkipIfEmpty(e.target.checked)} />
          {T.fSkip}
        </label>
        <div style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 12px' }}>{T.fSkipHint}</div>

        <RecipientsField accounts={accounts} initial={schedule?.recipients ?? []} value={recipients} onChange={setRecipients} />
        {creating ? <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{T.createdOff}</p> : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || (creating && departments === null)}>{busy ? T.saving : creating ? T.create : T.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
