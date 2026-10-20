'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getSupabaseClient } from '@/lib/supabase/client'
import {
  getSessionUser, getSunposProfile, updateSunposProfile,
  getSunposAddresses, deleteSunposAddress,
  type SunposAddress,
} from '@/lib/auth'
import AddressAddModal from '@/components/AddressAddModal'
import ScreenHeader from '@/components/ui/screen-header'
import { formatWon, isLowBalance } from '@/lib/utils'

// 설정 — 내 정보와 이 계정의 사람들, 그리고 가게.
//
// 전엔 **관리자만** 볼 수 있었고 내용은 초대링크 + 링크 해제가 전부였다.
// 초대링크가 사라졌으니(QR + PIN 으로 셀프 등록) 이 화면의 일이 바뀐다:
//   내 정보(이름 · 전화번호)  — 내가 고칠 수 있는 것
//   가게 정보                 — 어디서 파는 음식인지
//   배달 주소                 — 주소 추가 모달로만 넣는다
//   이용자                    — 이 장부를 누가 쓰는지
//
// 주소는 전부 지울 수 있다. 하나도 없어도 주문 확인 화면에서 그 자리에서 넣을 수 있어서,
// 여기서 막아봐야 "지우려면 먼저 추가하세요" 같은 수수께끼만 남는다.

function Section({ title, right, children }: {
  title?: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section className="mt-7">
      {(title || right) && (
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-[13px] font-bold text-[#727272]">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

/** 선포스 주문 화면 우상단의 쓰레기통과 같은 아이콘 */
function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.8 7v4M9.2 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

interface Person { name: string; phone: string | null; role: '관리자' | '이용자'; is_me: boolean }
type Addr = SunposAddress
interface Info {
  valid: boolean
  account_name: string | null
  current_balance: number | null
  store_name: string | null
  store_address: string | null
  store_phone: string | null
  store_rep_name: string | null
}

export default function AccountSettingsPage() {
  const { accountCode } = useParams<{ accountCode: string }>()
  const router = useRouter()

  const [checking, setChecking] = useState(true)
  const [allowed,  setAllowed]  = useState(false)
  const [info,     setInfo]     = useState<Info | null>(null)
  const [people,   setPeople]   = useState<Person[]>([])
  const [addrs,    setAddrs]    = useState<Addr[]>([])
  const [myPhone,  setMyPhone]  = useState('')
  const [myNick,   setMyNick]   = useState('')
  const [editPhone, setEditPhone] = useState(false)
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState('')
  const [addOpen,  setAddOpen]  = useState(false)
  const [editAddr, setEditAddr] = useState<Addr | null>(null)

  const load = useCallback(async () => {
    setChecking(true)
    setError('')
    const user = await getSessionUser()
    if (!user) { setAllowed(false); setChecking(false); return }

    const supabase = getSupabaseClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: infoData } = await (supabase as any).rpc('qr_account_public', { p_account_code: accountCode })
    setInfo((infoData?.[0] ?? null) as Info | null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: peopleData, error: peopleErr } = await (supabase as any)
      .rpc('account_people', { p_account_code: accountCode })
    if (peopleErr) { setAllowed(false); setChecking(false); return }
    setPeople((peopleData ?? []) as Person[])
    setAllowed(true)

    const profile = await getSunposProfile()
    setMyPhone(profile?.phone ?? '')
    setMyNick(profile?.nickname ?? '')
    setAddrs(await getSunposAddresses())
    setChecking(false)
  }, [accountCode])

  useEffect(() => { load() }, [load])

  function fmtPhone(v: string): string {
    const d = v.replace(/[^0-9]/g, '').slice(0, 11)
    if (d.length < 4)      return d
    if (d.length < 8)      return `${d.slice(0, 3)}-${d.slice(3)}`
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
  }

  async function savePhone() {
    const digits = myPhone.replace(/[^0-9]/g, '')
    if (digits.length < 10) { setError('전화번호를 확인해 주세요'); return }
    setBusy(true); setError('')
    try { await updateSunposProfile({ nickname: myNick, phone: digits }); setEditPhone(false) }
    catch { setError('전화번호를 저장하지 못했어요') }
    finally { setBusy(false) }
  }

  async function removeAddress(id: string) {
    setBusy(true); setError('')
    try { await deleteSunposAddress(id); await load() }
    catch { setError('주소를 지우지 못했어요') }
    finally { setBusy(false) }
  }

  if (checking) {
    return (
      <div className="h-dvh flex items-center justify-center">
        <p className="text-[13px] text-[#727272]">불러오는 중...</p>
      </div>
    )
  }

  if (!allowed) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center text-center px-7 max-w-[430px] mx-auto">
        <h1 className="text-[20px] font-extrabold text-[#1E1E1E] leading-snug">이 계정의 이용자가 아니에요</h1>
        <p className="text-[14px] text-[#727272] mt-2.5">QR을 다시 찍고 PIN을 입력해 주세요</p>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-surface max-w-[430px] mx-auto flex flex-col">
      <ScreenHeader title="설정" onBack={() => router.back()} />

      <div className="px-5 pb-10">
      {/* 내 정보 — 라벨 없이 이름 · 전화번호 한 줄.
          '내 전화번호'라는 제목은 바로 아래 번호가 이미 말하고 있다.
          맨 위 블록이라 상단 여백은 mt-7 이 아니라 mt-4 — 헤더 바로 밑에서 뜨지 않게. */}
      <section className="mt-4">
        {editPhone ? (
          <div className="flex items-center gap-2">
            <input
              value={fmtPhone(myPhone)}
              onChange={e => setMyPhone(e.target.value)}
              inputMode="numeric"
              autoFocus
              className="flex-1 min-w-0 h-[48px] px-4 rounded-xl border border-[#D7D7D7] text-[15px] text-[#1E1E1E] outline-none focus:border-[#1E1E1E]"
            />
            <button onClick={savePhone} disabled={busy}
                    className="flex-shrink-0 h-[34px] px-3.5 rounded-lg bg-[#F5F5F5] text-[#222222] text-[12px] font-semibold disabled:opacity-40">
              저장
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[15px] text-[#1E1E1E]">
              {myNick || '—'}{myPhone ? ` · ${fmtPhone(myPhone)}` : ''}
            </p>
            <button onClick={() => setEditPhone(true)}
                    className="flex-shrink-0 h-[34px] px-3.5 rounded-lg bg-[#F5F5F5] text-[#222222] text-[12px] font-semibold">
              수정
            </button>
          </div>
        )}
      </section>

      {/* 계정 — 메뉴 리스트 상단의 잔액 박스와 같은 모양으로 맞춘다.
          같은 값(거래처·잔액)이 화면마다 다른 꼴이면 같은 것으로 안 읽힌다. */}
      <div className={`mt-7 rounded-xl px-4 py-3 flex items-center justify-between ${
        (info?.current_balance ?? 0) < 0 ? 'bg-[#FFF0F0]' : 'bg-gray-50'
      }`}>
        <span className="text-[13px] font-light text-[#1E1E1E]">{info?.account_name}</span>
        <div className="text-right">
          <div className="text-[13px] font-light text-ink">선결제 잔액</div>
          <div className={`text-[13px] font-bold ${isLowBalance(info?.current_balance ?? 0) ? 'text-danger' : 'text-ink'}`}>
            {formatWon(info?.current_balance ?? 0)}
          </div>
        </div>
      </div>

      {error && <p className="text-[13px] text-[#C92A2A] mt-4">{error}</p>}

      {/* 배달 주소 — 추가는 모달에서만. 여기선 보여주고 지우기만 한다.
          그래서 도로명과 상세 주소가 같은 글자 자리에서 시작한다(전엔 상세가 입력칸이라
          안쪽 패딩만큼 더 들어가 있었다). */}
      <Section>
        <div className="flex flex-col gap-2">
          {addrs.length === 0 && (
            <div className="rounded-xl border border-dashed border-[#D7D7D7] py-7 text-center text-[13px] text-[#ADADAD]">
              등록된 주소가 없어요
            </div>
          )}
          {/* 맨 위가 '현재 배달 주소'다 — 메뉴 화면 상단에 뜨는 것도 이것이다.
              어느 걸 쓰는지 안 보이면 주소를 여러 개 둔 의미가 없다. */}
          {addrs.map((a, i) => (
            <div key={a.id} className={`rounded-xl px-3.5 py-3 flex items-center justify-between gap-3 ${
              i === 0 ? 'border-[1.5px] border-[#1E1E1E] bg-[#FAFAFA]' : 'border border-[#D7D7D7]'
            }`}>
              <button
                type="button"
                onClick={() => setEditAddr(a)}
                className="min-w-0 flex-1 text-left"
              >
                {i === 0 && (
                  <span className="inline-block mb-1 text-[11px] font-bold rounded-md px-1.5 py-0.5 bg-ink text-white">
                    현재 배달 주소
                  </span>
                )}
                <p className="text-[14px] text-[#1E1E1E] leading-snug">{a.roadAddress}</p>
                {a.detailAddress && (
                  <p className="text-[13px] text-[#727272] leading-snug mt-1">{a.detailAddress}</p>
                )}
              </button>
              <button
                onClick={e => { e.stopPropagation(); removeAddress(a.id) }}
                disabled={busy}
                aria-label="주소 삭제"
                className="flex-shrink-0 w-[32px] h-[32px] rounded-lg flex items-center justify-center text-[#ADADAD] active:bg-[#F2F2F2] disabled:opacity-40"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setAddOpen(true)}
            disabled={busy}
            className="w-full py-[12px] px-7 bg-ink text-white rounded-xl font-bold text-[15px] active:scale-95 transition-transform disabled:opacity-40"
          >
            주소 추가
          </button>
        </div>
      </Section>

      {/* 가게 정보 — 섹션 제목을 따로 두지 않는다. 첫 줄 레이블이 곧 제목 노릇을 해서
          '선결제 가게'가 두 번 적히던 걸 한 번으로 줄였다. */}
      <Section>
        <div className="rounded-xl border border-[#D7D7D7] px-3.5 py-3 flex flex-col gap-1.5">
          {([
            ['선결제 가게', info?.store_name],
            ['주소',   info?.store_address],
            ['연락처', info?.store_phone],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 text-[13px]">
              <span className="text-[#727272] flex-shrink-0">{label}</span>
              <span className="text-[#1E1E1E] text-right">{value || '—'}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 이용자 */}
      <Section title="계정 이용자">
        <div className="flex flex-col gap-2">
          {people.map(p => (
            <div key={`${p.role}-${p.name}`} className="rounded-xl border border-[#D7D7D7] px-3.5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-[#1E1E1E] truncate">{p.name}</div>
                <div className="text-[12px] text-[#AAAAAA] mt-0.5">{p.phone || '—'}</div>
              </div>
              <span className="flex-shrink-0 text-[11px] font-bold rounded-md px-1.5 py-0.5 bg-[#F2F2F2] text-[#1E1E1E]">
                {p.role}
              </span>
            </div>
          ))}
        </div>
      </Section>

      </div>

      {(addOpen || editAddr) && (
        <AddressAddModal
          editing={editAddr ?? undefined}
          onClose={() => { setAddOpen(false); setEditAddr(null) }}
          onSaved={() => { setAddOpen(false); setEditAddr(null); load() }}
        />
      )}

    </div>
  )
}
