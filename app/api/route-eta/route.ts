import { NextRequest, NextResponse } from 'next/server'

// 매장 → 배달지 자동차 소요시간. (카카오모빌리티 길찾기)
//
// ── 왜 서버 라우트인가 ─────────────────────────────────────────────────────
// 카카오 길찾기는 REST 키를 Authorization 헤더에 싣는다. 브라우저에서 바로 부르면
// 키가 네트워크 탭에 그대로 보이고, 누구나 그 키로 호출량을 태울 수 있다.
// 여기서 받아서 넘기면 키는 서버에만 있다.
//
// 키 이름이 NEXT_PUBLIC_ 으로 시작하는 게 하나뿐이라 그걸 폴백으로 둔다 —
// 다만 **서버에서만 참조**하므로 클라이언트 번들에는 들어가지 않는다.
// 나중에 KAKAO_REST_API_KEY(비공개)로 옮기면 폴백은 지우면 된다.
const KEY = process.env.KAKAO_REST_API_KEY ?? process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY

/** 좌표 하나를 숫자로 — 한국 밖이면 거절한다(오타·좌표 뒤바뀜을 여기서 걸러낸다) */
function coord(v: string | null, min: number, max: number): number | null {
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

export async function GET(request: NextRequest) {
  if (!KEY) {
    return NextResponse.json({ error: 'no_key' }, { status: 503 })
  }

  const q = request.nextUrl.searchParams
  // 위도 33~39, 경도 124~132 — 대한민국 범위
  const oLat = coord(q.get('oLat'), 33, 39)
  const oLng = coord(q.get('oLng'), 124, 132)
  const dLat = coord(q.get('dLat'), 33, 39)
  const dLng = coord(q.get('dLng'), 124, 132)

  if (oLat === null || oLng === null || dLat === null || dLng === null) {
    return NextResponse.json({ error: 'bad_coords' }, { status: 400 })
  }

  try {
    // 카카오는 x=경도, y=위도 순서다. 뒤집으면 엉뚱한 바다 위 경로가 나온다.
    const url = 'https://apis-navi.kakaomobility.com/v1/directions'
      + `?origin=${oLng},${oLat}&destination=${dLng},${dLat}&priority=RECOMMEND`

    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KEY}` },
      // 길은 자주 바뀌지 않는다. 같은 주문 화면을 다시 열 때마다 부르지 않도록
      // 10분 캐시한다(무료 호출량도 아낀다).
      next: { revalidate: 600 },
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'upstream', status: res.status }, { status: 502 })
    }

    const data = await res.json()
    const route = data?.routes?.[0]
    // result_code 0 만 성공이다. 길이 없으면(섬 등) 0 이 아닌 코드가 온다.
    if (!route || route.result_code !== 0) {
      return NextResponse.json({ error: 'no_route', code: route?.result_code ?? null }, { status: 404 })
    }

    const s = route.summary
    return NextResponse.json({
      durationSec: s.duration,
      distanceM:   s.distance,
    })
  } catch {
    return NextResponse.json({ error: 'fetch_failed' }, { status: 502 })
  }
}
