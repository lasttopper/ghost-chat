/* Ghost Chat — Firebase configuration.
 *
 * DEVELOPMENT (default, works out of the box):
 *   Runs against the local Firebase Auth EMULATOR — start it with:
 *     npm run emulators
 *   Accounts created there are temporary (cleared on emulator restart).
 *
 * PRODUCTION:
 *   1. npm i -g firebase-tools && firebase login
 *   2. firebase projects:create <your-project>  (or use an existing one)
 *   3. firebase apps:create web "Ghost Chat"     → note the appId
 *   4. firebase apps:sdkconfig web <appId>       → copy the values below
 *   5. Enable Email/Password + Google under Authentication → Sign-in method
 *   6. Add your hosting domain under Authentication → Settings →
 *      Authorized domains
 *   7. Set `emulator: false` (or remove the line).
 */
window.FIREBASE_CONFIG = {
  apiKey: 'demo-emulator-key',
  authDomain: 'localhost',
  projectId: 'demo-ghost-chat',

  // true | false | 'auto'
  // 'auto' = use the emulator only on localhost / sandbox preview hosts,
  // so production deploys never talk to an emulator by accident.
  emulator: 'auto',
};
