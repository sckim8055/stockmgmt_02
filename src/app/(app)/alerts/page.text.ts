// page.tsx 의 화면 문구. 세 언어의 키는 같아야 한다(dict 가 컴파일할 때 검사한다).
import { dict } from '../../i18n';
import { NUM } from '../../i18n/format';

export const TEXT = dict({
  ko: {
    title: '알림함',
    loading: '불러오는 중…',
    empty: '알림이 없습니다.',
    emptyUnread: '읽지 않은 알림이 없습니다.',
    unreadOnly: '읽지 않은 것만',
    markRead: '읽음',
    markAll: '모두 읽음',
    unreadMark: '읽지 않음',
    open: '바로 가기',
    summary: (total: number, unread: number) => `${NUM.ko(total)}건 · 읽지 않음 ${NUM.ko(unread)}건`,
    markedAll: (n: number) => `${NUM.ko(n)}건을 읽음으로 표시했습니다.`,
    listLabel: '알림 목록',
  },
  en: {
    title: 'Inbox',
    loading: 'Loading…',
    empty: 'No alerts.',
    emptyUnread: 'No unread alerts.',
    unreadOnly: 'Unread only',
    markRead: 'Mark as read',
    markAll: 'Mark all as read',
    unreadMark: 'Unread',
    open: 'Go to',
    summary: (total: number, unread: number) => `${NUM.en(total)} total · ${NUM.en(unread)} unread`,
    markedAll: (n: number) => `Marked ${NUM.en(n)} ${n === 1 ? 'alert' : 'alerts'} as read.`,
    listLabel: 'Alerts',
  },
  zh: {
    title: '提醒箱',
    loading: '加载中…',
    empty: '暂无提醒。',
    emptyUnread: '没有未读提醒。',
    unreadOnly: '仅未读',
    markRead: '标为已读',
    markAll: '全部标为已读',
    unreadMark: '未读',
    open: '前往',
    summary: (total: number, unread: number) => `共 ${NUM.zh(total)} 条 · 未读 ${NUM.zh(unread)} 条`,
    markedAll: (n: number) => `已将 ${NUM.zh(n)} 条标为已读。`,
    listLabel: '提醒列表',
  },
});
