'use client';
import { useState, type FormEvent } from 'react';
import { useShell } from '../../../shell';
import { api, Button, ErrorText, LabeledField, Modal, Notice, smallInput } from '../../../ui';
import { listOf, useList } from '../../assets/shared';
import type { DepartmentOption } from '../../assets/types';
import { DEFAULT_TIMEZONE, MAIL_LANG_NAME, MAX_NAME, MAX_RECIPIENTS, TIME_RE, useMailLabels, type ContentType, type Frequency, type MailLang, type ScheduleRow } from '../labels';
import { draftFromRecipients, RecipientsField, type AccountOption, type RecipientDraft } from './recipients';
import { useT } from '../../../i18n';
import { TEXT } from './schedule-dialog.text';

const FREQUENCIES: Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
const CONTENTS: ContentType[] = ['LOW_STOCK', 'STOCK_SUMMARY', 'OPEN_LOANS'];
const LANGS = Object.keys(MAIL_LANG_NAME) as MailLang[];
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
    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', margin: '4px 0 12px' }}>
      <legend style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '0 4px' }}>{legend}</legend>
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
      {hint ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{hint}</div> : null}
    </fieldset>
  );
}

export function ScheduleDialog({ schedule, onClose, onDone }: { schedule: ScheduleRow | null; onClose: () => void; onDone: () => void }) {
  const M = useMailLabels();
  const T = useT(TEXT);
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
  const timezones = Object.keys(M.timezone);
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
        <LabeledField label={T.fContent} hint={M.contentHint[contentType]}>
          {(id) => (
            <select id={id} style={smallInput} value={contentType} onChange={(e) => setContentType(e.target.value as ContentType)}>
              {CONTENTS.map((c) => <option key={c} value={c}>{M.content[c]}</option>)}
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
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            {T.fDept}
            <div style={{ fontSize: 14, color: 'var(--text-primary)', marginTop: 4 }}>{T.deptFixed(schedule.department_name ?? T.all)}</div>
          </div>
        )}

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 8px', fontSize: 14 }}>
          <legend style={{ fontSize: 13, color: 'var(--text-secondary)', padding: 0, marginBottom: 4 }}>{T.fFrequency}</legend>
          {FREQUENCIES.map((f) => (
            <label key={f} style={{ marginRight: 16 }}>
              <input type="radio" name="frequency" value={f} checked={frequency === f} onChange={() => setFrequency(f)} /> {M.frequency[f]}
            </label>
          ))}
        </fieldset>
        {frequency === 'WEEKLY' ? (
          <DayGrid legend={T.fWeekdays} values={WEEKDAYS} labelOf={(d) => M.weekday[d] ?? String(d)} selected={weekdays} onChange={setWeekdays} columns={7} />
        ) : null}
        {frequency === 'MONTHLY' ? (
          <DayGrid legend={T.fMonthDays} hint={T.monthDaysHint} values={MONTH_DAYS} labelOf={M.monthDay} selected={monthDays} onChange={setMonthDays} columns={7} />
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <LabeledField label={T.fTime}>
            {(id) => <input id={id} type="time" step={60} style={smallInput} value={sendTime} onChange={(e) => setSendTime(e.target.value)} required />}
          </LabeledField>
          <LabeledField label={T.fTimezone}>
            {(id) => (
              <select id={id} style={smallInput} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezones.map((z) => <option key={z} value={z}>{M.timezone[z] ?? z}</option>)}
              </select>
            )}
          </LabeledField>
          <LabeledField label={T.fLang}>
            {(id) => (
              <select id={id} style={smallInput} value={lang} onChange={(e) => setLang(e.target.value as MailLang)}>
                {LANGS.map((l) => <option key={l} value={l}>{MAIL_LANG_NAME[l]}</option>)}
              </select>
            )}
          </LabeledField>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={skipIfEmpty} onChange={(e) => setSkipIfEmpty(e.target.checked)} />
          {T.fSkip}
        </label>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 12px' }}>{T.fSkipHint}</div>

        <RecipientsField accounts={accounts} initial={schedule?.recipients ?? []} value={recipients} onChange={setRecipients} />
        {creating ? <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>{T.createdOff}</p> : null}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || (creating && departments === null)}>{busy ? T.saving : creating ? T.create : T.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
