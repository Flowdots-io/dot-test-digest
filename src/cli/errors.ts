export const EX_USAGE = 64;
export const EX_NOINPUT = 66;
export const EX_SOFTWARE = 70;

/** An error whose message is printed as-is on stderr and whose code is the process exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EX_USAGE);
  }
}

/** A run, record, log or input file that does not exist (`EX_NOINPUT`). */
export class NoInputError extends CliError {
  constructor(message: string) {
    super(message, EX_NOINPUT);
  }
}
