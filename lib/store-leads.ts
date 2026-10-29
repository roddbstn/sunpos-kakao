// "다른 가게도 선결제하고 계세요?" — 손님이 알려주는 선결제 가게 제보.
//
// 선결제를 이미 쓰고 있는 가게는 가장 좋은 후보다. 설득할 게 아니라
// 이미 하고 있는 일을 편하게 해주면 되니까.
//
// 제보할 이유는 하나뿐이다: **그 가게가 선포스를 시작하면 알려주기로 한 약속.**
// 그래서 notifyConsent 가 이 기능의 핵심이고, 약속을 지키는 쪽(매칭)은
// supabase/migrations/013 의 match_store_leads() 가 맡는다.

import { getSupabaseClient } from './supabase/client'

export interface PlaceResult {
  placeId:     string
  name:        string
  roadAddress: string
  phone:       string
  lat:         number
  lng:         number
  category:    string
}

/**
 * 가게 이름으로 검색 — 카카오 로컬 API(Edge Function 프록시).
 *
 * 키를 브라우저에서 직접 쓰지 않는 이유는 supabase/functions/place-search 주석 참고.
 * near 를 주면 그 좌표 근처부터 — 손님이 말하는 가게는 대개 그 동네에 있다.
 */
export async function searchPlaces(
  query: string,
  near?: { lat: number; lng: number },
): Promise<PlaceResult[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.functions.invoke('place-search', {
    body: { query, ...(near ?? {}) },
  })
  if (error) throw error
  return (data?.places ?? []) as PlaceResult[]
}

export interface StoreLeadInput {
  storeName:   string
  placeId?:    string | null
  roadAddress?: string | null
  phone?:      string | null
  lat?:        number | null
  lng?:        number | null
  memo?:       string | null
  notifyConsent: boolean
  fromStoreId?: string | null
  fromAccountCode?: string | null
}

export async function submitStoreLead(input: StoreLeadInput): Promise<void> {
  const supabase = getSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('로그인이 필요해요')

  const { error } = await supabase.from('store_leads').insert({
    reported_by:       user.id,
    from_store_id:     input.fromStoreId ?? null,
    from_account_code: input.fromAccountCode ?? null,
    store_name:        input.storeName.trim(),
    place_id:          input.placeId ?? null,
    road_address:      input.roadAddress ?? null,
    phone:             input.phone ?? null,
    lat:               input.lat ?? null,
    lng:               input.lng ?? null,
    memo:              input.memo?.trim() || null,
    notify_consent:    input.notifyConsent,
  })

  if (error) {
    // 유니크 인덱스(사람당 같은 가게 한 번) — 실패가 아니라 "이미 알려주셨어요"다
    if ((error as { code?: string }).code === '23505') {
      throw new Error('이미 알려주신 가게예요. 고맙습니다!')
    }
    throw error
  }
}
