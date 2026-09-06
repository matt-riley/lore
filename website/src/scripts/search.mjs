export function searchDocs(entries, query) {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (!terms.length) return entries.slice(0, 6);
  return entries.map((entry) => {
    const title = entry.title.toLocaleLowerCase();
    const description = entry.description.toLocaleLowerCase();
    const body = entry.body.toLocaleLowerCase();
    const words = `${title} ${description} ${body}`.split(/[^\p{L}\p{N}_]+/u);
    if (!terms.every((term) => words.some((word) => word.startsWith(term)))) return null;
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 12 : 0) + (description.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { entry, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 8).map(({ entry }) => entry);
}
