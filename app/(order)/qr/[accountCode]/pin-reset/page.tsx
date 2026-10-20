'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { getSessionUser } from '@/lib/auth'
import PinKeypad from '@/components/ui/PinKeypad'

type Step = 'enter' | 'confirm' | 'done'

// 연속 숫자(1234, 4321)·동일 숫자(0000, 1111) 차단
function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin)) return true
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return true
  return false
}

export default function AccountPinResetPage() {
  const { accountCode } = useParams<{ accountCode: string }>()
  const router = useRouter()

  const [checking, setChecking] = useState(true)
  const [allowed, setAllowed]   = useState(false)
  const [accountName, setAccountName] = useState('')

  const [step, setStep]         = useState<Step>('enter')
  const [firstPin, setFirstPin] = useState('')
  const [digits, setDigits]     = useState<string[]>([])
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  const load = useCallback(async () => {
    setChecking(true)
    const user = await getSessionUser()
    if (!user) {
      setAllowed(false)
      setChecking(false)
      return
    }
    const supabase = getSupabaseClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc('qr_account_info', { p_account_code: accountCode })
    const row = data?.[0]
    setAccountName(row?.account_name ?? '')
    setAllowed(!!row?.valid && row.link_status === 'approved' && row.role === '관리자')
    setChecking(false)
  }, [accountCode])

  useEffect(() => { load() }, [load])

  function handleDigit(d: string) {
    if (digits.length >= 4 || loading) return
    const next = [...digits, d]
    setDigits(next)
    setError('')

    if (next.length === 4) {
      const pin = next.join('')
      if (step === 'enter') {
        if (isWeakPin(pin)) {
          setTimeout(() => {
            setError('다른 번호로 설정해 주세요')
            setDigits([])
          }, 200)
          return
        }
        setTimeout(() => {
          setFirstPin(pin)
          setDigits([])
          setStep('confirm')
        }, 200)
      } else {
        if (pin !== firstPin) {
          setTimeout(() => {
            setError('PIN이 일치하지 않아요. 다시 입력해 주세요.')
            setDigits([])
            setStep('enter')
            setFirstPin('')
          }, 200)
        } else {
          submitPin(pin)
        }
      }
    }
  }

  async function submitPin(pin: string) {
    setLoading(true)
    try {
      const res = await fetch('/api/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'encrypt', pin }),
      })
      const { encrypted } = await res.json()

      const supabase = getSupabaseClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase as any).rpc('account_pin_reset', {
        p_account_code: accountCode,
        p_pin_encrypted: encrypted,
      })
      if (rpcError) throw rpcError

      setStep('done')
    } catch (e) {
      console.error('PIN 재설정 실패:', e)
      setError('저장 중 오류가 발생했어요. 다시 시도해 주세요.')
      setDigits([])
      setStep('enter')
      setFirstPin('')
    } finally {
      setLoading(false)
    }
  }

  if (checking) {
    return (
      <div style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ fontSize: 13, color: '#727272' }}>불러오는 중...</p>
      </div>
    )
  }

  if (!allowed) {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        padding: '0 28px', maxWidth: 430, margin: '0 auto',
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1E1E1E', lineHeight: 1.4 }}>
          관리자만 PIN을 재설정할 수 있어요
        </h1>
        <p style={{ fontSize: 14, color: '#727272', marginTop: 10 }}>관리자에게 문의해 주세요</p>
      </div>
    )
  }

  if (step === 'done') {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        padding: '0 28px', maxWidth: 430, margin: '0 auto',
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1E1E1E', lineHeight: 1.4 }}>
          PIN이 재설정됐어요
        </h1>
        <p style={{ fontSize: 14, color: '#727272', marginTop: 10 }}>새 PIN으로 다시 로그인해 주세요</p>
        <button
          onClick={() => router.replace(`/qr/${accountCode}`)}
          style={{ marginTop: 24, padding: '12px 24px', borderRadius: 12, background: '#1E1E1E', color: '#fff', border: 'none', fontSize: 15, fontWeight: 700 }}
        >
          확인
        </button>
      </div>
    )
  }

  return (
    <PinKeypad
      digits={digits}
      onDigit={handleDigit}
      onDelete={() => { setDigits(prev => prev.slice(0, -1)); setError('') }}
      disabled={loading}
      error={error}
      header={
        <>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#1E1E1E', margin: 0, lineHeight: 1.35 }}>
            {step === 'enter'
              ? <>{accountName}의<br />새 PIN번호를 입력해주세요</>
              : '한번 더 입력해주세요'}
          </h1>
        </>
      }
    />
  )
}
