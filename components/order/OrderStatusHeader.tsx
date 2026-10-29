'use client'

// 주문 완료 화면 머리 — 상태에 따라 문구·아이콘이 바뀐다.
//
// 상태는 둘이다(준비 완료는 이 컴포넌트를 쓰지 않는다. 그쪽은 초록 배너다):
//
//   확인중  점주가 POS 에서 주문을 보기 전.  "주문을 확인하고 있어요"  영수증 펄럭임
//   준비중  점주가 예상 준비시간을 넣고 접수.  "음식이 준비중이에요"    후라이팬 조리
//
// 전환 시점이 중요하다 — 점주가 접수 버튼을 누르면 orders.status 가 '조리중' 이 되고
// prep_minutes 가 채워진다. 그게 realtime 으로 닿는 순간 문구와 아이콘이 같이 바뀌고,
// 주문 취소 버튼이 사라진다(주방이 이미 움직였으므로).
//
// 점 세 개는 글자가 아니라 애니메이션이다(globals.css .dot-bounce) — 멈춘 마침표는
// "눌린 건가, 멈춘 건가"가 구분되지 않는다. 확인에 몇십 초가 걸리는 자리라 특히 그렇다.

/** '주문을 확인하고 있어요' 처럼 **마침표 없이** 넘긴다 — 점은 이 컴포넌트가 붙인다 */
export function WaitingLabel({ label }: { label: string }) {
  return (
    <>
      {label}
      <span className="dot-bounce ml-[1px]">
        <span>.</span><span>.</span><span>.</span>
      </span>
    </>
  )
}

/**
 * 영수증 — 주문 확인중.
 *
 * 종이를 위쪽에서 잡은 것처럼 아래가 더 흔들린다(transform-origin 50% 20%).
 * 톱니(아래 지그재그)가 있어야 영수증으로 읽힌다 — 없으면 그냥 문서 아이콘이다.
 */
export function ReceiptIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      className="receipt-flutter" aria-hidden
    >
      <path
        d="M6 2.5h12v16.2l-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3V2.5Z"
        fill="#fff" fillOpacity="0.22" stroke="#fff" strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 7h6M9 10.5h6M9 14h3.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 후라이팬 — 음식 준비중.
 *
 * 손잡이 쪽(오른쪽)을 축으로 흔든다 — 가운데를 축으로 두면 제자리에서 도는
 * 팽이처럼 보인다. 김 세 줄기가 차례로 피어올라 '조리 중'을 읽히게 한다.
 */
export function PanIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* 김 — 팬보다 먼저 그려서 팬 뒤로 가게 한다 */}
      <g className="steam" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity="0.9">
        <path d="M7.5 7.5c0-1 1-1.3 1-2.3" />
        <path d="M10.5 6.6c0-1 1-1.3 1-2.3" />
        <path d="M13.5 7.5c0-1 1-1.3 1-2.3" />
      </g>
      <g className="pan-toss">
        {/* 팬 몸통 — 반원 */}
        <path
          d="M2.8 11.5h12.4a6.2 6.2 0 0 1-12.4 0Z"
          fill="#fff" fillOpacity="0.22" stroke="#fff" strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* 손잡이 */}
        <path d="M15.2 11.9h5.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** 상태 뱃지 — 초록 원 안에 아이콘. 준비 전 두 상태가 같은 자리를 쓴다 */
export function StatusBadge({ cooking }: { cooking: boolean }) {
  return (
    <div
      className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0"
      style={{ background: 'linear-gradient(135deg, #02a84e 0%, #017333 60%, #015a28 100%)' }}
    >
      {cooking ? <PanIcon /> : <ReceiptIcon />}
    </div>
  )
}
