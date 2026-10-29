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
 * 영수증 — 주문 확인중. (Figma 보이저엑스 329:808)
 *
 * 받은 아트워크를 그대로 옮겼다. 특징 셋이 다 있어야 영수증으로 읽힌다:
 *   · 톱니 윗변(프린터에서 뜯어낸 자리)
 *   · 2열 품목 줄 — 왼쪽 긴 줄(메뉴명) + 오른쪽 짧은 줄(금액)
 *   · 왼쪽으로 말린 아랫단
 * 셋 중 하나라도 빼면 그냥 '문서' 아이콘이 된다.
 *
 * 원본은 회색 두 톤인데 여기선 초록(--green)으로 받았다. 흰 바탕에 홀로 서는
 * 자리라 회색으로 두면 '비활성'으로 읽힌다 — 지금 진행 중이라는 뜻의 아이콘이다.
 * 종이는 옅게(0.3), 글자줄과 말린 단은 진하게 — 원본의 두 톤 관계를 유지한다.
 */
export function ReceiptIcon({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      className="receipt-flutter" aria-hidden
    >
      {/* 종이 — 윗변 톱니 6산(원본에서 재서 산 하나당 0.98), 아래 오른쪽만 둥글다.
          왼쪽 아래는 말린 단이 덮으므로 각지게 둬도 보이지 않는다. */}
      <path
        d="M7.6 2.8 L8.58 1.9 L9.57 2.8 L10.55 1.9 L11.53 2.8 L12.52 1.9
           L13.5 2.8 L14.48 1.9 L15.47 2.8 L16.45 1.9 L17.43 2.8 L18.42 1.9
           L19.4 2.8 L19.4 19.6 A1.8 1.8 0 0 1 17.6 21.4 L7.6 21.4 Z"
        fill="#017333" fillOpacity="0.3"
      />
      {/* 품목 줄 — 맨 위는 굵은 머리줄(가게/합계), 아래 네 줄은 왼쪽 긴 줄(메뉴명) +
          오른쪽 짧은 줄(금액). 굵기를 1.3 으로 낮췄다 — 1.5 는 이 크기에서
          줄끼리 붙어 보여 '바코드'처럼 읽혔다. */}
      <path d="M9.3 5.3h8.4" stroke="#017333" strokeWidth="1.8" strokeLinecap="round" />
      <g stroke="#017333" strokeWidth="1.3" strokeLinecap="round">
        {/* 왼쪽 줄은 14.6 에서 끊고 오른쪽 줄은 16.7 에서 시작한다.
            전엔 15.3 / 16.3 이었는데, 둥근 끝(cap)이 양쪽으로 0.65씩 번져서
            둘이 맞닿아 **한 줄에 혹이 달린 모양**으로 보였다. 2열로 읽히려면
            cap 까지 계산한 실제 간격이 필요하다. */}
        <path d="M9.3 8.2h5.3M16.7 8.2h1" />
        <path d="M9.3 10.8h5.3M16.7 10.8h1" />
        <path d="M9.3 13.4h5.3M16.7 13.4h1" />
        <path d="M9.3 16h5.3M16.7 16h1" />
      </g>
      {/* 말린 아랫단 — 종이보다 **왼쪽으로 더 나온다.** 양끝이 둥근 납작한 롤이라
          두께를 3.5 로 잡았다(원본 비율). 두꺼우면 받침대처럼 보인다. */}
      <path
        d="M5.15 17.9h11.1a1.75 1.75 0 0 1 0 3.5H5.15a1.75 1.75 0 0 1 0-3.5Z"
        fill="#017333"
      />
    </svg>
  )
}

/**
 * 후라이팬 — 음식 준비중.
 *
 * 손잡이 쪽(오른쪽)을 축으로 흔든다 — 가운데를 축으로 두면 제자리에서 도는
 * 팽이처럼 보인다. 김 세 줄기가 차례로 피어올라 '조리 중'을 읽히게 한다.
 */
export function PanIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* 김 — 팬보다 먼저 그려서 팬 뒤로 가게 한다 */}
      <g className="steam" stroke="#017333" strokeWidth="1.4" strokeLinecap="round" opacity="0.75">
        <path d="M7.5 7.5c0-1 1-1.3 1-2.3" />
        <path d="M10.5 6.6c0-1 1-1.3 1-2.3" />
        <path d="M13.5 7.5c0-1 1-1.3 1-2.3" />
      </g>
      <g className="pan-toss">
        {/* 팬 몸통 — 반원 */}
        <path
          d="M2.8 11.5h12.4a6.2 6.2 0 0 1-12.4 0Z"
          fill="#017333" fillOpacity="0.3" stroke="#017333" strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* 손잡이 */}
        <path d="M15.2 11.9h5.4" stroke="#017333" strokeWidth="1.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/**
 * 상태 아이콘 — **원 없이** 그대로 둔다.
 *
 * 전엔 초록 원 안에 흰 아이콘이었다. 원이 있으면 버튼처럼 보여서 누르려는 사람이
 * 생기고, 아이콘이 원에 갇혀 작아져 펄럭임·흔들림이 보이지 않았다.
 * 아이콘만 두면 움직임이 그대로 살고, 옆 문구와 같은 층으로 읽힌다.
 */
export function StatusBadge({ cooking }: { cooking: boolean }) {
  return (
    <div className="flex-shrink-0">
      {cooking ? <PanIcon /> : <ReceiptIcon />}
    </div>
  )
}
