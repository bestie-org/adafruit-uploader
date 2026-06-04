/**
 * Exception classes for nRF5x DFU operations.
 *
 * Ported from nordicsemi/exceptions.py
 */

export class NordicSemiException extends Error {
  constructor(message) {
    super(message);
    this.name = 'NordicSemiException';
  }
}

export class NotImplementedException extends NordicSemiException {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedException';
  }
}

export class InvalidArgumentException extends NordicSemiException {
  constructor(message) {
    super(message);
    this.name = 'InvalidArgumentException';
  }
}

export class MissingArgumentException extends NordicSemiException {
  constructor(message) {
    super(message);
    this.name = 'MissingArgumentException';
  }
}

export class IllegalStateException extends NordicSemiException {
  constructor(message) {
    super(message);
    this.name = 'IllegalStateException';
  }
}
