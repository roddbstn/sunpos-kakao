import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServer } from '@/lib/supabase/server'

// 카카오 OAuth 콜백 처리
// trailingSlash: true 이므로 실제 URL은 /auth/callback/
//
// 관리자 등록 토큰(admin_token)·초대 토큰(invite_token) 분기는 없앴다.
// 이제 이용자가 되는 길은 하나다 — QR 찍고 PIN 넣고 메뉴 화면에서 카카오 로그인.
// 그래서 로그인 뒤 돌아갈 곳도 하나뿐이다: `next` (대개 /menu).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code    = searchParams.get('code')
  const storeId = searchParams.get('store') ?? ''
  // 열린 리다이렉트를 막는다 — 같은 사이트 안의 경로만 허용한다.
  const rawNext = searchParams.get('next') ?? ''
  const next    = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : ''

  const authBase = next
    ? `${next}${next.includes('?') ? '&' : '?'}`
    : storeId ? `/?store=${storeId}&` : '/?'

  if (!code) {
    return NextResponse.redirect(`${origin}${authBase}error=auth_failed`)
  }

  try {
    const supabase = await getSupabaseServer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.auth as any).exchangeCodeForSession(code)

    if (error) {
      console.error('OAuth callback error:', error.message)
      return NextResponse.redirect(`${origin}${authBase}error=auth_failed`)
    }

    // 메뉴 화면으로 돌아가면 그 화면이 '아직 정보를 안 낸 사람'을 알아보고
    // 하단 시트를 띄운다(SelfRegisterSheet).
    const dest = next || (storeId ? `/?store=${storeId}` : '/')
    return NextResponse.redirect(`${origin}${dest}`)
  } catch (e) {
    console.error('OAuth callback unexpected error:', e)
    return NextResponse.redirect(`${origin}${authBase}error=auth_failed`)
  }
}
