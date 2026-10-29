'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useSessionStore } from '@/lib/store/session'
import { buildAccount } from '@/lib/account-builder'
import LoadingTimer from '@/components/ui/loading-timer'

// QR 진입 — **PIN 이 먼저다.**
//
// 화면은 sallaria.web.app 의 PIN 입력 화면과 같은 꼴로 맞췄다. 두 QR웹이 같은 제품으로
// 읽혀야 하고, 거기서 다듬어 온 것들(네 칸 점·흔들림·토스트·숫자패드 치수)을 다시
// 만들 이유가 없다.
//
// 되살린 것 둘:
//   · 비밀번호를 잊으셨나요 — 이름+전화번호로 find_pin RPC 조회
//   · 개인정보처리방침 링크
// QR 로 들어왔으니 account_code 를 쥐고 있어서, find_pin 에 그대로 넘기면 이 계정 안에서만 찾는다.

const NUMPAD: string[][] = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','del']]

interface PublicInfo {
  valid:           boolean
  account_name:    string | null
  current_balance: number | null
  store_id:        string | null
  store_name:      string | null
  store_address:   string | null
  store_phone:     string | null
  store_rep_name:  string | null
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
}

function formatLock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function QrAccountEntryPage() {
  const { accountCode } = useParams<{ accountCode: string }>()
  const router = useRouter()
  const { setAccount, setLoginAt, setPinVerified } = useSessionStore()

  const [loading, setLoading] = useState(true)
  const [info, setInfo]       = useState<PublicInfo | null>(null)

  const [pin, setPin]           = useState('')
  /** 입력 중인 PIN 의 진짜 값. state 만 쓰면 같은 틱에 들어온 탭이
      전부 같은(낡은) 클로저 값을 읽어 한 자만 먹는다. */
  const pinRef = useRef('')
  const [pinError, setPinError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [isShaking, setIsShaking] = useState(false)
  const [toastVisible, setToastVisible] = useState(false)
  const [lockedUntil, setLockedUntil]   = useState<string | null>(null)
  const [lockNow, setLockNow] = useState(() => Date.now())

  // 비밀번호 찾기
  const [forgot, setForgot]           = useState(false)
  const [fName, setFName]             = useState('')
  const [fPhone, setFPhone]           = useState('')
  const [fError, setFError]           = useState('')
  const [fLoading, setFLoading]       = useState(false)
  const [fResult, setFResult]         = useState<{ accountName: string; pin: string } | null>(null)

  useEffect(() => {
    if (!lockedUntil) return
    setLockNow(Date.now())
    const id = setInterval(() => {
      if (new Date(lockedUntil).getTime() - Date.now() <= 0) {
        setLockedUntil(null); setPinError(''); clearInterval(id); return
      }
      setLockNow(Date.now())
    }, 1000)
    return () => clearInterval(id)
  }, [lockedUntil])

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = getSupabaseClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc('qr_account_public', { p_account_code: accountCode })
    setInfo((data?.[0] ?? null) as PublicInfo | null)
    setLoading(false)
  }, [accountCode])

  useEffect(() => { load() }, [load])

  function showError(msg: string) {
    setPinError(msg)
    setIsShaking(true)
    setToastVisible(true)
    setTimeout(() => setIsShaking(false), 400)
    setTimeout(() => setToastVisible(false), 2600)
  }

  const lockLeftMs = lockedUntil ? new Date(lockedUntil).getTime() - lockNow : 0
  const isLocked = lockLeftMs > 0

  function handleNumpad(key: string) {
    if (verifying || isLocked) return
    if (key === 'del') {
      pinRef.current = pinRef.current.slice(0, -1)
      setPin(pinRef.current)
      setPinError('')
      return
    }
    if (pinRef.current.length >= 4) return
    pinRef.current += key
    setPin(pinRef.current)
    setPinError('')
    if (pinRef.current.length === 4) void submitPin(pinRef.current)
  }

  /** 틀렸을 때 비우기 — ref 와 state 를 같이 되돌려야 다음 입력이 어긋나지 않는다 */
  function clearPin() {
    pinRef.current = ''
    setPin('')
  }

  async function submitPin(value: string) {
    setVerifying(true)
    try {
      // RPC 를 **직접** 부른다. 전엔 /api/pin 으로 한 번 돌았는데, 그 라우트는
      // verify_account_pin_public 을 그대로 중계만 했다. Vercel 함수 홉이 하나
      // 끼면서(콜드 스타트까지) PIN 한 번 넣는 데 왕복이 둘이 됐다.
      // 그 RPC 는 anon 실행이 열려 있고, 잠금·비교·시도기록을 DB 트랜잭션 안에서
      // 끝내고 참/거짓만 돌려주므로 브라우저에서 직접 불러도 노출되는 게 없다.
      const supabase = getSupabaseClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .rpc('verify_account_pin_public', { p_account_code: accountCode, p_pin: value })
      if (error) throw error
      const result = (Array.isArray(data) ? data[0] : data) ?? {}

      if (result.success) {
        if (!info) return
        setAccount(buildAccount(
          {
            account_code:    accountCode,
            account_name:    info.account_name ?? '',
            role:            '이용자',
            org_name:        null,
            current_balance: info.current_balance ?? 0,
          },
          info.store_id ?? '', info.store_name ?? '',
        ))
        setLoginAt(Date.now())
        setPinVerified(true)
        router.replace('/menu')
        return
      }

      if (result.reason === 'locked') {
        setLockedUntil(result.locked_until)
        showError('시도 횟수를 초과했어요. 잠시 후 다시 시도해 주세요.')
      } else if (result.reason === 'pin_not_set') {
        showError('아직 PIN이 설정되지 않았어요. 매장에 문의해 주세요.')
      } else {
        showError(`비밀번호가 일치하지 않아요 (${result.attempts_left ?? 0}회 남음)`)
      }
      clearPin()
    } catch {
      showError('오류가 발생했어요. 다시 시도해 주세요.')
      clearPin()
    } finally {
      setVerifying(false)
    }
  }

  async function submitForgot() {
    const name = fName.trim()
    if (!name || fPhone.replace(/\D/g, '').length < 10) {
      setFError('이름과 휴대폰 번호를 입력해 주세요.')
      return
    }
    setFLoading(true); setFError('')
    try {
      const supabase = getSupabaseClient()
      // 서버에서 대조하고 PIN 만 돌려준다 — 계정 목록이 클라이언트로 내려가지 않는다
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('find_pin', {
        p_store_id:     info?.store_id ?? null,
        p_name:         name,
        p_phone:        fPhone,
        p_account_code: accountCode,
      })
      if (error) { setFError('조회에 실패했어요. 잠시 후 다시 시도해 주세요.'); return }
      const match = (data as { account_name: string; pin_code: string }[] | null)?.[0]
      if (!match) { setFError('일치하는 정보를 찾을 수 없어요. 이름과 휴대폰 번호를 확인해 주세요.'); return }
      setFResult({ accountName: match.account_name, pin: match.pin_code })
    } finally {
      setFLoading(false)
    }
  }

  function closeForgot() {
    setForgot(false); setFResult(null); setFName(''); setFPhone(''); setFError('')
  }

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-surface">
        <LoadingTimer size={44} />
      </div>
    )
  }

  if (!info?.valid) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh text-center px-7 max-w-[430px] mx-auto bg-surface">
        <h1 className="text-[20px] font-extrabold text-[#1E1E1E] leading-snug">잘못된 QR이에요</h1>
        <p className="text-[14px] text-[#727272] mt-2.5">매장에 문의해 주세요</p>
      </div>
    )
  }

  // ── 비밀번호 찾기 결과 ──
  if (forgot && fResult) {
    return (
      <div className="flex flex-col min-h-dvh bg-surface px-6 pt-16 max-w-[430px] mx-auto">
        <button onClick={closeForgot} className="-ml-3 p-3 mb-10 self-start" aria-label="뒤로가기">
          <svg width="9" height="15" viewBox="0 0 9 15" fill="none"><path d="M8 1L1 7.5L8 14" stroke="#222222" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div className="flex flex-col gap-4">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mb-2 bg-ink">
            <span className="text-white text-3xl font-bold leading-none">✓</span>
          </div>
          <p className="text-[22px] font-bold text-[#222222] leading-snug">
            {fResult.accountName} 고객님,<br />
            비밀번호는 <span className="text-[#017333]">{fResult.pin}</span> 입니다.
          </p>
          <p className="text-[13px] text-[#727272]">확인 후 비밀번호를 입력해 주세요.</p>
        </div>
        <div className="mt-auto pb-10">
          <button onClick={closeForgot}
                  className="w-full py-4 rounded-2xl font-bold text-[16px] text-white bg-ink active:scale-[0.99] transition-transform">
            비밀번호 입력하러 가기
          </button>
        </div>
      </div>
    )
  }

  // ── 비밀번호 찾기 입력 ──
  if (forgot) {
    return (
      <div className="flex flex-col min-h-dvh bg-surface px-6 pt-16 max-w-[430px] mx-auto">
        <button onClick={closeForgot} className="-ml-3 p-3 mb-8 self-start" aria-label="뒤로가기">
          <svg width="9" height="15" viewBox="0 0 9 15" fill="none"><path d="M8 1L1 7.5L8 14" stroke="#222222" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <h1 className="text-[22px] font-bold text-[#222222] leading-snug mb-8">
          선결제 고객 확인을 위해<br />인증을 진행해 주세요
        </h1>

        <div className="flex flex-col gap-4">
          <input
            type="text" value={fName}
            onChange={e => { setFName(e.target.value); setFError('') }}
            placeholder="대표자 이름"
            className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3.5 text-[15px] text-[#222222] placeholder-[#C0C0C0] focus:outline-none focus:border-[#1E1E1E]"
          />
          <input
            type="tel" inputMode="numeric" value={fPhone}
            onChange={e => { setFPhone(formatPhone(e.target.value)); setFError('') }}
            placeholder="휴대폰 번호 (010-0000-0000)"
            className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3.5 text-[15px] text-[#222222] placeholder-[#C0C0C0] focus:outline-none focus:border-[#1E1E1E]"
          />
          {fError && <p className="text-[13px] text-[#C92A2A]">{fError}</p>}
        </div>

        <div className="mt-auto pb-10 pt-8">
          <button onClick={submitForgot} disabled={fLoading}
                  className="w-full py-4 rounded-2xl font-bold text-[16px] text-white bg-ink disabled:opacity-50">
            {fLoading ? '확인 중...' : '확인'}
          </button>
        </div>
      </div>
    )
  }

  // ── PIN 입력 ──
  return (
    <div className="flex flex-col min-h-dvh bg-surface max-w-[430px] mx-auto">
      {/* 맨 위에 계정명 — 좌측정렬. 네 칸 점과 숫자패드가 바로 아래 있어서
          "비밀번호를 치라"는 말은 없어도 읽힌다. 대신 "어느 거래처인지"는 글자로만 안다. */}
      <div className="px-6 pt-[52px] pb-8">
        <h1 className="text-[28px] font-bold text-[#222222] leading-tight break-keep">
          {info.account_name}
        </h1>
      </div>

      <div className={`flex justify-center gap-5 mb-2 mt-12 ${isShaking ? 'shake' : ''}`}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="w-[36px] h-[10px] flex items-center justify-center">
            {i < pin.length ? (
              <div className={`w-[10px] h-[10px] rounded-full transition-all duration-150 ${pinError ? 'bg-[#C92A2A]' : 'bg-[#222222]'}`} />
            ) : (
              <div className="w-full h-[2px] bg-[#D7D7D7] rounded-sm" />
            )}
          </div>
        ))}
      </div>

      <div className="min-h-[20px] mb-2" />

      {verifying && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface">
          <LoadingTimer size={44} />
        </div>
      )}

      <div className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${
        toastVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3 pointer-events-none'
      }`}>
        <div className="bg-[#FFF0F0] text-[#C92A2A] text-[13px] font-semibold px-5 py-3 rounded-2xl shadow-lg whitespace-nowrap">
          {isLocked ? `${formatLock(Math.ceil(lockLeftMs / 1000))} 후 다시 시도해 주세요` : pinError}
        </div>
      </div>

      <div className="px-6 flex-1 pt-5">
        <div className="grid grid-cols-3 gap-3">
          {NUMPAD.flat().map((key, idx) => {
            if (key === '') return <div key={idx} />
            if (key === 'del') {
              return (
                <button key={idx} onClick={() => handleNumpad('del')} disabled={isLocked}
                        className="h-[68px] rounded-2xl text-[22px] flex items-center justify-center select-none disabled:opacity-40"
                        aria-label="지우기">
                  ⌫
                </button>
              )
            }
            return (
              <button key={idx} onClick={() => handleNumpad(key)} disabled={verifying || isLocked}
                      className="h-[68px] rounded-2xl text-[22px] font-semibold text-[#222222] flex items-center justify-center select-none active:bg-[#F0F0F0] transition-colors disabled:opacity-40">
                {key}
              </button>
            )
          })}
        </div>

        {/* 비밀번호 찾기 — 0 버튼 바로 아래 */}
        <div className="grid grid-cols-3 mt-1">
          <div />
          <div className="flex justify-center">
            <button onClick={() => { setForgot(true); setFError('') }}
                    className="text-[13px] text-[#727272] underline underline-offset-2 py-2 whitespace-nowrap">
              비밀번호를 잊으셨나요?
            </button>
          </div>
          <div />
        </div>
      </div>

      <div className="flex justify-center pb-6 pt-1">
        <a href="/privacy" className="text-[11px] text-[#AAAAAA] underline underline-offset-2">
          개인정보처리방침
        </a>
      </div>
    </div>
  )
}
