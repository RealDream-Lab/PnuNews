// The category used by the quick "publish a news item" form, which asks only for a title, a text and a cover.
export const DEFAULT_CATEGORY_NAME = 'اخبار';

// Returns { id, created }:
//  - the active category named "اخبار" when it exists;
//  - otherwise a new "اخبار" category (it is created, as the form needs one);
//  - if "اخبار" exists but an administrator switched it off, the first other active category is used (their choice is
//    respected); only when no active category is left at all is it switched back on.
export async function ensureDefaultCategory(pool) {
  const [rows] = await pool.execute('SELECT id, is_active FROM categories WHERE name = ?', [DEFAULT_CATEGORY_NAME]);
  if (rows.length) {
    if (rows[0].is_active) return { id: Number(rows[0].id), created: false };
    const [others] = await pool.execute('SELECT id FROM categories WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1');
    if (others.length) return { id: Number(others[0].id), created: false };
    await pool.execute('UPDATE categories SET is_active = 1 WHERE id = ?', [rows[0].id]);
    return { id: Number(rows[0].id), created: false };
  }
  try {
    const [result] = await pool.execute(
      'INSERT INTO categories (name, sort_order, is_active) SELECT ?, COALESCE(MAX(sort_order), 0) + 1, 1 FROM categories',
      [DEFAULT_CATEGORY_NAME],
    );
    return { id: Number(result.insertId), created: true };
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    // Someone created it a moment ago.
    const [again] = await pool.execute('SELECT id FROM categories WHERE name = ?', [DEFAULT_CATEGORY_NAME]);
    return { id: Number(again[0].id), created: false };
  }
}
