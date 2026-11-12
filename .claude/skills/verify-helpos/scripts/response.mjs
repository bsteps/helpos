export function responseBody(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { shown: text, json: {} };
  }
  return {
    shown: JSON.stringify(value, null, 2),
    json: value !== null && typeof value === "object" ? value : {},
  };
}
