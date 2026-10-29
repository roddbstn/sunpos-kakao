-- ⚠️ 적용하지 않았다 (2026-10-29). 만들어서 검증까지 했다가 **되돌렸다.**
--
-- 사용자 판단: "그냥 주문취소는 일단 빼자. 너무 기능이 많다. 이거는 일반소비자가
-- 아니라 일단 선결제 해놓은 사람들인 거잖아."
-- 익명 소비자용 취소 흐름이 필요한 자리가 아니다 — 거래처 손님은 매장과 관계가
-- 있어서 전화 한 통이 더 빠르고, 기능이 늘면 그만큼 설명할 것도 늘어난다.
--
-- 쓰지 않는 SECURITY DEFINER 함수를 DB 에 남겨두지 않는다 — 나중에 누가
-- "이미 있는 함수네" 하고 가져다 쓴다(이 프로젝트에서 실제로 그래서 뷰 세 개를
-- 지웠다). 그래서 함수도 drop 했다. 필요해지면 **이 파일을 그대로 돌리면 된다.**
--
-- 검증은 끝나 있다(롤백 트랜잭션, 2026-10-29):
--     anon            → 42501 permission denied
--     남의 주문        → '주문을 찾을 수 없어요.' (존재 여부를 알려주지 않는다)
--     본인 '주문완료'  → 성공, 전액 환원(295,700 → 319,800), note 에 [손님취소] 덧붙음
--     '조리중'        → '이미 접수된 주문은 취소할 수 없어요.'
--     이미 '취소'      → '이미 취소된 주문이에요.'
--
-- ── 아래는 그때 만든 것 그대로 ──────────────────────────────────────────────

-- 손님이 **접수 전까지** 자기 주문을 취소할 수 있게. (2026-10-29)
--
-- ── 왜 새 함수인가 ─────────────────────────────────────────────────────────
-- cancel_order 는 점주 전용이다. 2026-10-28 에 소유권 확인(my_store_ids)을 넣고
-- anon·PUBLIC 에서 EXECUTE 를 회수했다 — 그 전엔 order_code 만 알면 누구나 남의
-- 주문을 취소하고 잔액을 환원시킬 수 있었다. 그 구멍을 다시 열 수는 없다.
--
-- 그래서 손님용은 **따로** 만든다. 권한의 근거가 완전히 다르다:
--     점주 : 이 주문이 내 매장 것인가        (my_store_ids)
--     손님 : 이 주문을 내가 넣었는가          (ordered_by_user_id = auth.uid())
--
-- orders.ordered_by_user_id 는 create_order_kakao 가 기록한다(확인함).
-- PIN 방식(create_order)은 기록하지 않는다 — 그쪽은 로그인이 없어서 '내 주문'을
-- 증명할 방법이 애초에 없다. 그래서 이 기능은 **카카오 QR웹 전용**이다.
--
-- ── 언제까지 취소할 수 있나 ────────────────────────────────────────────────
-- status = '주문완료' 일 때만. 점주가 접수하면 '조리중' 이 되고, 그때부터는
-- 주방이 이미 움직였으므로 손님이 일방적으로 취소하면 안 된다.
-- 화면 문구("주문이 확인되기 전까지 취소할 수 있어요")와 같은 규칙이다.
--
-- ── note 를 덮어쓰지 않는다 ────────────────────────────────────────────────
-- cancel_order 는 note 를 p_note 로 **교체**한다. 여기서 그러면 배달주소 등
-- note 에 쌓아둔 정보가 날아간다(POS 가 '[배달주소] ...' 를 파싱해서 쓴다).
-- 그래서 **뒤에 덧붙인다.** 표식을 남기는 이유는 화면이 사유를 구분해야 하기
-- 때문이다 — 표식이 없으면 손님이 직접 취소한 주문도
-- "점주가 주문을 거부했습니다" 로 보인다(실제로 그 폴백 문구가 있다).

create or replace function public.cancel_my_order(p_order_code uuid)
returns table(order_code uuid, refunded integer)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_order orders%rowtype;
  v_uid   uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_order
  from orders o
  where o.order_code = p_order_code
  for update;

  if not found then
    raise exception '주문을 찾을 수 없어요.';
  end if;

  -- 남의 주문은 '없다'고 답한다. '권한 없음'으로 답하면 order_code 가
  -- 실재하는지 알려주는 조회기가 된다(cancel_order 와 같은 규칙).
  if v_order.ordered_by_user_id is null or v_order.ordered_by_user_id <> v_uid then
    raise exception '주문을 찾을 수 없어요.';
  end if;

  if v_order.status = '취소' then
    raise exception '이미 취소된 주문이에요.';
  end if;

  -- 접수 뒤에는 못 막는다. 주방이 이미 움직였다.
  if v_order.status <> '주문완료' then
    raise exception '이미 접수된 주문은 취소할 수 없어요. 매장에 연락해 주세요.';
  end if;

  update orders
  set status     = '취소',
      -- 덧붙인다(교체하지 않는다). 표식은 화면이 사유를 구분하는 데 쓴다.
      note       = case
                     when coalesce(btrim(note), '') = '' then '[손님취소]'
                     else note || ' | [손님취소]'
                   end,
      updated_at = now()
  where orders.order_code = p_order_code;

  -- 잔액 환원 — cancel_order 와 같은 규칙(총금액 전액)
  update accounts
  set current_balance = current_balance + v_order.total_amount
  where accounts.account_code = v_order.account_code;

  return query select p_order_code, v_order.total_amount;
end;
$fn$;

-- anon 은 못 부른다 — 로그인한 사람만 '내 주문'을 증명할 수 있다.
revoke execute on function public.cancel_my_order(uuid) from public, anon;
grant  execute on function public.cancel_my_order(uuid) to authenticated, service_role;
