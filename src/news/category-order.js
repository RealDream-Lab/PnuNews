// Order of the category chips in the reader: the categories with the most published news come first;
// categories with the same count are ordered alphabetically (Persian collation), then by id for a stable result.
const collator = new Intl.Collator('fa', { sensitivity: 'base' });

export function sortCategoriesByNewsCount(categories) {
  return [...categories].sort((a, b) => (
    (Number(b.news_count) || 0) - (Number(a.news_count) || 0)
    || collator.compare(String(a.name), String(b.name))
    || Number(a.id) - Number(b.id)
  ));
}
