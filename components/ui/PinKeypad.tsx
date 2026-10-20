'use client'

import { useState } from 'react'

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'] as const

interface Props {
  digits: string[]
  onDigit: (d: string) => void
  onDelete: () => void
  disabled?: boolean
  error?: string
  errorOverride?: string  // 에러 문구를 외부에서 강제 표시할 때 (잠금 카운트다운 등)
  header?: React.ReactNode
  extra?: React.ReactNode  // 도트 아래 추가 콘텐츠
}

/**
 * 공용 PIN 키패드
 * - 도트 4개 인디케이터
 * - 3×4 숫자 그리드
 * qr/[accountCode] PIN 검증, pin-reset 공통 사용
 */
export default function PinKeypad({
  digits, onDigit, onDelete,
  disabled = false,
  error, errorOverride,
  header, extra,
}: Props) {
  const displayError = errorOverride || error
  const [pressedIdx, setPressedIdx] = useState<number | null>(null)

  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      background: 'var(--surface)', maxWidth: 430, margin: '0 auto',
    }}>
      {/* 헤더 슬롯 */}
      {header && (
        <div style={{ padding: '56px 28px 0' }}>
          {header}
        </div>
      )}

      {/* 도트 인디케이터 + 에러 + 추가 콘텐츠 */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 32,
      }}>
        <div style={{ display: 'flex', gap: 20 }}>
          {[0,1,2,3].map(i => (
            <div
              key={i}
              style={{
                width: 16, height: 16, borderRadius: '50%',
                background: disabled ? '#E0E0E0' : i < digits.length ? '#1E1E1E' : '#E0E0E0',
                transition: 'background 0.15s ease',
              }}
            />
          ))}
        </div>

        {displayError && (
          <p style={{
            fontSize: 13, color: '#C92A2A',
            textAlign: 'center', margin: 0, padding: '0 24px',
          }}>
            {displayError}
          </p>
        )}

        {extra}
      </div>

      {/* 숫자 키패드 */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 2, padding: '0 0 max(2rem, env(safe-area-inset-bottom))',
      }}>
        {KEYS.map((key, idx) => {
          if (key === '') return <div key={idx} />
          const isDelete = key === '⌫'
          const isPressed = pressedIdx === idx
          return (
            <button
              key={idx}
              onClick={() => isDelete ? onDelete() : onDigit(key)}
              onPointerDown={() => setPressedIdx(idx)}
              onPointerUp={() => setPressedIdx(null)}
              onPointerLeave={() => setPressedIdx(null)}
              disabled={disabled || (!isDelete && digits.length >= 4)}
              style={{
                height: 72,
                fontSize: isDelete ? 22 : 24,
                fontWeight: isDelete ? 400 : 500,
                color: '#1E1E1E',
                background: isPressed ? 'rgba(0, 0, 0, 0.08)' : 'transparent',
                transition: 'background-color 0.1s ease',
                border: 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: disabled ? 0.4 : 1,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {key}
            </button>
          )
        })}
      </div>
    </div>
  )
}
