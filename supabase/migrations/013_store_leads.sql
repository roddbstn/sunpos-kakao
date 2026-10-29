-- ════════════════════════════════════════════════════════════════════════════
-- 손님이 알려주는 "다른 선결제 가게" 제보 (2026-10-23)
--
-- 주문 완료 화면에서 손님이 "다른 가게도 선결제하고 계세요?" 를 눌러 가게를 알려준다.
-- 선결제를 이미 쓰고 있는 가게는 선포스의 가장 좋은 후보다 — 설득할 게 아니라
-- 이미 하고 있는 일을 편하게 해주면 되니까.
--
-- ⚠️ Slack 만 받고 끝내지 않는다. 진실은 이 테이블이다 —
--    "이번 달 제보 몇 건, 그중 몇 곳이 전환됐나" 를 세려면 행이 남아야 한다.
--    (support_tickets 가 같은 이유로 같은 구조를 쓴다)
--
-- ⚠️ support_tickets 를 재사용하지 않는 이유: 그 테이블의 RLS 는 my_store_ids() 라
--    **점주만** 넣을 수 있다. 여기 넣는 건 손님이다.
--
-- 2026-10-23 검증: BEGIN…ROLLBACK 으로 전체 실행해 통과했다.
--   · sunpos_users(id) · stores(id) · accounts(account_code) FK 모두 유효
--   · stores.lat/lng 는 DB 에 실제로 있다 (lib/supabase/database.types.ts 가
--     오래돼서 없는 것처럼 보였을 뿐 — stores 블록은 이번에 다시 생성했다)
--   · match_store_leads 의 거리 계산·상호 유사도 조건 모두 실행됨
--
-- ⚠️ 2026-10-23 적용 상태 — **절반만 적용돼 있다.**
--      적용됨 : 테이블 · 인덱스 · RLS(enable + 정책 2개)
--      미적용 : notify_store_lead() · 트리거 · match_store_leads()
--               (SECURITY DEFINER 함수라 자동 적용이 막혔다)
--    그래서 지금은 **제보가 저장은 되지만 Slack 알림이 가지 않는다.**
--    이 파일은 전체가 재실행 가능하므로(IF NOT EXISTS · DROP…IF EXISTS ·
--    CREATE OR REPLACE) 통째로 다시 돌리면 남은 부분이 채워진다.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.store_leads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- 누가 알려줬나 — 카카오 로그인 상태에서만 제보할 수 있으므로 늘 채워진다
  reported_by   uuid not null references public.sunpos_users(id) on delete cascade,
  -- 어느 매장 손님인가 / 어느 거래처 소속인가 (영업 맥락: "침산점 단골이 알려준 곳")
  from_store_id uuid references public.stores(id) on delete set null,
  from_account_code uuid references public.accounts(account_code) on delete set null,

  -- 제보된 가게
  store_name    text not null,
  /** 카카오 장소 ID — 검색으로 고른 경우만. 직접 입력이면 null */
  place_id      text,
  road_address  text,
  phone         text,
  lat           double precision,
  lng           double precision,
  memo          text,

  /**
   * "그 가게가 선포스를 시작하면 알려드려요" 약속.
   *
   * 이 약속이 제보할 이유의 전부다 — 끄면 제보자에게 돌아가는 게 없다.
   * 기본은 받겠다(true), 원치 않으면 모달에서 끌 수 있다.
   */
  notify_consent boolean not null default true,
  notified_at    timestamptz,
  /** 나중에 그 가게가 실제로 가입하면 연결 — 사람이 확인하고 잇는다(아래 주석) */
  matched_store_id uuid references public.stores(id) on delete set null,

  status text not null default '접수'
    check (status in ('접수', '확인중', '연락함', '전환', '해당없음'))
);

-- 같은 사람이 같은 가게를 반복 제보하는 걸 막는다.
-- 이름 기준인 이유: place_id 는 직접 입력이면 null 이라 유니크 키로 못 쓴다.
create unique index if not exists store_leads_once_per_user
  on public.store_leads (reported_by, lower(btrim(store_name)));

create index if not exists store_leads_created_idx on public.store_leads (created_at desc);
create index if not exists store_leads_status_idx  on public.store_leads (status) where status = '접수';
-- 신규 매장이 생겼을 때 "근처에 이런 제보가 있었다" 를 찾기 위한 좌표 인덱스
create index if not exists store_leads_geo_idx on public.store_leads (lat, lng)
  where lat is not null and lng is not null;


-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.store_leads enable row level security;

-- 손님은 **자기 이름으로 넣는 것만** 할 수 있다. 읽기는 주지 않는다 —
-- 다른 사람이 어느 가게를 제보했는지는 영업 정보지 손님이 볼 것이 아니다.
drop policy if exists store_leads_insert_self on public.store_leads;
create policy store_leads_insert_self on public.store_leads
  for insert to authenticated
  with check (reported_by = (select auth.uid()));

-- 자기가 넣은 건 확인할 수 있다 (모달에서 "이미 알려주셨어요" 를 띄우려면 필요)
drop policy if exists store_leads_select_self on public.store_leads;
create policy store_leads_select_self on public.store_leads
  for select to authenticated
  using (reported_by = (select auth.uid()));


-- ── Slack 알림 ───────────────────────────────────────────────────────────────
-- support_tickets 의 notify_support_ticket 과 같은 구조.
-- 알림이 실패해도 INSERT 는 반드시 성공해야 한다 (진실은 DB, Slack 은 채널).
create or replace function public.notify_store_lead()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_from_store text;
  v_reporter   text;
  v_url text := 'https://fcaoakdlbecamoyeqyha.supabase.co/functions/v1/store-lead-slack';
  -- anon 키는 공개 키(클라이언트 번들에도 들어간다)
  v_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjYW9ha2RsYmVjYW1veWVxeWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMTY1OTYsImV4cCI6MjA5Njc5MjU5Nn0.FlHwYKyddPR_ufi-vCOBFWzgSKE-_xsgGjypV6JVLpY';
begin
  select name into v_from_store from stores where id = new.from_store_id;
  select coalesce(nullif(btrim(nickname), ''), '이름없음') into v_reporter
    from sunpos_users where id = new.reported_by;

  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_key
                 ),
      body    := jsonb_build_object(
                   'record', to_jsonb(new),
                   'fromStoreName', coalesce(v_from_store, '(알 수 없음)'),
                   'reporterName',  coalesce(v_reporter, '(알 수 없음)')
                 )
    );
  exception when others then
    raise warning 'notify_store_lead 실패(무시): %', sqlerrm;
  end;

  return new;
end;
$fn$;

drop trigger if exists store_leads_notify_slack on public.store_leads;
create trigger store_leads_notify_slack
  after insert on public.store_leads
  for each row execute function public.notify_store_lead();


-- ── 신규 매장 ↔ 제보 후보 찾기 ───────────────────────────────────────────────
/**
 * 새 매장이 생겼을 때 "이 제보와 같은 곳인가?" 후보를 뽑는다.
 *
 * ⚠️ 자동으로 잇지 않는다. 제보는 손님이 기억나는 대로 적은 상호라
 *    ('행복카페' vs '행복카페 북구점' vs '행복까페') 기계가 같은 곳인지 판정할 수 없다.
 *    틀리게 이으면 **엉뚱한 사람에게 "알려드린 가게가 시작했어요" 문자가 간다** —
 *    약속을 지키려다 신뢰를 깨는 쪽이 더 나쁘다. 후보만 내고 사람이 확인한다.
 *
 * 좌표가 있는 제보는 거리로, 없는 제보는 상호 유사도로 거른다.
 */
create or replace function public.match_store_leads(p_store_id uuid, p_radius_m int default 500)
returns table (
  lead_id      uuid,
  store_name   text,
  road_address text,
  distance_m   int,
  reported_at  timestamptz,
  reporter     text
)
language sql
security definer
set search_path to 'public', 'extensions'
as $fn$
  with s as (select name, lat, lng from stores where id = p_store_id)
  select l.id, l.store_name, l.road_address,
         case when l.lat is not null and s.lat is not null
              then round(
                     6371000 * acos(greatest(-1, least(1,
                       cos(radians(s.lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(s.lng))
                     + sin(radians(s.lat)) * sin(radians(l.lat))
                     )))
                   )::int
         end,
         l.created_at,
         coalesce(u.nickname, '이름없음')
    from store_leads l
    cross join s
    left join sunpos_users u on u.id = l.reported_by
   where l.matched_store_id is null
     and l.status in ('접수', '확인중')
     and (
       -- 좌표가 둘 다 있으면 반경 안
       (l.lat is not null and s.lat is not null
        and 6371000 * acos(greatest(-1, least(1,
              cos(radians(s.lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(s.lng))
            + sin(radians(s.lat)) * sin(radians(l.lat))
            ))) <= p_radius_m)
       -- 좌표가 없으면 상호가 서로를 품는지
       or (l.lat is null and (s.name ilike '%' || btrim(l.store_name) || '%'
                           or btrim(l.store_name) ilike '%' || s.name || '%'))
     )
   order by 4 nulls last, l.created_at;
$fn$;

revoke execute on function public.match_store_leads(uuid, int) from public, anon, authenticated;

comment on table public.store_leads is
  '손님이 알려준 "다른 선결제 가게" 제보. 그 가게가 선포스를 시작하면 제보자에게 알려주기로 약속했다(notify_consent).';
