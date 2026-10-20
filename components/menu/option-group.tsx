import type { MenuOptionGroup } from '@/lib/types'
import { formatWon } from '@/lib/utils'

interface OptionGroupProps {
  group: MenuOptionGroup
  groupIndex: number
  selectedIds: string[]
  onToggle: (groupIndex: number, itemId: string) => void
  isMissing?: boolean
  basePrice?: number  // '가격' 그룹에서 최종가 표시용
}

export default function OptionGroup({
  group,
  groupIndex,
  selectedIds,
  onToggle,
  isMissing = false,
  basePrice,
}: OptionGroupProps) {
  // 사이즈 그룹: 이름 + 우측 최종가 표시
  const showFinalPrice = group.group === '사이즈' && basePrice !== undefined
  // 가격 그룹: 이름 자체를 현재가(basePrice + extra)로 대체
  const isGaGyeok = (group.group === '가격' || group.group === '가격(필수)') && basePrice !== undefined
  // 그룹 전체 품절
  const groupSoldOut = group.isSoldOut ?? false

  return (
    <div className={[
      isMissing ? 'border-l-[3px] border-l-[#C92A2A]' : '',
      groupSoldOut ? 'opacity-50' : '',
    ].join(' ')}>
      {/* 그룹 헤더 — 좌우로 꽉 찬 아주 연한 바로 감싼다.
          옵션이 여러 그룹일 때 어디서 그룹이 바뀌는지 글자 굵기만으로는 안 보였다.
          높이는 글자 줄 높이(약 22px)의 두 배보다 조금 더 — 바가 얇으면 글자가
          바에 끼인 것처럼 보인다. */}
      <div className="flex items-center justify-between px-5 bg-[#F5F5F5] h-[54px] mt-[14px]">
        {/* 필수는 '필수' 뱃지 대신 **옵션명 바로 옆 주황 별표**로.
            뱃지로 띄우면 눈이 이름 → 뱃지로 한 번 더 건너가는데,
            별표는 이름을 읽는 그 자리에서 같이 읽힌다. */}
        <span className="text-[16px] font-bold text-[#1E1E1E]">
          {group.group}
          {!groupSoldOut && group.required && (
            <span className="text-[#FF8418] ml-[3px]" aria-label="필수 선택">*</span>
          )}
        </span>
        {groupSoldOut ? (
          <span className="text-[11px] font-semibold text-white bg-[#727272] px-[7px] py-[2px] rounded-full">
            품절
          </span>
        ) : !group.required ? (
          <span className="text-[11px] font-normal uppercase tracking-wide text-[#727272]">
            {group.multi ? '복수선택' : '선택'}
          </span>
        ) : null}
      </div>

      {/* 옵션 아이템 목록 */}
      <div className="pb-1">
        {group.items.map((item) => {
          const isSelected = selectedIds.includes(item.id)
          const isSoldOut = item.isSoldOut ?? false

          // 가격 표시 로직
          // - 가격 그룹: 이름을 현재가로 대체, 우측 라벨 없음
          // - 사이즈 그룹: 이름 유지, 우측에 최종가
          // - 기타: +가격 또는 포함
          const displayName = isGaGyeok
            ? formatWon(basePrice! + item.plus)
            : item.name

          let priceLabel = ''
          if (!isGaGyeok) {
            if (showFinalPrice && basePrice !== undefined) {
              priceLabel = formatWon(basePrice + item.plus)
            } else if (item.plus > 0) {
              priceLabel = `+${formatWon(item.plus)}`
            } else if (item.plus === 0 && !showFinalPrice && isSoldOut) {
              priceLabel = '품절'
            }
          }

          return (
            <div
              key={item.id}
              onClick={() => !isSoldOut && !groupSoldOut && onToggle(groupIndex, item.id)}
              className={[
                'w-full flex items-center justify-between px-5 py-[13px]',
                isSoldOut ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              <div className="flex items-center gap-3">
                {/* 선택 인디케이터: 단일=원형, 복수=사각형 — 이 부분만 눌림 인터랙션 */}
                {group.multi ? (
                  <div className={[
                    'w-[20px] h-[20px] rounded-[4px] border-2 flex items-center justify-center flex-shrink-0',
                    'transition-transform active:scale-90',
                    isSelected
                      ? 'bg-[#16a84c] border-[#16a84c]'
                      : 'border-[#D7D7D7]',
                  ].join(' ')}>
                    {isSelected && (
                      <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
                        <path d="M1 4L4.5 7.5L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                ) : (
                  // 선택되면 **원 전체를 칠하고 가운데를 흰 원으로 뚫는다.**
                  // 테두리만 칠하고 안에 점을 찍던 예전 방식은 20px 원 안의 10px 점이라
                  // 멀리서 보면 그냥 빈 원이었다.
                  <div className={[
                    'w-[20px] h-[20px] rounded-full flex-shrink-0',
                    'flex items-center justify-center',
                    'transition-transform active:scale-90',
                    isSelected
                      ? 'border-2 bg-[#16a84c] border-[#16a84c]'
                      : 'border-[1.5px] border-[#D7D7D7]',
                  ].join(' ')}>
                    {isSelected && <div className="w-[7px] h-[7px] rounded-full bg-white" />}
                  </div>
                )}

                <span className={[
                  'text-[14px] text-[#1E1E1E]',
                  isSoldOut ? 'text-[#ABABAB]' : '',
                ].join(' ')}>
                  {displayName}
                </span>
              </div>

              {priceLabel && (
                <span className={[
                  'text-[13px] flex-shrink-0',
                  'font-normal',
                  isSelected ? 'text-[#16a84c]' : 'text-[#ABABAB]',
                  showFinalPrice ? 'text-[14px]' : '',
                ].join(' ')}>
                  {priceLabel}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
