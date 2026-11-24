// 엑셀 업로드 종류별 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
// 양식 파일의 머리글·안내와 서버의 행 오류 메시지는 서버가 만들며 한국어다.
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    persons: {
      title: '직원',
      listLabel: '직원 목록 보기',
      templateFile: '직원_업로드_양식.xlsx',
      intro: '직원 명부를 한꺼번에 등록합니다. 없는 부서는 자동으로 만듭니다(부서 등록 권한 필요).',
    },
    assets: {
      title: '자산',
      listLabel: '자산 목록 보기',
      templateFile: '자산_업로드_양식.xlsx',
      intro: '자산을 한꺼번에 등록합니다. 보유자사번을 적으면 그 직원에게 배정된 상태로 등록합니다(자산 배정 권한 필요).',
    },
    peripherals: {
      title: '주변기기',
      listLabel: '주변기기 재고 보기',
      templateFile: '주변기기_업로드_양식.xlsx',
      intro: '주변기기 재고 수량을 한꺼번에 입고합니다. 수량은 현재 보유 수량에 더해집니다.',
    },
  },
  en: {
    persons: {
      title: 'Employees',
      listLabel: 'View employees',
      templateFile: 'employees_import_template.xlsx',
      intro: 'Register your employee directory in bulk. Departments that do not exist yet are created automatically (requires permission to create departments).',
    },
    assets: {
      title: 'Assets',
      listLabel: 'View assets',
      templateFile: 'assets_import_template.xlsx',
      intro: "Register assets in bulk. If you fill in the holder's employee number, the asset is registered as issued to that employee (requires permission to issue assets).",
    },
    peripherals: {
      title: 'Peripherals',
      listLabel: 'View peripheral stock',
      templateFile: 'peripherals_import_template.xlsx',
      intro: 'Receive peripheral stock in bulk. Quantities are added to the current stock on hand.',
    },
  },
  zh: {
    persons: {
      title: '员工',
      listLabel: '查看员工列表',
      templateFile: '员工导入模板.xlsx',
      intro: '批量登记员工名册。不存在的部门会自动创建（需要部门登记权限）。',
    },
    assets: {
      title: '资产',
      listLabel: '查看资产列表',
      templateFile: '资产导入模板.xlsx',
      intro: '批量登记资产。填写持有人工号后，资产将以已发放给该员工的状态登记（需要资产发放权限）。',
    },
    peripherals: {
      title: '外设',
      listLabel: '查看外设库存',
      templateFile: '外设导入模板.xlsx',
      intro: '批量入库外设库存。数量将累加到当前在库数量上。',
    },
  },
});
