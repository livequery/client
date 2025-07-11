import { ErrorName } from '../enums';

export class BaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class LivequeryError extends BaseError {
  constructor(message: string) {
    super(message);
    this.name = ErrorName.LivequeryError;
  }
}

export class MutateError extends BaseError {
  constructor(message: string) {
    super(message);
    this.name = ErrorName.MutateError;
  }
}

export class QueryError extends BaseError {
  constructor(message: string) {
    super(message);
    this.name = ErrorName.QueryError;
  }
}

export class WatchError extends BaseError {
  constructor(message: string) {
    super(message);
    this.name = ErrorName.WatchError;
  }
}
