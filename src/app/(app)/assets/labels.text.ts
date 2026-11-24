// 자산의 상태·처리·이력 종류의 화면 이름. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';

export const TEXT = dict({
  ko: {
    state: { ON_ORDER: '입고 예정', IN_STOCK: '재고', IN_USE: '사용 중', MAINTENANCE: '수리 중', MISSING: '분실', RETIRED: '퇴역', VOID: '등록 취소' },
    substate: { AVAILABLE: '사용 가능', RESERVED: '예약됨', DEFECTIVE: '불량', PENDING_DISPOSAL: '폐기 대기', DISPOSED: '폐기됨', SOLD: '매각됨', DONATED: '기증됨' },
    action: {
      RECEIVE: '입고 확정', ASSIGN: '배정', LOAN: '대여', RETURN: '반납', RESERVE: '예약', UNRESERVE: '예약 해제',
      MARK_DEFECTIVE: '불량 표시', REPAIR_IN: '수리 입고', REPAIR_OUT: '수리 완료', MARK_MISSING: '분실 처리', FOUND: '발견',
      RETIRE: '퇴역', DISPOSE: '처분', VOID: '등록 취소',
    },
    /** 처리 외에 이력에만 나오는 종류 */
    txnExtra: { REGISTER: '등록', UPDATE: '정보 수정', CHANGE_DEPARTMENT: '관리 부서 변경', IMPORT_UPDATE: '일괄 수정' },
    disposal: { DISPOSED: '폐기', SOLD: '매각', DONATED: '기증' },
  },
  en: {
    state: { ON_ORDER: 'On order', IN_STOCK: 'In stock', IN_USE: 'In use', MAINTENANCE: 'In repair', MISSING: 'Missing', RETIRED: 'Retired', VOID: 'Voided' },
    substate: { AVAILABLE: 'Available', RESERVED: 'Reserved', DEFECTIVE: 'Defective', PENDING_DISPOSAL: 'Pending disposal', DISPOSED: 'Disposed', SOLD: 'Sold', DONATED: 'Donated' },
    action: {
      RECEIVE: 'Confirm receipt', ASSIGN: 'Issue', LOAN: 'Loan', RETURN: 'Return', RESERVE: 'Reserve', UNRESERVE: 'Release reservation',
      MARK_DEFECTIVE: 'Mark defective', REPAIR_IN: 'Send to repair', REPAIR_OUT: 'Repair complete', MARK_MISSING: 'Mark missing', FOUND: 'Mark found',
      RETIRE: 'Retire', DISPOSE: 'Dispose', VOID: 'Void',
    },
    txnExtra: { REGISTER: 'Registered', UPDATE: 'Details edited', CHANGE_DEPARTMENT: 'Managing department changed', IMPORT_UPDATE: 'Bulk update' },
    disposal: { DISPOSED: 'Scrap', SOLD: 'Sell', DONATED: 'Donate' },
  },
  zh: {
    state: { ON_ORDER: '待入库', IN_STOCK: '库存', IN_USE: '使用中', MAINTENANCE: '维修中', MISSING: '丢失', RETIRED: '已报废', VOID: '已取消登记' },
    substate: { AVAILABLE: '可用', RESERVED: '已预留', DEFECTIVE: '故障', PENDING_DISPOSAL: '待处置', DISPOSED: '已销毁', SOLD: '已出售', DONATED: '已捐赠' },
    action: {
      RECEIVE: '确认入库', ASSIGN: '发放', LOAN: '借用', RETURN: '归还', RESERVE: '预留', UNRESERVE: '取消预留',
      MARK_DEFECTIVE: '标记故障', REPAIR_IN: '送修', REPAIR_OUT: '维修完成', MARK_MISSING: '标记丢失', FOUND: '找回',
      RETIRE: '报废', DISPOSE: '处置', VOID: '取消登记',
    },
    txnExtra: { REGISTER: '登记', UPDATE: '修改信息', CHANGE_DEPARTMENT: '变更管理部门', IMPORT_UPDATE: '批量修改' },
    disposal: { DISPOSED: '销毁', SOLD: '出售', DONATED: '捐赠' },
  },
});
