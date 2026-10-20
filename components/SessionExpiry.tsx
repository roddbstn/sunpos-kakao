'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useSessionStore } from '@/lib/store/session'

// 주문 완료 흐름 중에는 만료 체크 제외
// /register, /qr: 로그인 전(또는 무로그인) 상태로 진입하는 화면이라, "로그아웃 감지"가
// 최초 방문을 SIGNED_OUT으로 오인해서 즉시 /로 튕겨버리는 걸 막아야 함
const EXEMPT_PATHS = ['/cart', '/checkout', '/success', '/register', '/qr']

export default function SessionExpiry() {
  const router   = useRouter()
  const pathname = usePathname()
  const { account, resetSession } = useSessionStore()

  useEffect(() => {
    if (EXEMPT_PATHS.some(p => pathname?.startsWith(p))) return
    if (account?.isDemo) return

    const supabase = getSupabaseClient()

    // Supabase Auth 세션 만료/로그아웃 감지
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: string) => {
      if (event === 'SIGNED_OUT') {
        resetSession()
        const storeId = account?.storeId
        router.replace(storeId ? `/?store=${storeId}` : '/')
      }
    })

    return () => subscription.unsubscribe()
  }, [pathname, account, resetSession, router])

  return null
}
