import { getSupabaseClient } from '@/lib/supabase/client'
import type { KakaoUser } from '@/lib/types'

// 현재 Supabase Auth 세션의 사용자 정보 조회
export async function getSessionUser(): Promise<KakaoUser | null> {
  const supabase = getSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const meta = user.user_metadata
  // Supabase Kakao OAuth → raw_user_meta_data 구조
  // provider_id 또는 sub가 카카오 고유 ID
  const kakaoId = meta?.provider_id ?? meta?.sub ?? user.id
  const nickname = meta?.name ?? meta?.full_name ?? meta?.user_name ?? '이름 없음'
  const profileImage = meta?.avatar_url ?? meta?.picture ?? undefined

  // 카카오 전화번호: "+82 10-1234-5678" → "010-1234-5678"
  const rawPhone: string = meta?.phone_number ?? meta?.phone ?? ''
  const phone = rawPhone
    ? rawPhone.replace(/^\+82\s*/, '0').replace(/[\s-]/g, '').replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3')
    : undefined

  return {
    id: user.id,
    kakaoId: String(kakaoId),
    nickname: String(nickname),
    profileImage: profileImage ? String(profileImage) : undefined,
    phone,
  }
}

// 사용자의 특정 매장 링크 목록 조회
export async function getUserStoreLinks(storeId: string) {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('get_user_store_links', { p_store_id: storeId })
  if (error) throw error
  return (data ?? []) as Array<{
    link_id: string
    account_code: string
    account_name: string
    role: '관리자' | '이용자'
    status: 'pending' | 'approved' | 'rejected'
    org_name: string | null
    current_balance: number
  }>
}

// sunpos_users 프로필 조회
export async function getSunposProfile(): Promise<{
  nickname: string
  phone: string | null
  affiliation: string | null
} | null> {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from('sunpos_users')
    .select('nickname, phone, affiliation')
    .maybeSingle()
  return data ?? null
}

// 본인정보 저장 (profile-setup 화면에서 호출)
export async function updateSunposProfile(params: {
  nickname: string
  phone: string
  affiliation?: string
}) {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('update_sunpos_profile', {
    p_nickname:    params.nickname,
    p_phone:       params.phone,
    p_affiliation: params.affiliation ?? null,
  })
  if (error) throw error
}

// 이 거래처에서 가장 최근에 배달 주문했던 주소 — 메뉴 화면 상단 "현재 배달받는 곳" 표시용
export async function getLastDeliveryAddress(accountCode: string): Promise<{
  roadAddress: string
  detailAddress: string | null
} | null> {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc('get_last_delivery_address', { p_account_code: accountCode })
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.road_address) return null
  return { roadAddress: row.road_address, detailAddress: row.detail_address ?? null }
}

// sunpos_users upsert (카카오 로그인 후 호출)
export async function upsertSunposUser(user: KakaoUser) {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('upsert_sunpos_user', {
    p_kakao_id:      user.kakaoId,
    p_nickname:      user.nickname,
    p_profile_image: user.profileImage ?? null,
  })
  if (error) console.error('upsertSunposUser error:', error)
}

// ── 배달받을 주소 (최대 10개) ────────────────────────────────────────────────

export interface SunposAddress {
  id: string
  roadAddress: string
  detailAddress: string | null
  lat: number | null
  lng: number | null
}

// 도로명주소 → 좌표 (서버에서 네이버 지오코딩 수행)
export async function geocodeAddress(roadAddress: string): Promise<{ lat: number; lng: number } | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.functions.invoke('geocode-address', {
    body: { road_address: roadAddress },
  })
  if (error || !data?.lat || !data?.lng) return null
  return { lat: data.lat, lng: data.lng }
}

export async function getSunposAddresses(): Promise<SunposAddress[]> {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from('sunpos_user_addresses')
    .select('id, road_address, detail_address, lat, lng')
    .order('created_at', { ascending: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => ({
    id:            r.id,
    roadAddress:   r.road_address,
    detailAddress: r.detail_address,
    lat:           r.lat,
    lng:           r.lng,
  }))
}

// 새 주소 추가 — 10개 꽉 찼으면 needsConfirmation=true + oldestAddress 반환 (아직 저장 안 됨).
// confirmDeleteOldest=true로 다시 호출하면 가장 오래된 주소를 지우고 저장한다.
export async function upsertSunposAddress(params: {
  roadAddress: string
  detailAddress?: string
  lat: number
  lng: number
  confirmDeleteOldest?: boolean
}): Promise<{ id: string | null; needsConfirmation: boolean; oldestAddress: string | null }> {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('upsert_sunpos_user_address', {
    p_road_address:          params.roadAddress,
    p_detail_address:        params.detailAddress ?? null,
    p_lat:                   params.lat,
    p_lng:                   params.lng,
    p_confirm_delete_oldest: params.confirmDeleteOldest ?? false,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    id:                row?.id ?? null,
    needsConfirmation: !!row?.needs_confirmation,
    oldestAddress:     row?.oldest_address ?? null,
  }
}

export async function updateSunposAddress(id: string, params: {
  roadAddress: string
  detailAddress?: string
  lat: number
  lng: number
}) {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('sunpos_user_addresses')
    .update({
      road_address:   params.roadAddress,
      detail_address: params.detailAddress ?? null,
      lat:            params.lat,
      lng:            params.lng,
    })
    .eq('id', id)
  if (error) throw error
}

export async function deleteSunposAddress(id: string) {
  const supabase = getSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('sunpos_user_addresses')
    .delete()
    .eq('id', id)
  if (error) throw error
}
