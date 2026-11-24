// 메일 화면(일정·발송 기록)이 함께 쓰는 표시 이름. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

const KO_WD: Record<number, string> = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
const EN_WD: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const ZH_WD: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' };

export const TEXT = dict({
  ko: {
    /** 발송 기능이 아직 없음을 알리는 문구. 일정·발송 기록 화면이 함께 쓴다. */
    sendingDisabled:
      '메일 발송 기능은 아직 켜져 있지 않습니다. 일정을 만들고 미리 볼 수는 있지만, 정기 발송기가 켜지기 전까지는 어떤 메일도 실제로 발송되지 않습니다.',
    content: { LOW_STOCK: '재고 부족', STOCK_SUMMARY: '재고 현황', OPEN_LOANS: '미반납 대여' },
    contentHint: {
      LOW_STOCK: '지금 부족 상태인 한계 수량 목록',
      STOCK_SUMMARY: '카테고리별 사용 가능·사용 중 수량',
      OPEN_LOANS: '반납하지 않은 자산·주변기기 대여 목록(기한 지난 것 표시)',
    },
    frequency: { DAILY: '매일', WEEKLY: '매주', MONTHLY: '매월' },
    /** 요일 짧은 이름(1=월 … 7=일, ISO 요일) */
    weekday: KO_WD,
    monthDay: (d: number) => `${d}일`,
    timezone: {
      'Asia/Seoul': '한국 (Asia/Seoul)',
      'Asia/Shanghai': '중국 (Asia/Shanghai)',
      'Asia/Tokyo': '일본 (Asia/Tokyo)',
      UTC: '협정 세계시 (UTC)',
    } as Record<string, string>,
    logStatus: { SENT: '발송됨', FAILED: '실패' },
    /** "매일 09:00", "매주 월·수 09:00", "매월 1·15일 09:00" */
    daily: (time: string) => `매일 ${time}`,
    weekly: (days: number[], time: string) => `매주 ${days.map((d) => KO_WD[d] ?? String(d)).join('·')} ${time}`,
    monthly: (days: number[], time: string) => `매월 ${days.join('·')}일 ${time}`,
  },
  en: {
    sendingDisabled:
      'Mail delivery is not enabled yet. You can create and preview schedules, but no mail is actually sent until the scheduled sender is turned on.',
    content: { LOW_STOCK: 'Low stock', STOCK_SUMMARY: 'Stock summary', OPEN_LOANS: 'Outstanding loans' },
    contentHint: {
      LOW_STOCK: 'Minimum-stock rules that are currently low',
      STOCK_SUMMARY: 'Available and in-use quantities by category',
      OPEN_LOANS: 'Unreturned asset and peripheral loans (overdue ones flagged)',
    },
    frequency: { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' },
    weekday: EN_WD,
    monthDay: (d: number) => String(d),
    timezone: {
      'Asia/Seoul': 'Korea (Asia/Seoul)',
      'Asia/Shanghai': 'China (Asia/Shanghai)',
      'Asia/Tokyo': 'Japan (Asia/Tokyo)',
      UTC: 'Coordinated Universal Time (UTC)',
    } as Record<string, string>,
    logStatus: { SENT: 'Sent', FAILED: 'Failed' },
    daily: (time: string) => `Daily at ${time}`,
    weekly: (days: number[], time: string) => `Weekly on ${days.map((d) => EN_WD[d] ?? String(d)).join(', ')} at ${time}`,
    monthly: (days: number[], time: string) => `Monthly on day${days.length > 1 ? 's' : ''} ${days.join(', ')} at ${time}`,
  },
  zh: {
    sendingDisabled: '邮件发送功能尚未开启。您可以创建并预览计划，但在定时发送器开启之前，不会实际发送任何邮件。',
    content: { LOW_STOCK: '库存不足', STOCK_SUMMARY: '库存概况', OPEN_LOANS: '未归还借用' },
    contentHint: {
      LOW_STOCK: '当前处于不足状态的最低库存列表',
      STOCK_SUMMARY: '各类别的可用、使用中数量',
      OPEN_LOANS: '未归还的资产和外设借用列表（标出已逾期的）',
    },
    frequency: { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' },
    weekday: ZH_WD,
    monthDay: (d: number) => `${d}日`,
    timezone: {
      'Asia/Seoul': '韩国 (Asia/Seoul)',
      'Asia/Shanghai': '中国 (Asia/Shanghai)',
      'Asia/Tokyo': '日本 (Asia/Tokyo)',
      UTC: '协调世界时 (UTC)',
    } as Record<string, string>,
    logStatus: { SENT: '已发送', FAILED: '失败' },
    daily: (time: string) => `每天 ${time}`,
    weekly: (days: number[], time: string) => `每周${days.map((d) => ZH_WD[d] ?? String(d)).join('、')} ${time}`,
    monthly: (days: number[], time: string) => `每月 ${days.join('、')} 日 ${time}`,
  },
});
