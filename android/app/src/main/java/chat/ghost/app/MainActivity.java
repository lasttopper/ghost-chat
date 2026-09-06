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

    private WebView webView;
    private ScreenshotObserver screenshotObserver;
    private volatile boolean resumed = false;
    private long lastScreenshotAt = 0L;
    private final Handler main = new Handler(Looper.getMainLooper());

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
        if (webView != null) { webView.destroy(); webView = null; }
        super.onDestroy();
    }

    /* --------------------------- JS bridge (window.AndroidBridge) --------------------------- */

    private final class NativeBridge {
        @JavascriptInterface
        public boolean isNative() { return true; }

        @JavascriptInterface
        public String getAppVersion() { return "2.0.0"; }

        /** Called by the page instead of the Web Notification API while in the APK. */
        @JavascriptInterface
        public void showNotification(String title, String body, String tag) {
            showNativeNotification(title, body, tag);
        }
    }
}
