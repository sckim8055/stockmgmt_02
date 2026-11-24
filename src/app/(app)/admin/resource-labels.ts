// 권한 리소스·동작의 화면 이름(현재 언어). 역할 관리 화면과 감사 로그 화면이 함께 쓴다. 문구는 resource-labels.text.ts 에 있다.
import { useLang, type Lang } from '../../i18n';
import { TEXT } from './resource-labels.text';

/** 동작 열. 순서는 화면 표시 순서다. */
export const OPERATIONS = ['read', 'create', 'update', 'delete', 'activate', 'deactivate', 'import', 'export', 'execute'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface ResourceLabels {
  op: Record<Operation, string>;
  /** 리소스 코드 → 이름. 목록에 없는 코드는 코드를 그대로 보여 준다. */
  label: (code: string) => string;
  /** 권한 리소스 코드(사전에 있는 순서) */
  codes: string[];
  /** 감사 로그의 리소스 이름(권한 리소스 + 감사 로그 전용 리소스) */
  auditLabel: (code: string) => string;
  /** 감사 로그 조건에 고를 수 있는 리소스: 권한 리소스(메뉴 제외) + 감사 로그 전용 */
  auditCodes: string[];
}

function build(t: (typeof TEXT)[Lang]): ResourceLabels {
  const resource: Record<string, string> = t.resource;
  const auditOnly: Record<string, string> = t.auditOnly;
  return {
    op: t.op,
    label: (code) => resource[code] ?? code,
    codes: Object.keys(resource),
    auditLabel: (code) => resource[code] ?? auditOnly[code] ?? code,
    auditCodes: [...Object.keys(resource).filter((c) => !c.startsWith('menu.')), ...Object.keys(auditOnly)],
  };
}

const LABELS: Record<Lang, ResourceLabels> = { ko: build(TEXT.ko), en: build(TEXT.en), zh: build(TEXT.zh) };

export function useResourceLabels(): ResourceLabels {
  return LABELS[useLang()];
}
