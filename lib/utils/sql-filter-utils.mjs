export function addStringFilter(where, params, col, value, transform = (v) => v) {
  if (typeof value === "string" && value.trim().length > 0) {
    where.push(`${col} = ?`);
    params.push(transform(value.trim()));
  }
}
