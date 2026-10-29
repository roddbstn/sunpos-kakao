// store_leads 에 제보가 들어오면 Slack 으로 알린다.
//
// 구조는 support-ticket-slack 과 같다:
//   · 진실은 DB(store_leads). Slack 은 알림 채널일 뿐 저장소가 아니다 —
//     Slack 만 받으면 "이번 달 제보 몇 건, 몇 곳이 전환됐나" 를 셀 수 없다.
//   · Slack 이 거절하면 **2xx 가 아닌 상태로** 돌려준다. 200 에 {ok:false} 만 담으면
//     트리거가 본문을 안 보므로 제보가 조용히 사라진다.
//
// 웹훅은 운영 알림과 같은 채널(OPS_ALERT_WEBHOOK_URL)을 쓰되,
// STORE_LEAD_WEBHOOK_URL 이 있으면 그쪽을 먼저 본다 — 영업 제보는 장애 알림과
// 성격이 달라서 채널을 나누고 싶어질 수 있다.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

interface Lead {
  id:            string
  store_name:    string
  place_id:      string | null
  road_address:  string | null
  phone:         string | null
  memo:          string | null
  notify_consent: boolean
  created_at:    string
}

Deno.serve(async (req: Request) => {
  const webhook =
    Deno.env.get('STORE_LEAD_WEBHOOK_URL') ??
    Deno.env.get('SLACK_WEBHOOK_URL') ??
    Deno.env.get('OPS_ALERT_WEBHOOK_URL')

  if (!webhook) {
    return new Response(JSON.stringify({ error: '웹훅 URL 미설정' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: { record?: Lead; fromStoreName?: string; reporterName?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 })
  }

  const l = body.record
  if (!l) return new Response(JSON.stringify({ error: 'no record' }), { status: 400 })

  const lines: string[] = [
    `*\u{1F4CD} 선결제 가게 제보 — ${l.store_name}*`,
    `${body.fromStoreName ?? '?'} 손님 *${body.reporterName ?? '?'}* 님이 알려줬어요`,
    '',
  ]

  if (l.road_address) lines.push(`주소  ${l.road_address}`)
  if (l.phone)        lines.push(`연락처  ${l.phone}`)
  // 검색으로 고른 건 좌표가 있어 신규 매장과 자동 대조가 쉽다. 직접 입력은 사람이 찾아야 한다.
  lines.push(l.place_id ? `출처  카카오 장소검색 (id ${l.place_id})` : '출처  *직접 입력* — 지도에 없는 가게')

  if (l.memo) lines.push('', '*남긴 말*', '>>> ' + l.memo)

  lines.push(
    '',
    l.notify_consent
      ? '\u{1F514} 이 가게가 선포스를 시작하면 *제보자에게 알려주기로 약속*했어요.'
      : '알림은 원하지 않으셨어요.',
    '',
    `_제보 \`${l.id.slice(0, 8)}\`_`,
  )

  let ok = false
  let detail = ''
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    })
    ok = res.ok
    if (!res.ok) detail = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`
  } catch (e) {
    detail = `fetch 실패: ${(e as Error).message}`
  }

  if (!ok) {
    console.error('Slack 전송 실패', { lead: l.id, detail })
    return new Response(JSON.stringify({ ok: false, lead: l.id, slack: detail }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
