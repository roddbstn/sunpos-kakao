'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

const ERROR_MESSAGES: Record<string, { title: string; desc: string }> = {
  invalid_card:   { title: '잘못된 카드예요', desc: '카드 번호가 올바르지 않아요.\n매장에 문의해 주세요.' },
  card_not_found: { title: '등록되지 않은 카드예요', desc: '이 카드는 아직 등록되지 않았어요.\n매장에 문의해 주세요.' },
  token_not_found:    { title: 'QR 코드를 다시 스캔해 주세요', desc: '유효하지 않은 QR 코드예요.' },
  token_already_used: { title: 'QR 코드를 다시 스캔해 주세요', desc: '이미 사용된 QR 코드예요.\n카드를 다시 스캔해 주세요.' },
  token_expired:      { title: 'QR 코드가 만료됐어요', desc: 'QR 코드 유효 시간(5분)이 지났어요.\n카드를 다시 스캔해 주세요.' },
  token_invalid:      { title: 'QR 코드를 다시 스캔해 주세요', desc: '인식할 수 없는 QR 코드예요.' },
  no_session:     { title: '세션이 만료됐어요', desc: '카드를 다시 스캔해 주세요.' },
  server_error:   { title: '서버 오류가 발생했어요', desc: '잠시 후 다시 시도해 주세요.' },
}

const DEFAULT_ERROR = { title: '오류가 발생했어요', desc: '잠시 후 다시 시도해 주세요.' }

export default function ErrorPage() {
  return (
    <Suspense fallback={<ErrorView title={DEFAULT_ERROR.title} desc={DEFAULT_ERROR.desc} />}>
      <ErrorInner />
    </Suspense>
  )
}

function ErrorInner() {
  const searchParams = useSearchParams()
  const code = searchParams.get('code') ?? ''
  const msg = ERROR_MESSAGES[code] ?? DEFAULT_ERROR
  return <ErrorView title={msg.title} desc={msg.desc} />
}

function ErrorView({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--surface)', maxWidth: 430, margin: '0 auto', padding: '0 28px',
      textAlign: 'center',
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: '#FFF8E1',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 24, fontSize: 32,
      }}>
        ⚠️
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1E1E1E', margin: '0 0 12px', lineHeight: 1.35 }}>
        {title}
      </h1>
      <p style={{ fontSize: 14, color: '#727272', margin: 0, lineHeight: 1.7, whiteSpace: 'pre-line' }}>
        {desc}
      </p>
    </div>
  )
}
