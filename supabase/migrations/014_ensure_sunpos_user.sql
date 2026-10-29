-- 주소 저장이 외래키로 터지던 것. (2026-10-29)
--
-- ── 증상 ───────────────────────────────────────────────────────────────────
--   insert or update on table "sunpos_user_address" violates foreign key
--   constraint "sunpos_user_address_user_id_fkey"
-- (실제 테이블명은 복수형 sunpos_user_addresses 다 — 오류 메시지가 축약돼 보인다)
--
-- 최초 등록 때 배달주소 하단모달에서 '확인'을 누르면 100% 실패했다.
--
-- ── 원인 ───────────────────────────────────────────────────────────────────
-- sunpos_user_addresses.user_id → sunpos_users(id) 를 참조한다.
-- 그런데 sunpos_users 행을 만드는 건 클라이언트의 upsertSunposUser() 하나뿐이고,
-- 그걸 부르는 곳이 **app/(order)/page.tsx 한 군데**다.
--
-- 실제 등록 경로는 그 페이지를 지나지 않는다:
--     QR → PIN → /menu → 카카오 로그인 → 콜백이 /menu 로 복귀
--       → SelfRegisterSheet(하단모달)에서 주소 입력 → 여기서 터진다
-- 콜백은 `next`(대개 /menu)로 돌아가도록 되어 있고, /menu 는 upsertSunposUser 를
-- 부르지 않는다. 그래서 프로필 행이 영원히 안 생긴다.
--
-- 측정(2026-10-29): auth.users 9명 중 **7명이 sunpos_users 행이 없었다.**
-- 그 7명은 전원 주소를 저장할 수 없는 상태였다.
--
-- auth.users 의 트리거(trg_on_auth_user_created → handle_new_user)는
-- clients(점주 계정)만 만든다 — sunpos_users 와 무관하다.
--
-- ── 왜 이렇게 고치나 ───────────────────────────────────────────────────────
-- "클라이언트 어느 화면에서 프로필을 만드는가"에 의존하는 설계가 문제였다.
-- 화면을 하나 더 고쳐도 다음 진입 경로가 생기면 같은 버그가 다시 난다.
-- 그래서 **DB 안에서 보장한다** — 주소를 넣기 직전에 프로필이 없으면 만든다.
--
-- auth.users.raw_user_meta_data 에서 직접 읽는다. 폴백 순서는 클라이언트의
-- lib/auth.ts getSessionUser() 와 **글자 그대로 같게** 맞췄다. 둘이 다르면
-- 같은 사람의 닉네임이 경로에 따라 달라진다.
--
-- auth.users 에 트리거를 더 달지 않은 이유: 그게 실패하면 **가입 자체가 막힌다.**
-- 주소를 넣는 자리에서 보장하면 실패해도 그 요청만 실패한다.

-- ── 1. 프로필 보장 헬퍼 ────────────────────────────────────────────────────
-- sunpos_users 를 참조하는 곳이 또 생기면(현재 sunpos_user_addresses ·
-- store_leads.reported_by) 그 함수 맨 앞에서 이걸 부르면 된다.
create or replace function public.ensure_sunpos_user()
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_meta jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  -- 이미 있으면 메타데이터를 읽지 않고 바로 끝낸다(흔한 경우)
  if exists (select 1 from sunpos_users where id = v_uid) then
    return v_uid;
  end if;

  select u.raw_user_meta_data into v_meta from auth.users u where u.id = v_uid;

  -- 폴백은 lib/auth.ts getSessionUser() 와 같은 순서다:
  --   kakao_id : provider_id → sub → auth uid
  --   nickname : name → full_name → user_name → '이름 없음'
  -- kakao_id·nickname 이 NOT NULL 이라 폴백이 반드시 있어야 한다.
  insert into sunpos_users (id, kakao_id, nickname, profile_image, updated_at)
  values (
    v_uid,
    coalesce(v_meta->>'provider_id', v_meta->>'sub', v_uid::text),
    coalesce(v_meta->>'name', v_meta->>'full_name', v_meta->>'user_name', '이름 없음'),
    coalesce(v_meta->>'avatar_url', v_meta->>'picture'),
    now()
  )
  on conflict (id) do nothing;   -- 동시에 두 번 들어와도 괜찮다

  return v_uid;
end;
$fn$;

revoke execute on function public.ensure_sunpos_user() from public, anon;
grant  execute on function public.ensure_sunpos_user() to authenticated, service_role;

-- ── 2. 주소 저장이 그걸 거치게 한다 ────────────────────────────────────────
-- 시그니처·반환 모양은 그대로 둔다(클라이언트 upsertSunposAddress 가 그대로 쓴다).
-- 바뀐 건 맨 앞 한 줄이다: auth.uid() null 검사 → ensure_sunpos_user().
create or replace function public.upsert_sunpos_user_address(
  p_road_address text,
  p_detail_address text,
  p_lat double precision,
  p_lng double precision,
  p_confirm_delete_oldest boolean DEFAULT false
)
returns table(id uuid, needs_confirmation boolean, oldest_address text)
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_uid uuid;
  v_count int;
  v_oldest_address text;
  v_new_id uuid;
begin
  -- 로그인 확인 + 프로필 보장을 한 번에. 로그인 안 했으면 여기서 예외가 난다.
  v_uid := ensure_sunpos_user();

  if coalesce(trim(p_road_address), '') = '' then
    raise exception '도로명 주소가 비어있습니다.';
  end if;

  select count(*) into v_count from sunpos_user_addresses where user_id = v_uid;

  if v_count >= 10 and not p_confirm_delete_oldest then
    select sa.road_address into v_oldest_address
    from sunpos_user_addresses sa
    where sa.user_id = v_uid
    order by sa.created_at asc
    limit 1;
    return query select null::uuid, true, v_oldest_address;
    return;
  end if;

  if v_count >= 10 and p_confirm_delete_oldest then
    delete from sunpos_user_addresses sua
    where sua.id = (
      select sa.id from sunpos_user_addresses sa
      where sa.user_id = v_uid
      order by sa.created_at asc
      limit 1
    );
  end if;

  insert into sunpos_user_addresses (user_id, road_address, detail_address, lat, lng)
  values (v_uid, trim(p_road_address), nullif(trim(coalesce(p_detail_address, '')), ''), p_lat, p_lng)
  returning sunpos_user_addresses.id into v_new_id;

  return query select v_new_id, false, null::text;
end;
$fn$;

-- ── 3. 백필은 하지 않는다 ──────────────────────────────────────────────────
-- 처음엔 "프로필 없는 auth.users 를 다 메우자"고 돌렸다가 **되돌렸다.**
--
-- auth.users 에는 카카오 손님만 있는 게 아니다. 측정(2026-10-29, 총 9명):
--     email 7명  ← 전원 clients 행이 있는 **점주 계정**
--     phone 1명
--     kakao 1명  ← 유일한 실제 카카오 손님. 프로필이 이미 있었다
-- 즉 프로필이 없던 8명은 애초에 이 QR웹을 쓰지 않는 사람들이고, 메워주면
-- sunpos_users 에 '이름 없음' 행만 쌓인다(실제로 7개 만들고 지웠다).
--
-- 이 버그의 피해자는 **앞으로 들어올 카카오 손님**이다. 그 사람들은 위 1·2번이
-- 처리한다 — 주소를 넣는 순간 프로필이 생긴다. 백필할 대상이 없다.
--
-- ⚠️ 나중에 비슷한 걸 돌릴 일이 생기면 `auth.users` 전체가 아니라
--    `raw_app_meta_data->>'provider' = 'kakao'` 로 좁힐 것.
