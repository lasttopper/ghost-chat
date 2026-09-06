package chat.ghost.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
}
