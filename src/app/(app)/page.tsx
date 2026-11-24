'use client';
import { useShell } from '../shell';
import { Notice, USER_TYPE_LABEL } from '../ui';

const T = {
  title: 'StockMgmt',
  welcome: (name: string) => `${name}님, 환영합니다.`,
  type: '계정 유형',
  company: '소속 기업',
  actingCompany: '작업 중인 기업',
  none: '선택 안 됨',
  pickCompany: '시스템 관리자는 기업을 선택해야 사용자·역할 관리 화면을 쓸 수 있습니다. 상단 바에서 작업할 기업을 고르세요.',
  actingNote: '선택한 기업 안에서 기업 관리자와 같은 권한으로 작업합니다. 기업 진입은 그 기업의 감사 로그에 남습니다.',
  phase: '1단계: 사용자·역할 관리까지 구현된 상태입니다. 업무 화면은 다음 단계에서 추가됩니다.',
};

export default function HomePage() {
  const { me, companies } = useShell();
  const acting = me.actingCompanyId ? companies.find((c) => c.id === me.actingCompanyId) : undefined;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>{T.title}</h1>
      <p>{T.welcome(me.displayName)}</p>
      <dl style={{ display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 6, fontSize: 14, background: '#fff', border: '1px solid #e2e5ea', borderRadius: 6, padding: '12px 14px' }}>
        <dt style={{ color: '#6b7280' }}>{T.type}</dt>
        <dd style={{ margin: 0 }}>{USER_TYPE_LABEL[me.userType] ?? me.userType}</dd>
        {me.userType === 'SYSTEM_ADMIN' ? (
          <>
            <dt style={{ color: '#6b7280' }}>{T.actingCompany}</dt>
            <dd style={{ margin: 0 }}>
              {acting ? `${acting.name} (${acting.code})` : me.actingCompanyId ?? T.none}
            </dd>
          </>
        ) : (
          <>
            <dt style={{ color: '#6b7280' }}>{T.company}</dt>
            <dd style={{ margin: 0 }}>{me.company && me.companyId ? `${me.company.name} (${me.company.code})` : '-'}</dd>
          </>
        )}
      </dl>
      {me.userType === 'SYSTEM_ADMIN' ? <Notice>{me.actingCompanyId ? T.actingNote : T.pickCompany}</Notice> : null}
      <p style={{ fontSize: 13, color: '#4b5563' }}>{T.phase}</p>
    </div>
  );
}
