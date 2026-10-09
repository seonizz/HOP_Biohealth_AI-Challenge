export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    throw new HttpError(422, 'INVALID_INPUT', '입력 형식을 확인해 주세요.');
  }
  return value;
}

export function string(value, max = 8000, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new HttpError(422, 'INVALID_INPUT', '입력 길이와 내용을 확인해 주세요.');
  }
  return value;
}
