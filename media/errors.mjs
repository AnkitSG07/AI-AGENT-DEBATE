export class MediaError extends Error {
  constructor(code, message, statusCode = 409, details = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export function requireValue(condition, code, message, statusCode = 409) {
  if (!condition) throw new MediaError(code, message, statusCode);
}

export function identifier(value, label = 'identifier', max = 220) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_INPUT', `Invalid ${label}.`, 400);
  return value;
}
