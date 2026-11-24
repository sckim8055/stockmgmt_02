// page.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
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
  },
  en: {
    title: 'Excel import',
    rulesTitle: 'Before you upload',
    rules: [
      'Enter data only on the first sheet of the file from "Download template". Other sheets are ignored.',
      'Do not change or delete the header (row 1). Enter one record per row, starting from row 2.',
      'You can upload up to 2,000 rows and 5 MB per file.',
      'Run "Check" first. If any row has an error, nothing is imported.',
      'Asset tags and employee numbers that already exist are reported as errors. Existing records are never modified (overwritten).',
      'Recommended order: employees → assets → peripherals. The holder employee number in an asset row must belong to an employee who is already registered.',
    ],
    noPermission: 'You do not have permission to import from Excel.',
  },
  zh: {
    title: 'Excel 导入',
    rulesTitle: '上传前请确认',
    rules: [
      '只在通过“下载模板”获取的文件的第一个工作表中填写。其他工作表不会被读取。',
      '请勿修改或删除表头（第 1 行）。从第 2 行开始，每行填写一条记录。',
      '每次最多可上传 2,000 行，文件大小最大 5MB。',
      '请先点击“检查”。只要有一行出错，就不会导入任何数据。',
      '已登记的资产标签、工号会被视为错误，不会修改（覆盖）现有数据。',
      '建议顺序：员工 → 资产 → 外设。资产行中的持有人工号必须是已登记员工的工号。',
    ],
    noPermission: '您没有 Excel 导入权限。',
  },
});
