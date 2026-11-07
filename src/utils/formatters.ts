// src/utils/formatters.ts

/**
 * Safely converts any unknown value (including API error objects like {code, msg}) 
 * into a safe string renderable by React.
 */
export function safeText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => safeText(item)).join(', ');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, any>;
    // Handle Binance error structures or common message fields
    if (obj.msg) return String(obj.msg);
    if (obj.message) return String(obj.message);
    if (obj.error) return safeText(obj.error);
    try {
      return JSON.stringify(obj);
    } catch {
      return '[Complex Object]';
    }
  }
  return String(value);
}

export function safeNum(val: unknown, fallback = 0): number {
  const num = Number(val);
  return isNaN(num) ? fallback : num;
}