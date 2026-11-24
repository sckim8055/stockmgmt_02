'use client';
import { RequireCompany, useShell } from '../../shell';
import { Notice, PageHeader } from '../../ui';
import { ImportCard } from './import-card';
import { IMPORT_KINDS, KIND_INFO } from './labels';

const T = {
  title: '엑셀 업로드',
  rulesTitle: '올리기 전에 확인하세요',
  rules: [
    '"양식 내려받기"로 받은 파일의 첫 번째 시트에만 입력합니다. 다른 시트는 읽지 않습니다.',
    '머리글(1행)은 바꾸거나 지우지 마세요. 2행부터 한 행에 하나씩 입력합니다.',
    '한 번에 최대 2,000행, 파일 크기는 최대 5MB까지 올릴 수 있습니다.',
    '먼저 "검사"로 확인합니다. 한 행이라도 오류가 있으면 아무것도 반영되지 않습니다.',
    '이미 등록된 자산 태그·사번은 오류로 처리합니다. 기존 자료를 고치지(덮어쓰지) 않습니다.',
    '권장 순서: 직원 → 자산 → 주변기기. 자산 행의 보유자사번은 이미 등록된 직원의 사번이어야 합니다.',
  ],
  noPermission: '엑셀 업로드 권한이 없습니다.',
};

export default function ImportPage() {
  return (
    <RequireCompany>
      <ImportInner />
    </RequireCompany>
  );
}

function ImportInner() {
  const { can } = useShell();
  const kinds = IMPORT_KINDS.filter((k) => can(...KIND_INFO[k].permission));
  return (
    <div>
      <PageHeader title={T.title} />
      <section aria-label={T.rulesTitle} style={{ background: '#fff', border: '1px solid #e2e5ea', borderRadius: 8, padding: '12px 16px', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{T.rulesTitle}</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#374151', lineHeight: 1.7 }}>
          {T.rules.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </section>
      {kinds.length === 0 ? <Notice>{T.noPermission}</Notice> : null}
      <div style={{ display: 'grid', gap: 14 }}>
        {kinds.map((k) => <ImportCard key={k} kind={k} />)}
      </div>
    </div>
  );
}
