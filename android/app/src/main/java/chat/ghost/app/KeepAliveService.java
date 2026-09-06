package chat.ghost.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground service that keeps a non-dismissable "active" notification in the
 * notification center. Android aggressively freezes or kills background apps;
 * a foreground service raises this process's priority so the chat socket stays
 * connected and messages arrive instantly even with the app backgrounded.
 *
 * This complements (not replaces) FCM push: if the process is still reclaimed,
 * PushService delivers messages via push. Stopped when the user signs out.
 */
public class KeepAliveService extends Service {

    public static final String CHANNEL_ID = "ghost_chat_keepalive";
    private static final int NOTIF_ID = 1001;

    public static void start(Context ctx) {
        try {
            Intent intent = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
            else ctx.startService(intent);
        } catch (Throwable ignored) {
            // Android 12+ may refuse a background start; it will start the next
            // time the app is opened (or the web layer calls startKeepAlive).
        }
    }

    public static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, KeepAliveService.class)); } catch (Throwable ignored) {}
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Stay connected", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows that Ghost Chat is listening for new messages.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = b
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("Ghost Chat is active")
                .setContentText("Listening for new messages")
                .setContentIntent(pi)
                .setOngoing(true)      // non-dismissable
                .setOnlyAlertOnce(true)
                .setPriority(Notification.PRIORITY_LOW)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, notification);
            }
        } catch (Throwable t) {
            stopSelf();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
