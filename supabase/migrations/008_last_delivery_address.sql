-- 거래처별 "현재 배달받는 곳" — 이 로그인 유저가 이 거래처에서 가장 최근에 배달 주문한 주소.
-- sunpos-kakao 메뉴 화면 상단에 보여주기 위함 (menu/page.tsx).
CREATE OR REPLACE FUNCTION get_last_delivery_address(p_account_code uuid)
RETURNS TABLE(road_address text, detail_address text)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT delivery_road_address, delivery_detail_address
  FROM orders
  WHERE ordered_by_user_id = auth.uid()
    AND account_code = p_account_code
    AND delivery_road_address IS NOT NULL
    AND is_deleted IS NOT TRUE
  ORDER BY ordered_at DESC
  LIMIT 1;
$$;
