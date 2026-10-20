'use client'

import { useState, Suspense } from 'react'
import Image from 'next/image'
import { useSearchParams } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import KakaoLoginButton from '@/components/KakaoLoginButton'

export default function AuthPage() {
  return (
    <Suspense>
      <AuthPageInner />
    </Suspense>
  )
}

function AuthPageInner() {
  const searchParams = useSearchParams()
  const storeId = searchParams.get('store') ?? ''
  const token   = searchParams.get('token') ?? ''
  const error = searchParams.get('error')
  const [loading, setLoading] = useState(false)

  async function handleKakaoLogin() {
    setLoading(true)
    const supabase = getSupabaseClient()
    // token(QR) 또는 store 파라미터를 콜백까지 보존
    const returnParam = token
      ? `?token=${token}`
      : storeId ? `?store=${storeId}` : ''
    const redirectTo = `${window.location.origin}/auth/callback/${returnParam}`
    await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        redirectTo,
        scopes: 'account_email profile_nickname profile_image',
      },
    })
    setLoading(false)
  }

  return (
    <div
      className="flex flex-col"
      style={{ height: '100dvh', overflow: 'hidden', background: 'var(--terra-bg)' }}
    >
      {/* 로고 */}
      <div
        className="flex justify-center pt-6"
        style={{ animation: 'fadeSlideUp 0.5s ease both' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 180 }}>
          <Image
            src="/sunpos-logo.png"
            alt="sunpos"
            width={180}
            height={70}
            style={{ objectFit: 'contain', display: 'block' }}
            priority
          />
          <p style={{
            width: '100%',
            textAlign: 'center',
            fontSize: 20,
            fontWeight: 500,
            color: '#222222',
            letterSpacing: '0.08em',
            fontFamily: "'Pretendard Variable', Pretendard, sans-serif",
            marginTop: -18,
          }}>
            선결제 QR 오더
          </p>
        </div>
      </div>

      {/* 카드 1장 — 정가운데 */}
      <div
        className="flex-1 flex items-center justify-center"
        style={{ animation: 'fadeSlideUp 0.5s ease 0.15s both', minHeight: 0 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/card.svg"
          alt="sunpos card"
          style={{
            width: '85%',
            maxWidth: 340,
            maxHeight: '42vh',
            objectFit: 'contain',
            animation: 'floatB 4.8s ease-in-out infinite',
          }}
        />
      </div>

      {/* 에러 */}
      {error && (
        <div className="mx-6 mb-3 px-4 py-3 rounded-xl" style={{ background: '#FFF0F0' }}>
          <p style={{ fontSize: 13, color: '#C92A2A' }}>
            {error === 'auth_failed'
              ? '로그인에 실패했습니다. 다시 시도해 주세요.'
              : decodeURIComponent(error)}
          </p>
        </div>
      )}

      {/* 카카오 로그인 버튼 */}
      <div
        className="px-6"
        style={{
          paddingBottom: 'max(2.5rem, calc(env(safe-area-inset-bottom) + 1.5rem))',
          animation: 'fadeSlideUp 0.5s ease 0.25s both',
        }}
      >
        <KakaoLoginButton onClick={handleKakaoLogin} loading={loading} />
        <div className="flex justify-center mt-4">
          <a
            href="/privacy"
            style={{ fontSize: 11, color: '#AAAAAA', textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            개인정보처리방침
          </a>
        </div>
      </div>
    </div>
  )
}
