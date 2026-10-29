-- ════════════════════════════════════════════════════════════════════════════
-- 배달 주소를 **골라서** 쓸 수 있게 (2026-10-23)
--
-- 지금 문제: 설정 화면의 '현재 배달 주소' 는 `order by created_at asc` 의 첫 줄,
-- 즉 **가장 먼저 넣은 주소**다. 고를 방법이 없다. 사무실을 옮겼거나 주소를 여러 개
-- 등록한 사람은 새 주소를 넣어도 옛 주소가 계속 '현재' 로 남는다.
--
-- created_at 을 건드려 순서를 바꾸는 방법은 쓰지 않는다 —
-- 그 컬럼은 "언제 만들었나" 라는 뜻이고, 10개 한도에서 "가장 오래된 걸 지운다" 는
-- 규칙도 그 값을 믿고 돈다. 뜻이 다른 두 가지를 한 컬럼에 겹치면 나중에 반드시 꼬인다.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.sunpos_user_addresses
  add column if not exists is_default boolean not null default false;

-- 한 사람에게 기본 주소는 하나뿐. 부분 인덱스라 false 는 몇 개든 괜찮다.
create unique index if not exists sunpos_user_addresses_one_default
  on public.sunpos_user_addresses (user_id)
  where is_default;

-- 기존 사용자 보정 — 지금까지 '현재' 로 보이던 것(가장 오래된 주소)을 그대로 기본으로.
-- 이 줄이 없으면 업데이트 직후 모두의 '현재 배달 주소' 배지가 사라진다.
with first_addr as (
  select distinct on (user_id) id
    from public.sunpos_user_addresses
   order by user_id, created_at asc
)
update public.sunpos_user_addresses a
   set is_default = true
  from first_addr f
 where a.id = f.id
   and not exists (
     select 1 from public.sunpos_user_addresses b
      where b.user_id = a.user_id and b.is_default
   );


-- ── 기본 주소 지정 RPC ───────────────────────────────────────────────────────
--
-- 왜 함수인가: "남의 것 끄고 내 것 켜기" 를 **한 트랜잭션**으로 묶어야 한다.
-- 클라이언트에서 UPDATE 두 번으로 하면 사이에서 끊겼을 때 기본 주소가 0개가 되거나
-- (유니크 인덱스 때문에) 2개를 만들려다 실패한다.
create or replace function public.set_default_address(p_address_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요해요';
  end if;

  -- 내 주소가 맞는지 먼저 본다. 남의 주소 id 를 넣어도 아무 일도 일어나지 않아야 한다.
  if not exists (
    select 1 from sunpos_user_addresses
     where id = p_address_id and user_id = v_uid
  ) then
    raise exception '내 주소가 아니에요';
  end if;

  -- 유니크 인덱스(한 명당 기본 하나)에 걸리지 않도록 **끄고 나서 켠다**
  update sunpos_user_addresses
     set is_default = false
   where user_id = v_uid and is_default and id <> p_address_id;

  update sunpos_user_addresses
     set is_default = true
   where id = p_address_id;
end;
$fn$;

-- 손님(카카오 로그인)이 부르는 함수다 — authenticated 에게만 연다.
-- anon 은 auth.uid() 가 null 이라 위에서 막히지만, 권한 자체를 주지 않는 게 기준이다
-- (sallaria-pos/supabase/migrations/0012 의 함수 권한 규칙과 같은 모양).
revoke execute on function public.set_default_address(uuid) from public, anon;
grant  execute on function public.set_default_address(uuid) to authenticated;

comment on function public.set_default_address(uuid) is
  '배달 주소 하나를 기본으로 지정. 내 주소인지 확인하고, 끄고-켜기를 한 트랜잭션으로 묶는다.';


-- ════════════════════════════════════════════════════════════════════════════
-- 적용 후 확인
-- ════════════════════════════════════════════════════════════════════════════
-- -- 사람마다 기본 주소가 정확히 하나여야 한다 (주소가 하나도 없는 사람은 0)
-- select user_id, count(*) filter (where is_default) as 기본주소수, count(*) as 전체
--   from public.sunpos_user_addresses group by user_id order by 2 desc;
