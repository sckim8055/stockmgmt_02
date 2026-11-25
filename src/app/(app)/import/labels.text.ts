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
    workbook: {
      title: '통합 파일 (직원·자산·주변기기)',
      listLabel: '자산 목록 보기',
      templateFile: '통합_업로드_양식.xlsx',
      intro: '직원·자산·주변기기 시트가 든 파일 하나를 한 번에 올립니다. 직원 → 자산 → 주변기기 순서로 처리하므로, 자산의 보유자사번에 같은 파일에서 등록하는 직원을 적을 수 있습니다. 시트마다 그 종류의 업로드 권한이 필요하고, 한 시트라도 오류가 있으면 아무것도 반영되지 않습니다.',
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
    workbook: {
      title: 'Combined file (employees, assets, peripherals)',
      listLabel: 'View assets',
      templateFile: 'combined_import_template.xlsx',
      intro: "Upload one file with employee, asset and peripheral sheets at once. Sheets are processed in the order employees → assets → peripherals, so an asset's holder employee number can refer to an employee registered in the same file. Each sheet requires the import permission for that type, and if any sheet has an error, nothing is imported.",
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
    workbook: {
      title: '合并文件（员工·资产·外设）',
      listLabel: '查看资产列表',
      templateFile: '合并导入模板.xlsx',
      intro: '一次上传包含员工、资产、外设工作表的一个文件。按 员工 → 资产 → 外设 的顺序处理，因此资产的持有人工号可以填写同一文件中登记的员工。每个工作表都需要该类型的导入权限；只要有一个工作表出错，就不会导入任何数据。',
    },
  },
});
