package chat.ghost.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;

/**
 * Shared notification plumbing for the activity (in-app bridge) and the FCM
 * PushService (delivery even when the app process was killed).
 */
final class Notifications {

    static final String CHANNEL_ID = "ghost_chat_messages";

    private Notifications() {}

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Ghost Chat message notifications");
                nm.createNotificationChannel(ch);
            }
        }
    }

    /** Shows a system notification; tapping it opens the app. */
    static void show(Context ctx, String title, String body, String tag) {
        try {
            ensureChannel(ctx);
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            int id = (tag != null && !tag.isEmpty()) ? tag.hashCode() : 1;
            PendingIntent pi = PendingIntent.getActivity(ctx, id, open, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, CHANNEL_ID)
                    : new Notification.Builder(ctx);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true);

            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(id, b.build());
        } catch (Throwable ignored) {}
    }

    /** Notification with a large image preview (shared photos). Falls back to
     *  the plain notification when the picture cannot be downloaded.
     *  Must be called off the main thread (it does network I/O). */
    static void showImage(Context ctx, String title, String body, String tag, String imageUrl) {
        Bitmap bitmap = download(imageUrl);
        if (bitmap == null) { show(ctx, title, body, tag); return; }
        try {
            ensureChannel(ctx);
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            int id = (tag != null && !tag.isEmpty()) ? tag.hashCode() : 1;
            PendingIntent pi = PendingIntent.getActivity(ctx, id, open, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, CHANNEL_ID)
                    : new Notification.Builder(ctx);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setLargeIcon(bitmap)
                    .setStyle(new Notification.BigPictureStyle()
                            .bigPicture(bitmap)
                            .setSummaryText(body))
                    .setContentIntent(pi)
                    .setAutoCancel(true);

            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(id, b.build());
        } catch (Throwable ignored) {
            show(ctx, title, body, tag);
        }
    }

    /** Downloads and downsamples a remote image; null on any failure. */
    private static Bitmap download(String imageUrl) {
        if (imageUrl == null || !imageUrl.startsWith("https://")) return null;
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL(imageUrl);
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "GhostChat/2.5");
            if (conn.getResponseCode() != 200) return null;
            java.io.InputStream in = conn.getInputStream();
            try {
                byte[] raw = readAll(in);
                if (raw.length == 0 || raw.length > 12 * 1024 * 1024) return null;
                // Downsample to a notification-sized bitmap to stay well inside
                // the binder limit for notification payloads.
                BitmapFactory.Options probe = new BitmapFactory.Options();
                probe.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(raw, 0, raw.length, probe);
                int sample = 1;
                while (probe.outWidth / sample > 1024 || probe.outHeight / sample > 1024) sample *= 2;
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inSampleSize = sample;
                return BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
            } finally { in.close(); }
        } catch (Throwable t) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
