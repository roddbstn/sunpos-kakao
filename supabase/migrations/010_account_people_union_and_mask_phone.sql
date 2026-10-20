-- 설정 화면의 '관리자 · 이용자' 목록이 항상 0명으로 나오던 걸 고친다.
--
-- 원인: account_people 이 account_members 만 봤다. 그 테이블은 신규 거래처 INSERT
-- 트리거로만 채워지므로, 이미 있던 거래처는 전부 비어 있었다. 정작 사람은
-- accounts.contact_person(관리자)과 user_account_links(실제 로그인한 사람)에 있었다.
--
-- 그리고 전화번호 가림이 fail-open 이었다. 정규식이 '01012345678' 만 가정했는데
-- 저장된 값은 '010-1234-5678' 이라 **안 맞으면 원본이 그대로 나갔다.**
-- mask_phone 은 숫자만 뽑아 가리고, 가릴 수 없는 모양이면 빈 값을 준다.

create or replace function public.mask_phone(p_phone text)
returns text
language sql
immutable
set search_path to 'public', 'extensions'
as $fn$
  select case
    when length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 7
    then substr(regexp_replace(p_phone, '[^0-9]', '', 'g'), 1, 3) || '-****-' ||
         right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 4)
    else ''
  end
$fn$;

revoke execute on function public.mask_phone(text) from public;
revoke execute on function public.mask_phone(text) from anon;
grant  execute on function public.mask_phone(text) to postgres, authenticated, service_role;

create or replace function public.account_people(p_account_code uuid)
returns table(name text, phone text, role text, is_me boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_uid uuid := auth.uid();
  v_acc accounts;
begin
  if v_uid is null then
    raise exception '로그인이 필요해요';
  end if;

  select * into v_acc from accounts where account_code = p_account_code and is_active;
  if v_acc is null then
    raise exception '사용할 수 없는 계정이에요';
  end if;

  if not exists (
    select 1 from user_account_links
     where account_code = p_account_code and user_id = v_uid and status = 'approved'
  ) then
    raise exception '권한이 없어요';
  end if;

  -- 사람은 세 군데에 흩어져 있다. 이름으로 합치고, 전화번호는 널이 아닌 쪽을 남긴다.
  return query
  with raw as (
    select btrim(v_acc.contact_person) as nm,
           nullif(btrim(coalesce(v_acc.contact_phone, '')), '') as ph,
           null::uuid as uid
    where coalesce(btrim(v_acc.contact_person), '') <> ''

    union all
    select btrim(coalesce(u.nickname, '')),
           nullif(btrim(coalesce(u.phone, '')), ''),
           u.id
    from user_account_links l
    join sunpos_users u on u.id = l.user_id
    where l.account_code = p_account_code
      and l.status = 'approved'
      and coalesce(btrim(u.nickname), '') <> ''

    union all
    select btrim(m.name),
           nullif(btrim(coalesce(m.phone, '')), ''),
           null::uuid
    from account_members m
    where m.account_code = p_account_code
      and coalesce(btrim(m.name), '') <> ''
  ),
  merged as (
    select r.nm,
           (array_remove(array_agg(r.ph), null))[1] as ph,
           bool_or(r.uid = v_uid)                   as me
    from raw r
    group by r.nm
  )
  select
    g.nm,
    case
      when g.nm = btrim(coalesce(v_acc.contact_person, '')) then g.ph   -- 관리자 연락처는 공개
      when g.me                                             then g.ph   -- 내 번호는 내가 본다
      else mask_phone(g.ph)
    end,
    case when g.nm = btrim(coalesce(v_acc.contact_person, '')) then '관리자' else '이용자' end,
    coalesce(g.me, false)
  from merged g
  order by (g.nm = btrim(coalesce(v_acc.contact_person, ''))) desc, g.nm;
end
$fn$;

revoke execute on function public.account_people(uuid) from public;
revoke execute on function public.account_people(uuid) from anon;
grant  execute on function public.account_people(uuid) to postgres, authenticated, service_role;
