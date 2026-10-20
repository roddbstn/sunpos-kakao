// 링크 + 매장 정보 → Account / ActiveLink 객체 변환 유틸. (order)/page.tsx에서 사용.

import type { Account, ActiveLink } from '@/lib/types'

interface LinkData {
  account_code: string
  account_name: string
  role: '관리자' | '이용자'
  org_name: string | null
  current_balance: number
}

export function buildAccount(
  link: LinkData,
  storeId: string,
  storeName: string,
): Account {
  return {
    code:          link.account_code,
    accountNumber: 0,
    name:          link.account_name,
    // role만으로는 개인/과/기업/기타를 구분할 수 없음(관리자·이용자 2종뿐) — account_type을
    // 이 함수가 받지 않으므로 '기타'로 보수적 처리. 정확한 유형이 필요하면 accounts.account_type을 직접 조회할 것.
    type:          '기타',
    org:           link.org_name,
    balance:       link.current_balance,
    storeId,
    storeName,
  }
}

export function buildActiveLink(
  linkId: string,
  link: Pick<LinkData, 'account_code' | 'role' | 'org_name'>,
  storeId: string,
): ActiveLink {
  return {
    linkId,
    accountCode: link.account_code,
    storeId,
    role:        link.role,
    status:      'approved',
    orgName:     link.org_name ?? undefined,
  }
}
