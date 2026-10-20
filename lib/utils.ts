import type { SelectedOption } from './types'

// 배달료 상수 (26년 10월 1일부터 배달대행 기본요금 인상으로 500원 상향, 거리 계산 실패 시 폴백값)
export const DELIVERY_FEE = 4000

// 잔액 경고 기준
export const LOW_BALANCE = 30000

// 금액을 한국어 원화 포맷으로 표시
// formatWon(12345) → "12,345원"
export function formatWon(n: number): string {
  return n.toLocaleString('ko-KR') + '원'
}

// 잔액이 경고 기준 이하인지 확인
export function isLowBalance(balance: number, threshold = LOW_BALANCE): boolean {
  return balance <= threshold
}

// 잔액이 음수인지 확인
export function isNegativeBalance(balance: number): boolean {
  return balance < 0
}

// 옵션 추가금액 합산
export function calcOptionExtra(selectedOptions: SelectedOption[]): number {
  return selectedOptions.reduce((sum, o) => sum + o.plus, 0)
}

// 카트 아이템 소계 계산: (기본가 + 옵션 합) × 수량
export function calcSubtotal(
  basePrice: number,
  selectedOptions: SelectedOption[],
  qty: number
): number {
  return (basePrice + calcOptionExtra(selectedOptions)) * qty
}

// 선택된 옵션 표시 문자열 (예: "현미밥, 100g, 오리엔탈")
export function formatOptionsLabel(selectedOptions: SelectedOption[]): string {
  if (selectedOptions.length === 0) return ''
  return selectedOptions.map(o => o.optionName).join(', ')
}

// 장바구니 아이템 고유 ID 생성
export function generateCartId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * 도로명 주소에서 **행정구역을 떼고 도로명부터** 남긴다.
 *   '대전 중구 태평로15'  → '태평로15'
 *   '대구 북구 옥산로 65' → '옥산로 65'
 *
 * 한국 도로명은 '로' 또는 '길' 로 끝난다(대로·번길 포함). 그 토큰이 나오는 지점부터
 * 끝까지가 사람이 실제로 구분에 쓰는 부분이고, 앞의 시/도·시군구는 같은 동네 안에서는
 * 전부 같아서 자리만 차지한다. 좁은 상단 줄에 한 줄로 넣으려면 떼야 한다.
 *
 * 못 찾으면 원문을 그대로 돌려준다 — 지번 주소나 예외 표기를 임의로 자르지 않는다.
 */
export function shortRoadAddress(road: string): string {
  const parts = road.trim().split(/\s+/)
  const i = parts.findIndex(p => /(로|길)\d*$/.test(p))
  return i >= 0 ? parts.slice(i).join(' ') : road.trim()
}
