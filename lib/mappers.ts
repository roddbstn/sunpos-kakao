import type { Menu, MenuOptionGroup } from './types'
import type { Tables } from './supabase/database.types'

// Supabase 중첩 쿼리 결과 타입 (menus + menu_option_groups + option_groups + option_items)
type DbOptionItem = Pick<
  Tables<'option_items'>,
  'id' | 'name' | 'extra_price' | 'is_sold_out' | 'is_hidden' | 'display_order'
>

type DbOptionGroup = Pick<
  Tables<'option_groups'>,
  'id' | 'name' | 'is_required' | 'is_multi' | 'is_sold_out' | 'is_hidden'
> & {
  option_items: DbOptionItem[]
}

type DbMenuOptionGroupLink = {
  display_order: number
  option_groups: DbOptionGroup | null
}

export type DbMenuRow = Pick<
  Tables<'menus'>,
  | 'id' | 'category_id' | 'name' | 'description' | 'base_price' | 'image_url'
  | 'is_popular' | 'is_recommended' | 'is_new' | 'is_sold_out' | 'is_hidden'
> & {
  menu_option_groups: DbMenuOptionGroupLink[]
}

// DB row → Menu 타입 변환 (menu/page.tsx, menu/[code]/menu-detail-client.tsx 공용)
export function mapDbMenu(row: DbMenuRow): Menu {
  // option_groups가 null인 링크는 FK 오류 상황 — 방어적으로 제외
  const options: MenuOptionGroup[] = (row.menu_option_groups ?? [])
    .sort((a, b) => a.display_order - b.display_order)
    .filter((mog): mog is DbMenuOptionGroupLink & { option_groups: DbOptionGroup } =>
      mog.option_groups !== null && !mog.option_groups.is_hidden
    )
    .map((mog) => {
      const og = mog.option_groups
      return {
        group:     og.name,
        required:  og.is_required,
        multi:     og.is_multi,
        isSoldOut: og.is_sold_out ?? false,
        items: (og.option_items ?? [])
          .filter((it) => !it.is_hidden)
          .sort((a, b) => a.display_order - b.display_order)
          .map((it) => ({
            id:        it.id,
            name:      it.name,
            plus:      it.extra_price,
            isSoldOut: it.is_sold_out,
          })),
      }
    })

  return {
    code:        row.id,
    cat:         row.category_id,
    name:        row.name,
    desc:        row.description ?? '',
    price:       row.base_price,
    emoji:       '🍽️',
    imageUrl:    row.image_url ?? undefined,
    popular:     row.is_popular     ?? false,
    recommended: row.is_recommended ?? false,
    isNew:       row.is_new         ?? false,
    isSoldOut:   row.is_sold_out,
    isHidden:    row.is_hidden,
    options,
  }
}
