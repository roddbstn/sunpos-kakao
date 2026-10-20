export default function ProgressBar({ step, total = 4 }: { step: number; total?: number }) {
  const pct = Math.min(100, Math.round((step / total) * 100))
  return (
    <div style={{ height: 3, background: '#E8E8E8', borderRadius: 99, overflow: 'hidden' }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: '#C49A6B',
          borderRadius: 99,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  )
}
