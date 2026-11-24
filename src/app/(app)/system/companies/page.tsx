'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useShell, type Company } from '../../../shell';
import {
  api,
  Badge,
  Button,
  EmptyRow,
  ErrorText,
  LabeledField,
  Modal,
  Notice,
  PageHeader,
  smallInput,
  Table,
  td,
  TempPasswordDialog,
} from '../../../ui';

const T = {
  title: '기업 관리',
  noAccess: '권한이 없습니다.',
  add: '기업 추가',
  loading: '불러오는 중…',
  empty: '등록된 기업이 없습니다.',
  colCode: '기업코드',
  colName: '이름',
  colTz: '시간대',
  colLocale: '언어',
  colStatus: '상태',
  colCreated: '등록일',
  active: '활성',
  inactive: '비활성',
  formTitle: '기업 추가',
  fCode: '기업코드',
  fCodeHint: '영문·숫자·-·_ 2~32자. 사용자가 로그인할 때 입력합니다.',
  fName: '기업 이름',
  fTz: '시간대 (선택)',
  fTzHint: '예: Asia/Seoul. 비워 두면 서버 기본값을 씁니다.',
  fLocale: '기본 언어 (선택)',
  fLocaleDefault: '서버 기본값',
  adminSection: '첫 기업 관리자 계정',
  fAdminLogin: '관리자 로그인 ID',
  fAdminLoginHint: '영문·숫자·._@- 3~64자',
  fAdminName: '관리자 이름',
  fAdminEmail: '관리자 이메일 (선택)',
  cancel: '취소',
  create: '만들기',
  saving: '만드는 중…',
  createdTitle: '기업을 만들었습니다',
  createdNote: (code: string) => `기업코드 ${code} 의 첫 기업 관리자 계정입니다. 로그인할 때 기업코드와 함께 입력합니다.`,
};

const LOCALES: { value: 'ko' | 'en' | 'zh'; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

interface CreateResult {
  companyId: string;
  adminUserId: string;
  tempPassword: string;
}

export default function CompaniesPage() {
  const { me } = useShell();
  if (me.userType !== 'SYSTEM_ADMIN') return <Notice>{T.noAccess}</Notice>;
  return <CompaniesInner />;
}

function CompaniesInner() {
  const { reloadCompanies } = useShell();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  // 임시 비밀번호는 이 상태에만 두고, 대화상자를 닫으면 지운다.
  const [created, setCreated] = useState<{ code: string; loginId: string; password: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ companies: Company[] }>('GET', '/api/system/companies');
    if (r.ok) {
      setCompanies(r.data.companies);
      setLoadError('');
    } else if (!r.redirected) setLoadError(r.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader title={T.title} actions={<Button variant="primary" onClick={() => setFormOpen(true)}>{T.add}</Button>} />
      <ErrorText>{loadError}</ErrorText>
      {companies === null && !loadError ? <p style={{ color: '#6b7280' }}>{T.loading}</p> : null}
      {companies ? (
        <Table head={[T.colCode, T.colName, T.colTz, T.colLocale, T.colStatus, T.colCreated]}>
          {companies.length === 0 ? <EmptyRow colSpan={6}>{T.empty}</EmptyRow> : null}
          {companies.map((c) => (
            <tr key={c.id}>
              <td style={td}><code>{c.code}</code></td>
              <td style={td}>{c.name}</td>
              <td style={td}>{c.timezone}</td>
              <td style={td}>{c.locale}</td>
              <td style={td}>{c.is_active ? <Badge tone="green">{T.active}</Badge> : <Badge tone="gray">{T.inactive}</Badge>}</td>
              <td style={td}>{formatDate(c.created_at)}</td>
            </tr>
          ))}
        </Table>
      ) : null}

      {formOpen ? (
        <CompanyForm
          onClose={() => setFormOpen(false)}
          onCreated={(code, loginId, password) => {
            setFormOpen(false);
            setCreated({ code, loginId, password });
            void load();
            void reloadCompanies(); // 상단 바의 기업 선택 목록도 새로 고친다.
          }}
        />
      ) : null}

      {created ? (
        <TempPasswordDialog
          title={T.createdTitle}
          loginId={created.loginId}
          password={created.password}
          extra={<p style={{ fontSize: 14, marginTop: 0 }}>{T.createdNote(created.code)}</p>}
          onClose={() => setCreated(null)}
        />
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ko-KR');
}

function CompanyForm({ onClose, onCreated }: { onClose: () => void; onCreated: (code: string, loginId: string, password: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [locale, setLocale] = useState<'' | 'ko' | 'en' | 'zh'>('');
  const [adminLogin, setAdminLogin] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const r = await api<CreateResult>('POST', '/api/system/companies', {
      code: code.trim(),
      name,
      timezone: timezone.trim() || undefined,
      locale: locale || undefined,
      admin: { loginId: adminLogin.trim(), displayName: adminName, email: adminEmail.trim() || null },
    });
    setBusy(false);
    if (r.ok) onCreated(code.trim(), adminLogin.trim(), r.data.tempPassword);
    else if (!r.redirected) setError(r.error.message);
  }

  return (
    <Modal title={T.formTitle} onClose={onClose} width={540}>
      <form onSubmit={submit}>
        <LabeledField label={T.fCode} hint={T.fCodeHint}>
          {(id) => <input id={id} style={smallInput} value={code} onChange={(e) => setCode(e.target.value)} required minLength={2} maxLength={32} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fName}>
          {(id) => <input id={id} style={smallInput} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />}
        </LabeledField>
        <LabeledField label={T.fTz} hint={T.fTzHint}>
          {(id) => <input id={id} style={smallInput} value={timezone} onChange={(e) => setTimezone(e.target.value)} maxLength={64} autoComplete="off" />}
        </LabeledField>
        <LabeledField label={T.fLocale}>
          {(id) => (
            <select id={id} style={smallInput} value={locale} onChange={(e) => setLocale(e.target.value as '' | 'ko' | 'en' | 'zh')}>
              <option value="">{T.fLocaleDefault}</option>
              {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          )}
        </LabeledField>

        <fieldset style={{ border: '1px solid #e2e5ea', borderRadius: 6, padding: '8px 12px 0', margin: '4px 0 12px' }}>
          <legend style={{ fontSize: 13, color: '#4b5563', padding: '0 4px' }}>{T.adminSection}</legend>
          <LabeledField label={T.fAdminLogin} hint={T.fAdminLoginHint}>
            {(id) => <input id={id} style={smallInput} value={adminLogin} onChange={(e) => setAdminLogin(e.target.value)} required minLength={3} maxLength={64} autoComplete="off" />}
          </LabeledField>
          <LabeledField label={T.fAdminName}>
            {(id) => <input id={id} style={smallInput} value={adminName} onChange={(e) => setAdminName(e.target.value)} required maxLength={100} />}
          </LabeledField>
          <LabeledField label={T.fAdminEmail}>
            {(id) => <input id={id} type="email" style={smallInput} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} maxLength={200} autoComplete="off" />}
          </LabeledField>
        </fieldset>

        <ErrorText>{error}</ErrorText>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={busy}>{T.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? T.saving : T.create}</Button>
        </div>
      </form>
    </Modal>
  );
}
