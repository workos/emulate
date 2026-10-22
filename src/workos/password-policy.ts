import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import zxcvbnCommonModule from '@zxcvbn-ts/language-common';
import zxcvbnEnModule from '@zxcvbn-ts/language-en';
import { type ApiErrorItem, WorkOSApiError } from '../core/index.js';

// The language packs are CommonJS (`module.exports = {…}`), which a default import receives
// as-is at run time under Node and Bun alike. Their typings describe the ESM build's `export
// default` instead, so under NodeNext the import is typed one level too deep; the cast names
// what actually arrives.
const zxcvbnCommonPackage = zxcvbnCommonModule as unknown as typeof zxcvbnCommonModule.default;
const zxcvbnEnPackage = zxcvbnEnModule as unknown as typeof zxcvbnEnModule.default;

/**
 * Production's password policy (`api-services/src/password-validator/password-validator.ts`),
 * at the settings a new environment is born with: at least 10 characters, at most 72 bytes
 * (bcrypt's limit), not containing the account's email address, and a zxcvbn score of 3 or
 * more — scored by the same library, dictionaries and keyboard graphs production configures, so
 * the same passwords pass and fail. The breached-password lookup is off by default in
 * production and needs the network, and the password-history and compromised-password checks
 * read tables the emulator has no counterpart for, so none of those run here.
 */

export const MINIMUM_PASSWORD_LENGTH = 10;
/** bcrypt ignores everything past 72 bytes, so production refuses longer passwords outright. */
export const MAXIMUM_PASSWORD_LENGTH_IN_BYTES = 72;
const MINIMUM_ZXCVBN_SCORE = 3;

zxcvbnOptions.setOptions({
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
});

/**
 * Every rule `password` breaks, as the items production puts in the `errors` array of a
 * `password_strength_error` or `password_reset_error` body, in production's order. Empty when
 * the password is acceptable. A password over the byte limit is reported for that alone, as
 * production short-circuits there before scoring.
 */
export function passwordPolicyErrors(password: string, associatedEmail?: string): ApiErrorItem[] {
  if (new TextEncoder().encode(password).byteLength > MAXIMUM_PASSWORD_LENGTH_IN_BYTES) {
    return [
      {
        code: 'password_too_long',
        message:
          'The provided password exceeds the maximum length requirements. ' +
          `Please try a password with ${MAXIMUM_PASSWORD_LENGTH_IN_BYTES} or fewer characters.`,
        maximum_length: MAXIMUM_PASSWORD_LENGTH_IN_BYTES,
      },
    ];
  }

  const errors: ApiErrorItem[] = [];
  if (associatedEmail && password.includes(associatedEmail)) {
    errors.push({
      code: 'password_contains_email',
      message:
        "The provided password contains the associated user's email address. " +
        'Passwords must not contain easily guessable user information.',
    });
  }
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    errors.push({
      code: 'password_too_short',
      message:
        'The provided password does not meet the minimum length requirements. ' +
        `Please try a password with ${MINIMUM_PASSWORD_LENGTH} or more characters.`,
      minimum_length: MINIMUM_PASSWORD_LENGTH,
    });
  }
  const { score, feedback } = zxcvbn(password);
  if (score < MINIMUM_ZXCVBN_SCORE) {
    errors.push({
      code: 'password_too_weak',
      message: 'The provided password is not strong enough. ' + feedback.warning,
      warning: feedback.warning,
      suggestions: feedback.suggestions,
    });
  }
  return errors;
}

/**
 * The 400 `POST` and `PUT /user_management/users` answer a password that breaks the policy
 * with. Returns nothing when the password is acceptable, so a caller can write `if (error)
 * throw error` beside its other checks.
 */
export function passwordStrengthError(password: string, associatedEmail?: string): WorkOSApiError | undefined {
  const errors = passwordPolicyErrors(password, associatedEmail);
  if (errors.length === 0) return undefined;
  return new WorkOSApiError(400, 'Password does not meet strength requirements.', 'password_strength_error', errors);
}
