// Domain failures contain stable codes, not HTTP status or UI prose.
export class ApplicationError extends Error{
  constructor(code,options){super(code,options);this.code=code;}
}

// A classified temporary observation failure, never permission to replay a write.
export class TransientReadError extends ApplicationError {}
