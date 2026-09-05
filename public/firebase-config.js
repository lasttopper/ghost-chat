/* Ghost Chat — Firebase configuration.
 *
 * Fill these in with your Firebase project's web app config
 * (Firebase Console → Project settings → General → Your apps → Web app)
 * and enable Email/Password + Google sign-in under Authentication →
 * Sign-in method. Then add your hosting domain(s) to Authentication →
 * Settings → Authorized domains.
 *
 * Until you do, Ghost Chat runs in Guest mode (per-browser identity,
 * no password) so local development keeps working.
 */
window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
