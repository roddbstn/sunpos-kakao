import { NextRequest, NextResponse } from 'next/server'

// 문자 단문(SMS) 요금을 위한 단축링크 리다이렉트. 원본 URL은 short_links 테이블에 저장돼 있고
// resolve_short_link RPC로만 조회 가능 (직접 테이블 접근 불가).
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const { origin } = new URL(request.url)

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_short_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_code: code }),
  })

  const targetUrl = res.ok ? await res.json() : null

  if (!targetUrl) {
    return NextResponse.redirect(origin)
  }
  return NextResponse.redirect(targetUrl)
}
