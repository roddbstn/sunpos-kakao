-- get_order_status 에 배달 좌표·주소를 더한다. (2026-10-30)
--
-- ── 왜 ─────────────────────────────────────────────────────────────────────
-- 주문 완료 화면의 배달 지도는 좌표를 sessionStorage 에서 읽는다. checkout 이
-- 주문을 넣으면서 남긴 값이다. 그래서 **그 탭에서만** 산다:
--   · 새로고침은 버티지만(같은 탭)
--   · 주문 링크를 문자로 받아 다른 기기에서 열면 지도가 아예 안 뜬다
--   · 브라우저를 닫았다 열어도 마찬가지다
-- 좌표는 이미 orders 에 들어 있다(create_order_kakao 의 p_delivery_lat/lng).
-- 화면이 가져다 쓸 길만 없었다.
--
-- ── 기존 호출부가 깨지지 않는 이유 ─────────────────────────────────────────
-- 반환 TABLE 모양이 바뀌므로 CREATE OR REPLACE 가 안 된다 — drop 후 재생성한다.
-- 다만 **컬럼을 뒤에 붙이기만** 한다. 부르는 쪽 둘 다 이름으로 읽는다:
--   sunpos-kakao    app/(order)/success/page.tsx:177, 437
--   salaria-prepaid app/(order)/success/page.tsx:144, 400
-- (d?.delivery_departed_at · d?.note 처럼) 그래서 순서가 아니라 이름이 기준이고,
-- 새 컬럼을 안 읽는 쪽은 그대로 돈다.
--
-- ── 노출 범위 ──────────────────────────────────────────────────────────────
-- anon 이 부를 수 있는 함수다. 다만 order_code 는 추측할 수 없는 UUID 이고,
-- 이미 note 로 '[배달주소] …' 가 나가고 있었다. 좌표가 새로 여는 정보는 없다.
-- (account_code 처럼 QR 종이에 적혀 있는 값과는 성격이 다르다)

drop function if exists public.get_order_status(uuid);

create function public.get_order_status(p_order_code uuid)
returns table(
  status                  text,
  note                    text,
  delivery_departed_at    timestamp with time zone,
  method                  text,
  -- 여기부터 새로 붙인 것
  delivery_lat            double precision,
  delivery_lng            double precision,
  delivery_road_address   text,
  delivery_detail_address text,
  -- 매장 좌표도 여기서 준다 (2026-10-30 추가)
  store_lat               double precision,
  store_lng               double precision
)
language sql
stable
security definer
set search_path to 'public', 'extensions'
as $fn$
  select o.status::text, o.note, o.delivery_departed_at, o.method,
         o.delivery_lat, o.delivery_lng,
         o.delivery_road_address, o.delivery_detail_address,
         s.lat, s.lng
  from orders o
  left join accounts a on a.account_code = o.account_code
  left join stores   s on s.id = a.store_id
  where o.order_code = p_order_code;
$fn$;

-- 권한은 바꾸지 않는다 — 원래대로 둔다(두 QR웹이 로그인 전에도 부른다)
revoke execute on function public.get_order_status(uuid) from public;
grant  execute on function public.get_order_status(uuid) to anon, authenticated, service_role;

-- ── 매장 좌표를 뒤늦게 더한 이유 (2026-10-30) ──────────────────────────────
-- 배달 지도가 **실제 주문에서 안 떴다.** 배달 주소는 보이는데 지도만 없었다.
-- 원인은 매장 좌표를 account.storeId 로 stores 에서 따로 조회하고 있었던 것:
--   · storeId 는 세션(zustand)에 들어 있고 Account.storeId 는 optional 이다
--   · 그 값이 안 채워진 경로로 들어오면 매장 좌표가 영영 null → 지도 자체가 안 뜬다
-- 지도가 세션 상태에 좌우될 이유가 없다. 주문 하나면 양쪽 좌표를 다 알 수 있다.
