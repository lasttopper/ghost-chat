package chat.ghost.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.firebase.auth.AuthCredential;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.auth.GoogleAuthProvider;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ghost Chat - native Android wrapper.
 *
 * Loads the Ghost Chat PWA in a WebView and adds what a browser tab cannot:
 *   * REAL screenshot detection (a ContentObserver on MediaStore watches for a
 *     newly-added image whose name looks like a screenshot). When one is taken
 *     while the app is in the foreground we call window.__ghostOnScreenshot()
 *     in the page, which posts a "took a screenshot" notice into the chat.
 *   * Native notifications, bridged from the page via window.AndroidBridge
 *     (a WebView has no Notification UI of its own).
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://ghost-chat-5gxc.onrender.com/";
    private static final String APP_HOST = "ghost-chat-5gxc.onrender.com";
    private static final String CHANNEL_ID = "ghost_chat_messages";
    private static final int REQ_IMAGES = 1001;
    private static final int REQ_NOTIF = 1002;
    // Web OAuth client of the Firebase project (google-services.json, type 3).
    // Google ID tokens are requested for this audience so Firebase Auth (web
    // and native) end up as the SAME account.
    private static final String WEB_CLIENT_ID =
            "67898464798-kphnop5mq9rfsohagrsh1ci6m3vce0t5.apps.googleusercontent.com";

    private WebView webView;
    private ScreenshotObserver screenshotObserver;
    private volatile boolean resumed = false;
    private long lastScreenshotAt = 0L;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService authExecutor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        // Service workers (offline app shell) inside the WebView.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ServiceWorkerController swc = ServiceWorkerController.getInstance();
                swc.setServiceWorkerClient(new ServiceWorkerClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return null;
                    }
                });
            } catch (Throwable ignored) {}
        }

        // Native <-> JS bridge (exposed as window.AndroidBridge in the page).
        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url == null) return false;
                String host = url.getHost();
                if (host != null && (host.equals(APP_HOST) || host.endsWith("." + APP_HOST))) {
                    return false; // same origin -> load inside the app
                }
                // Any external link opens in the browser, not inside the chat.
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, url);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Throwable ignored) {}
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient());

        createNotificationChannel();
        requestRuntimePermissions();

        // Deep link (verified App Link, e.g. an invite link ?join=CODE): open
        // exactly that URL; otherwise load the app home.
        String deep = urlFromIntent(getIntent());
        webView.loadUrl(deep != null ? deep : START_URL);
    }

    /** The app-host URL from a VIEW intent (deep link), or null. */
    private String urlFromIntent(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null && APP_HOST.equals(data.getHost())) return data.toString();
        }
        return null;
    }

    /** A deep link tapped while the app is already open (launchMode singleTop). */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String deep = urlFromIntent(intent);
        if (deep != null && webView != null) webView.loadUrl(deep);
    }

    /* ------------------------------- permissions ------------------------------- */

    private void requestRuntimePermissions() {
        String imagesPerm = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_IMAGES
                : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (checkSelfPermission(imagesPerm) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ imagesPerm }, REQ_IMAGES);
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
        }
    }

    /* --------------------------- screenshot detection -------------------------- */

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        registerScreenshotObserver();
    }

    @Override
    protected void onPause() {
        resumed = false;
        unregisterScreenshotObserver();
        super.onPause();
    }

    private void registerScreenshotObserver() {
        if (screenshotObserver != null) return;
        screenshotObserver = new ScreenshotObserver(new Handler(Looper.getMainLooper()));
        try {
            getContentResolver().registerContentObserver(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, screenshotObserver);
        } catch (Throwable ignored) {}
    }

    private void unregisterScreenshotObserver() {
        if (screenshotObserver != null) {
            try { getContentResolver().unregisterContentObserver(screenshotObserver); } catch (Throwable ignored) {}
            screenshotObserver = null;
        }
    }

    private final class ScreenshotObserver extends ContentObserver {
        ScreenshotObserver(Handler handler) { super(handler); }
        @Override
        public void onChange(boolean selfChange, Uri uri) {
            super.onChange(selfChange, uri);
            if (isRecentScreenshot()) main.post(MainActivity.this::notifyWebOfScreenshot);
        }
    }

    /** True when the most recently added image looks like a just-taken screenshot. */
    private boolean isRecentScreenshot() {
        String[] projection = {
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_ADDED
        };
        String sort = MediaStore.Images.Media.DATE_ADDED + " DESC LIMIT 1";
        try (Cursor c = getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, null, null, sort)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                long addedSec = c.getLong(1);
                long nowSec = System.currentTimeMillis() / 1000L;
                boolean recent = (nowSec - addedSec) <= 4;
                boolean looksLikeShot = name != null && name.toLowerCase().contains("screenshot");
                return recent && looksLikeShot;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private void notifyWebOfScreenshot() {
        if (!resumed || webView == null) return;
        long now = System.currentTimeMillis();
        if (now - lastScreenshotAt < 4000) return; // debounce bursts
        lastScreenshotAt = now;
        try {
            webView.evaluateJavascript(
                    "window.__ghostOnScreenshot && window.__ghostOnScreenshot();", null);
        } catch (Throwable ignored) {}
    }

    /* ------------------------------ notifications ------------------------------ */

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Ghost Chat message notifications");
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void showNativeNotification(String title, String body, String tag) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            int id = (tag != null && !tag.isEmpty()) ? tag.hashCode() : 1;
            PendingIntent pi = PendingIntent.getActivity(this, id, open, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true);

            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(id, b.build());
        } catch (Throwable ignored) {}
    }

    /* --------------------------------- chrome ---------------------------------- */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        authExecutor.shutdownNow();
        if (webView != null) { webView.destroy(); webView = null; }
        super.onDestroy();
    }

    /* --------------------------- JS bridge (window.AndroidBridge) --------------------------- */

    private final class NativeBridge {
        @JavascriptInterface
        public boolean isNative() { return true; }

        @JavascriptInterface
        public String getAppVersion() { return "2.2.0"; }

        /** Called by the page instead of the Web Notification API while in the APK. */
        @JavascriptInterface
        public void showNotification(String title, String body, String tag) {
            showNativeNotification(title, body, tag);
        }

        /* ---------------- native Google sign-in (Firebase session) ----------------
         * Google blocks its OAuth inside embedded WebViews, so the app signs in
         * natively (Credential Manager -> Firebase Auth) and serves the page
         * real Firebase ID tokens through this bridge. Same uid/email as a web
         * Google login => one account across web and app. */

        @JavascriptInterface
        public boolean hasFirebaseSession() {
            try { return FirebaseAuth.getInstance().getCurrentUser() != null; } catch (Throwable t) { return false; }
        }

        /** JSON {uid,email,displayName} for the native session, or "" if none. */
        @JavascriptInterface
        public String getFirebaseUser() {
            try {
                FirebaseUser u = FirebaseAuth.getInstance().getCurrentUser();
                if (u == null) return "";
                JSONObject o = new JSONObject();
                o.put("uid", String.valueOf(u.getUid()));
                o.put("email", u.getEmail() == null ? "" : u.getEmail());
                o.put("displayName", u.getDisplayName() == null ? "" : u.getDisplayName());
                return o.toString();
            } catch (Throwable t) { return ""; }
        }

        /** Async: native fetches a fresh ID token, then calls window.__ghostIdToken(tok). */
        @JavascriptInterface
        public void requestFirebaseIdToken() {
            final FirebaseUser u;
            try { u = FirebaseAuth.getInstance().getCurrentUser(); } catch (Throwable t) { u = null; }
            if (u == null) { evalGhostIdToken(""); return; }
            u.getIdToken(false).addOnCompleteListener(task -> {
                String tok = "";
                try {
                    if (task.isSuccessful() && task.getResult() != null && task.getResult().getToken() != null) {
                        tok = task.getResult().getToken();
                    }
                } catch (Throwable ignored) {}
                evalGhostIdToken(tok);
            });
        }

        /** Starts the Google account picker; result -> window.__ghostGoogleAuth(json). */
        @JavascriptInterface
        public void googleSignIn() {
            runOnUiThread(() -> {
                try {
                    GetGoogleIdOption option = new GetGoogleIdOption.Builder()
                            .setServerClientId(WEB_CLIENT_ID)
                            .setFilterByAuthorizedAccounts(false)
                            .build();
                    GetCredentialRequest req = new GetCredentialRequest.Builder()
                            .addCredentialOption(option)
                            .build();
                    CredentialManager cm = CredentialManager.create(MainActivity.this);
                    cm.getCredentialAsync(MainActivity.this, req, null, authExecutor,
                            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                                @Override
                                public void onResult(GetCredentialResponse response) {
                                    handleGoogleCredential(response);
                                }
                                @Override
                                public void onError(GetCredentialException e) {
                                    String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                                    notifyGoogleAuth(null, msg);
                                }
                            });
                } catch (Throwable t) {
                    notifyGoogleAuth(null, t.getMessage() != null ? t.getMessage() : "sign-in failed");
                }
            });
        }

        @JavascriptInterface
        public void googleSignOut() {
            try { FirebaseAuth.getInstance().signOut(); } catch (Throwable ignored) {}
        }
    }

    /* --------------------- Google sign-in helpers (native side) --------------------- */

    private void handleGoogleCredential(GetCredentialResponse response) {
        try {
            Credential cred = response.getCredential();
            if (cred instanceof CustomCredential
                    && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(cred.getType())) {
                GoogleIdTokenCredential g = GoogleIdTokenCredential.createFrom(cred.getData());
                AuthCredential ac = GoogleAuthProvider.getCredential(g.getIdToken(), null);
                FirebaseAuth.getInstance().signInWithCredential(ac).addOnCompleteListener(task -> {
                    if (task.isSuccessful() && task.getResult() != null) {
                        notifyGoogleAuth(task.getResult().getUser(), null);
                    } else {
                        Exception ex = task.getException();
                        notifyGoogleAuth(null, ex != null && ex.getMessage() != null ? ex.getMessage() : "firebase sign-in failed");
                    }
                });
            } else {
                notifyGoogleAuth(null, "unsupported credential type");
            }
        } catch (Throwable t) {
            notifyGoogleAuth(null, t.getMessage() != null ? t.getMessage() : "credential parse failed");
        }
    }

    private void notifyGoogleAuth(FirebaseUser user, String error) {
        JSONObject o = new JSONObject();
        try {
            if (user != null) {
                o.put("ok", true);
                o.put("uid", String.valueOf(user.getUid()));
                o.put("email", user.getEmail() == null ? "" : user.getEmail());
                o.put("displayName", user.getDisplayName() == null ? "" : user.getDisplayName());
            } else {
                o.put("ok", false);
                o.put("error", error == null ? "sign-in failed" : error);
            }
        } catch (Throwable ignored) {}
        final String json = o.toString(); // valid JSON => safe JS literal
        runOnUiThread(() -> {
            if (webView == null) return;
            try { webView.evaluateJavascript("window.__ghostGoogleAuth && window.__ghostGoogleAuth(" + json + ");", null); } catch (Throwable ignored) {}
        });
    }

    private void evalGhostIdToken(String token) {
        // Firebase ID tokens are JWTs (base64url + dots); strip anything else
        // defensively so the value can never break out of the JS string.
        String safe = token == null ? "" : token.replaceAll("[^A-Za-z0-9._-]", "");
        runOnUiThread(() -> {
            if (webView == null) return;
            try { webView.evaluateJavascript("window.__ghostIdToken && window.__ghostIdToken('" + safe + "');", null); } catch (Throwable ignored) {}
        });
    }
}
