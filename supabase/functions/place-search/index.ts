// 가게 이름으로 장소 검색 — 카카오 로컬 API(키워드로 장소 검색) 프록시.
//
// 왜 프록시인가: 카카오 REST 키를 브라우저에 두면 **그 키로 다른 카카오 API 도 호출된다.**
// 지금 앱의 NEXT_PUBLIC_KAKAO_REST_API_KEY 는 클라이언트에 노출돼 있는데, 그걸 그대로
// 검색에 쓰면 노출 범위가 더 넓어진다. geocode-address 가 네이버 키를 서버에만 두는 것과
// 같은 이유다 — "API 키는 여기(서버)에서만 사용, 클라이언트에 절대 노출하지 않는다".
//
// 왜 네이버가 아니라 카카오인가:
//   · 기존 네이버 연동은 **NCP Maps 지오코딩**이라 주소→좌표만 한다. 상호 검색은 못 한다.
//   · 네이버 검색 API(지역)는 별도 키가 필요하고 한 번에 **5개**만 준다 — 검색 UI 로는 답답하다.
//   · 카카오는 이미 로그인에 쓰고 있어 계정·심사가 하나로 묶이고, 15개씩 준다.
//
// 필요한 Secret: KAKAO_REST_API_KEY (Supabase Edge Function Secrets)
//   ⚠️ Vercel 환경변수가 아니다. 이 함수는 Supabase 에서 돌아간다.
//   ⚠️ 키만 있으면 안 된다. Kakao Developers 에서 그 앱의 **카카오맵** 제품을 켜야
//      한다. 끄면 403 NotAuthorizedError "disabled OPEN_MAP_AND_LOCAL service" 가 난다.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface KakaoPlace {
  id:                string
  place_name:        string
  road_address_name: string
  address_name:      string
  phone:             string
  x:                 string   // lng
  y:                 string   // lat
  category_group_name: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const key = Deno.env.get('KAKAO_REST_API_KEY') ?? ''
  if (!key) {
    return new Response(JSON.stringify({ error: 'KAKAO_REST_API_KEY 미설정' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: { query?: string; lat?: number; lng?: number }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const query = (body.query ?? '').trim()
  // 한 글자로는 쓸 만한 결과가 안 나오고 호출만 낭비한다
  if (query.length < 2) {
    return new Response(JSON.stringify({ places: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 매장 좌표를 주면 가까운 곳부터 — 손님이 말하는 가게는 대개 그 동네에 있다.
  // 반경 안에 없을 수도 있으므로(옆 동네 가게를 아는 손님) **0건이면 전국으로 한 번 더**
  // 찾는다. 두 번째 호출은 그때만 일어난다.
  const near = typeof body.lat === 'number' && typeof body.lng === 'number'
    ? { lat: body.lat, lng: body.lng }
    : null

  async function search(withNear: boolean): Promise<KakaoPlace[] | null> {
    const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json')
    url.searchParams.set('query', query)
    url.searchParams.set('size', '15')
    if (withNear && near) {
      url.searchParams.set('x', String(near.lng))
      url.searchParams.set('y', String(near.lat))
      url.searchParams.set('radius', '20000')   // 20km — 카카오 최대값
      url.searchParams.set('sort', 'distance')
    }

    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } })
    if (!res.ok) {
      console.error('카카오 로컬 검색 실패', res.status, await res.text())
      return null
    }
    const json = await res.json() as { documents?: KakaoPlace[] }
    return json.documents ?? []
  }

  let documents = await search(true)
  if (documents === null) {
    return new Response(JSON.stringify({ error: '검색에 실패했어요', places: [] }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (near && documents.length === 0) {
    documents = (await search(false)) ?? []
  }

  // 클라이언트에 필요한 것만 — 카카오 응답을 그대로 흘리면 나중에 모양이 바뀔 때 화면이 깨진다
  const places = documents.map(d => ({
    placeId:     d.id,
    name:        d.place_name,
    roadAddress: d.road_address_name || d.address_name || '',
    phone:       d.phone || '',
    lat:         Number(d.y),
    lng:         Number(d.x),
    category:    d.category_group_name || '',
  }))

  return new Response(JSON.stringify({ places }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
