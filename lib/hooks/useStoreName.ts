'use client'

import { useState, useEffect } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'

// 매장 ID로 매장명을 조회하는 훅.
// auth, account-setup, pending 등 여러 페이지에서 공통으로 사용.
export function useStoreName(storeId: string | undefined): string {
  const [storeName, setStoreName] = useState('')

  useEffect(() => {
    if (!storeId) return
    const supabase = getSupabaseClient()
    supabase
      .from('stores')
      .select('name')
      .eq('id', storeId)
      .maybeSingle()
      .then(({ data }: { data: { name: string } | null }) => {
        if (data?.name) setStoreName(data.name)
      })
  }, [storeId])

  return storeName
}
