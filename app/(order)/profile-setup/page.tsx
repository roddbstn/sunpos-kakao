'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSessionStore } from '@/lib/store/session'
import {
  getSunposProfile, updateSunposProfile,
  getSunposAddresses, upsertSunposAddress, updateSunposAddress, deleteSunposAddress, geocodeAddress,
  type SunposAddress,
} from '@/lib/auth'
import ProgressBar from '@/components/ProgressBar'
import { searchAddress, pickRoadAddress } from '@/lib/daumPostcode'

export default function ProfileSetupPage() {
  return (
    <Suspense>
      <ProfileSetupInner />
    </Suspense>
  )
}

// 전화번호 하이픈 포맷 (숫자만 추출 후 010-XXXX-XXXX 형식)
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 3) return digits
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
}

type FormMode = 'none' | 'new' | string  // string = 수정 중인 주소 id

function ProfileSetupInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const storeId = searchParams.get('store') ?? ''
  const accountCode = searchParams.get('account') ?? ''

  const { kakaoUser, setOrderer, setPhone } = useSessionStore()

  const [name, setName]               = useState('')
  const [phone, setPhoneInput]        = useState('')
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [profileLoaded, setProfileLoaded] = useState(false)

  // ── 배달받을 주소 ──────────────────────────────────────────────────────────
  const [addresses, setAddresses]           = useState<SunposAddress[]>([])
  const [addressesLoading, setAddressesLoading] = useState(true)
  const [formMode, setFormMode]             = useState<FormMode>('none')
  const [draftRoadAddress, setDraftRoadAddress]     = useState('')
  const [draftDetailAddress, setDraftDetailAddress] = useState('')
  const [addressSaving, setAddressSaving]   = useState(false)
  const [addressError, setAddressError]     = useState('')
  const [pendingOldest, setPendingOldest]   = useState<string | null>(null)  // FIFO 확인 모달
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId]         = useState<string | null>(null)

  async function loadAddresses() {
    setAddressesLoading(true)
    try {
      const list = await getSunposAddresses()
      setAddresses(list)
    } finally {
      setAddressesLoading(false)
    }
  }

  // 카카오 닉네임·전화번호 + 저장된 프로필 미리 채우기
  useEffect(() => {
    async function load() {
      const profile = await getSunposProfile()
      setName(profile?.nickname || kakaoUser?.nickname || '')
      // 저장된 전화번호 우선, 없으면 카카오 제공 전화번호, 없으면 010 기본값
      const savedPhone = profile?.phone || kakaoUser?.phone || '010'
      setPhoneInput(formatPhone(savedPhone))
      setProfileLoaded(true)
    }
    load()
    loadAddresses()
  }, [kakaoUser])

  // "주소 찾기" 한 번 탭으로 새 주소 입력 폼을 열면서 바로 도로명 주소 검색까지 이어간다
  // (기존엔 "+ 새 주소 추가" → 폼 안의 "주소 검색" 두 번 탭해야 했음).
  async function openAddAddressForm() {
    setFormMode('new')
    setDraftRoadAddress('')
    setDraftDetailAddress('')
    setAddressError('')
    const data = await searchAddress()
    setDraftRoadAddress(pickRoadAddress(data))
  }

  function openEditAddressForm(addr: SunposAddress) {
    setFormMode(addr.id)
    setDraftRoadAddress(addr.roadAddress)
    setDraftDetailAddress(addr.detailAddress ?? '')
    setAddressError('')
  }

  function closeAddressForm() {
    setFormMode('none')
    setDraftRoadAddress('')
    setDraftDetailAddress('')
    setAddressError('')
    setPendingOldest(null)
  }

  async function openAddressSearch() {
    const data = await searchAddress()
    setDraftRoadAddress(pickRoadAddress(data))
  }

  async function saveAddressForm(confirmDeleteOldest = false) {
    if (!draftRoadAddress.trim()) { setAddressError('도로명 주소를 먼저 검색해 주세요.'); return }
    setAddressSaving(true)
    setAddressError('')
    try {
      const coords = await geocodeAddress(draftRoadAddress)
      if (!coords) {
        setAddressError('주소로 좌표를 찾지 못했어요. 주소를 다시 확인해 주세요.')
        return
      }

      if (formMode === 'new') {
        const result = await upsertSunposAddress({
          roadAddress:   draftRoadAddress,
          detailAddress: draftDetailAddress,
          lat:           coords.lat,
          lng:           coords.lng,
          confirmDeleteOldest,
        })
        if (result.needsConfirmation) {
          setPendingOldest(result.oldestAddress)
          return
        }
      } else if (formMode !== 'none') {
        await updateSunposAddress(formMode, {
          roadAddress:   draftRoadAddress,
          detailAddress: draftDetailAddress,
          lat:           coords.lat,
          lng:           coords.lng,
        })
      }

      await loadAddresses()
      closeAddressForm()
    } catch {
      setAddressError('저장 중 오류가 발생했어요. 다시 시도해 주세요.')
    } finally {
      setAddressSaving(false)
    }
  }

  async function confirmDeleteAddress(id: string) {
    setDeletingId(id)
    try {
      await deleteSunposAddress(id)
      await loadAddresses()
    } finally {
      setDeletingId(null)
      setDeleteConfirmId(null)
    }
  }

  // 주소는 선택사항 — 포장/내점만 쓰는 손님에게 가입 단계에서 주소를 강요하지 않는다.
  // 배달을 처음 고를 때 체크아웃에서 자연스럽게 저장하도록 유도한다 (checkout/page.tsx 참고).
  async function handleNext() {
    if (!name.trim())  { setError('이름을 입력해 주세요.'); return }
    if (!phone.trim()) { setError('전화번호를 입력해 주세요.'); return }

    setLoading(true)
    setError('')
    try {
      await updateSunposProfile({
        nickname: name.trim(),
        phone:    phone.trim(),
      })

      setOrderer(name.trim())
      setPhone(phone.trim())

      // account 파라미터가 있으면 qr/[accountCode] 진입 흐름이었던 것 — 그 화면으로 돌아가면
      // PIN 입력 등 이후 단계로 이어짐. 아니면 루트로 돌아가 store 기준 흐름을 이어감.
      router.replace(accountCode ? `/qr/${accountCode}/` : storeId ? `/?store=${storeId}` : '/')
    } catch {
      setError('저장 중 오류가 발생했습니다. 다시 시도해 주세요.')
    } finally {
      setLoading(false)
    }
  }

  if (!profileLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface">
        <div className="w-8 h-8 rounded-full border-2 border-[#D7D7D7] border-t-[#017333] animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen bg-surface px-6">
      {/* 프로그레스 바 */}
      <div className="pt-4 pb-0">
        <ProgressBar step={1} />
      </div>

      {/* 헤더 */}
      <div className="pt-8 pb-6">
        <h1 style={{ fontSize: 26, fontWeight: 800, color: '#222222', lineHeight: 1.35, margin: 0 }}>
          이름과 연락처를<br />알려주세요
        </h1>
      </div>

      {/* 입력 필드 */}
      <div className="flex flex-col gap-5">
        {/* 이름 */}
        <div>
          <p className="text-[13px] font-semibold text-[#222222] mb-2">이름</p>
          <input
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); setError('') }}
            placeholder="이름을 입력해 주세요"
            className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3.5 text-[15px] text-[#222222] placeholder-[#C0C0C0] focus:outline-none focus:border-[#017333]"
          />
        </div>

        {/* 전화번호 */}
        <div>
          <p className="text-[13px] font-semibold text-[#222222] mb-2">전화번호</p>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={e => { setPhoneInput(formatPhone(e.target.value)); setError('') }}
            placeholder="010-0000-0000"
            className="w-full border border-[#D7D7D7] rounded-xl px-4 py-3.5 text-[15px] text-[#222222] placeholder-[#C0C0C0] focus:outline-none focus:border-[#017333]"
          />
        </div>

        {/* 배달받을 주소 */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <p className="text-[13px] font-semibold text-[#222222]">배달받을 주소</p>
            <span className="text-[11px] text-[#AAAAAA] font-normal">선택</span>
          </div>

          {addressesLoading ? (
            <div className="w-8 h-8 mx-auto rounded-full border-2 border-[#D7D7D7] border-t-[#017333] animate-spin" />
          ) : (
            <div className="flex flex-col gap-2">
              {addresses.map(addr => (
                <div key={addr.id} className="border border-[#D7D7D7] rounded-xl px-4 py-3.5">
                  {formMode === addr.id ? (
                    <AddressForm
                      draftRoadAddress={draftRoadAddress}
                      draftDetailAddress={draftDetailAddress}
                      onSearch={openAddressSearch}
                      onDetailChange={setDraftDetailAddress}
                      onSave={() => saveAddressForm(false)}
                      onCancel={closeAddressForm}
                      saving={addressSaving}
                      error={addressError}
                    />
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold text-[#222222] truncate">
                          {addr.roadAddress}
                        </p>
                        {addr.detailAddress && (
                          <p className="text-[13px] text-[#727272] mt-0.5 truncate">{addr.detailAddress}</p>
                        )}
                      </div>
                      <div className="flex gap-1.5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => openEditAddressForm(addr)}
                          className="px-2.5 py-1 bg-[#F2F2F2] text-[#222222] rounded-lg text-[12px] font-semibold"
                        >
                          수정
                        </button>
                        {deleteConfirmId === addr.id ? (
                          <button
                            type="button"
                            onClick={() => confirmDeleteAddress(addr.id)}
                            disabled={deletingId === addr.id}
                            className="px-2.5 py-1 bg-[#C92A2A] text-white rounded-lg text-[12px] font-semibold disabled:opacity-50"
                          >
                            {deletingId === addr.id ? '삭제 중' : '한번 더 눌러 삭제'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(addr.id)}
                            className="px-2.5 py-1 bg-[#F2F2F2] text-[#C92A2A] rounded-lg text-[12px] font-semibold"
                          >
                            삭제
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {formMode === 'new' ? (
                <div className="border border-[#D7D7D7] rounded-xl px-4 py-3.5">
                  <AddressForm
                    draftRoadAddress={draftRoadAddress}
                    draftDetailAddress={draftDetailAddress}
                    onSearch={openAddressSearch}
                    onDetailChange={setDraftDetailAddress}
                    onSave={() => saveAddressForm(false)}
                    onCancel={closeAddressForm}
                    saving={addressSaving}
                    error={addressError}
                  />
                  {pendingOldest && (
                    <div className="mt-3 px-3 py-2.5 bg-[#FFF8E6] rounded-lg">
                      <p className="text-[12px] text-[#926C00] leading-relaxed">
                        주소는 최대 10개까지 저장돼요. 가장 오래된 주소 <strong>&apos;{pendingOldest}&apos;</strong>가 삭제되고 새 주소로 교체됩니다.
                      </p>
                      <div className="flex gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => saveAddressForm(true)}
                          disabled={addressSaving}
                          className="px-3 py-1.5 bg-[#222222] text-white rounded-lg text-[12px] font-semibold disabled:opacity-50"
                        >
                          {addressSaving ? '저장 중...' : '확인하고 교체'}
                        </button>
                        <button
                          type="button"
                          onClick={closeAddressForm}
                          className="px-3 py-1.5 bg-[#F2F2F2] text-[#727272] rounded-lg text-[12px] font-semibold"
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={openAddAddressForm}
                    className="flex items-center gap-1.5 bg-[#F2F2F2] text-[#222222] rounded-full pl-3 pr-4 py-2.5 text-[13px] font-semibold"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    주소 찾기
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-3 rounded-xl bg-[#FFF0F0]">
            <p className="text-[13px] text-[#C92A2A]">{error}</p>
          </div>
        )}
      </div>

      <div className="mt-auto pb-10 pt-8">
        <button
          onClick={handleNext}
          disabled={loading || !name.trim() || !phone.trim()}
          className="w-full py-4 rounded-2xl font-bold text-[16px] text-white disabled:opacity-50"
          style={{ background: '#2C261F' }}
        >
          {loading ? '저장 중...' : '다음'}
        </button>
      </div>
    </div>
  )
}

function AddressForm({
  draftRoadAddress, draftDetailAddress, onSearch, onDetailChange, onSave, onCancel, saving, error,
}: {
  draftRoadAddress: string
  draftDetailAddress: string
  onSearch: () => void
  onDetailChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  error: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="flex-1 border border-[#D7D7D7] rounded-xl px-3 py-2.5 text-[13px] bg-[#F2F2F2] text-[#222222] min-h-[44px] flex items-center">
          {draftRoadAddress ? <span>{draftRoadAddress}</span> : <span className="text-[#D7D7D7]">도로명 주소</span>}
        </div>
        <button
          type="button"
          onClick={onSearch}
          className="flex-shrink-0 px-3 py-2.5 bg-[#222222] text-white text-[12px] font-semibold rounded-xl"
        >
          주소 검색
        </button>
      </div>
      <input
        type="text"
        value={draftDetailAddress}
        onChange={e => onDetailChange(e.target.value)}
        placeholder="상세 주소 (예: 2층, 101호)"
        maxLength={60}
        className="w-full border border-[#D7D7D7] rounded-xl px-3 py-2.5 text-[13px] text-[#222222] placeholder:text-[#D7D7D7] outline-none focus:border-[#222222]"
      />
      {error && <p className="text-[12px] text-[#C92A2A]">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-[#F2F2F2] text-[#727272] rounded-lg text-[12px] font-semibold">
          취소
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !draftRoadAddress.trim()}
          className="px-3 py-1.5 bg-[#222222] text-white rounded-lg text-[12px] font-semibold disabled:opacity-50"
        >
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  )
}
